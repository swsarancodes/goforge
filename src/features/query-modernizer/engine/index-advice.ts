import type { IndexRecommendation, SchemaContext } from "../types";
import { Block, findClause, parseQuery, splitConjuncts } from "./query";
import { Group, Node, Token, buildTree, isGroup, isOp, isPunct, isToken, isWord, textOf, tokenize } from "./tokens";

/**
 * Index suggestions from what the query actually filters and joins on, checked against the tables and indexes the
 * user has. No numbers about speed-ups: there are none to give without running the query on real data.
 */

interface TableRef {
    table: string;
    alias: string;
}

interface Predicate {
    ref: TableRef;
    column: string;
    kind: "equality" | "range";
    /** The other table, for a join condition. */
    joinedTo?: TableRef;
}

export interface IndexAdvice {
    recommendations: IndexRecommendation[];
    /** Conditions the database can't use an index for, with the way to write them instead. */
    notes: string[];
}

const SARGABLE_BREAKERS = new Set(["EXTRACT", "DATE_TRUNC", "UPPER", "LOWER", "TO_CHAR", "CAST", "COALESCE", "LEFT", "RIGHT", "SUBSTRING", "SUBSTR", "TRIM", "LENGTH", "ROUND", "TRUNC"]);

const nameOf = (token: Token) => (token.value ?? token.text).toLowerCase();

export function adviseIndexes(postgresSql: string, schema: SchemaContext | undefined): IndexAdvice {
    const advice: IndexAdvice = { recommendations: [], notes: [] };
    if (!schema || schema.tables.length === 0) return advice;

    let tree: Node[];
    try {
        tree = buildTree(tokenize(postgresSql, "db2"));
    } catch {
        return advice;
    }

    const predicates: Predicate[] = [];
    const visit = (list: Node[]) => {
        const parts = parseQuery(list, "db2");
        if (parts) for (const block of parts.blocks) analyseBlock(block, schema, predicates, advice);
        for (const node of list) if (isGroup(node)) visit(node.items);
    };
    visit(tree);

    // group by table
    const byTable = new Map<string, { ref: TableRef; equality: string[]; range: string[]; joins: string[] }>();
    for (const predicate of predicates) {
        const key = predicate.ref.table;
        const entry = byTable.get(key) ?? { ref: predicate.ref, equality: [], range: [], joins: [] };
        const bucket = predicate.joinedTo ? entry.joins : predicate.kind === "equality" ? entry.equality : entry.range;
        if (!bucket.includes(predicate.column)) bucket.push(predicate.column);
        byTable.set(key, entry);
    }

    const seen = new Set<string>();
    for (const [table, entry] of byTable) {
        const known = schema.tables.find((candidate) => candidate.name.toLowerCase() === table);
        if (!known) continue;
        const existing = [...(known.indexes ?? []), known.columns.filter((c) => c.isPrimary).map((c) => c.name)].filter((cols) => cols.length > 0).map((cols) => cols.map((c) => c.toLowerCase()));
        const isCovered = (columns: string[]) => existing.some((index) => index[0] === columns[0]);
        const isKey = (columns: string[]) => columns.length === 1 && known.columns.some((c) => c.name.toLowerCase() === columns[0] && (c.isPrimary || c.isUnique));

        const suggest = (columns: string[], reason: string) => {
            const unique = [...new Set(columns)].slice(0, 3);
            if (unique.length === 0 || isCovered(unique) || isKey(unique)) return;
            const name = `idx_${known.name}_${unique.join("_")}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
            if (seen.has(name)) return;
            seen.add(name);
            advice.recommendations.push({ id: name, tableName: known.name, columns: unique, name, reason, ddl: `CREATE INDEX ${name} ON ${known.name} (${unique.join(", ")});` });
        };

        const filterColumns = [...entry.equality, ...entry.range.slice(0, 1)];
        if (filterColumns.length > 0) {
            const parts: string[] = [];
            if (entry.equality.length > 0) parts.push(`${entry.equality.join(", ")} compared with =`);
            if (entry.range.length > 0) parts.push(`${entry.range[0]} compared with a range, LIKE or BETWEEN`);
            suggest(filterColumns, `The query filters ${known.name} on ${parts.join(" and ")}, and no index starts with ${filterColumns[0]}.`);
        }
        for (const column of entry.joins) suggest([column], `${known.name}.${column} is used to join to another table, and no index starts with it.`);
    }
    return advice;
}

function analyseBlock(block: Block, schema: SchemaContext, predicates: Predicate[], advice: IndexAdvice) {
    const from = findClause(block, "FROM");
    if (!from) return;
    const refs = tableRefs(from.body, schema);
    if (refs.length === 0) return;

    const conditions: Node[][] = [];
    const where = findClause(block, "WHERE");
    if (where) conditions.push(...splitConjuncts(where.body));
    // ON conditions: the nodes after each ON up to the next join keyword
    const body = from.body;
    for (let i = 0; i < body.length; i++) {
        if (!isWord(body[i], "ON")) continue;
        let j = i + 1;
        const on: Node[] = [];
        while (j < body.length && !isWord(body[j], "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL") && !isPunct(body[j], ",")) on.push(body[j++]);
        conditions.push(...splitConjuncts(on));
    }

    for (const condition of conditions) {
        const [left, operator, ...rest] = splitCondition(condition);
        if (!operator) continue;
        const leftRef = resolveColumn(left, refs, schema);
        const rightRef = resolveColumn(rest, refs, schema);
        const symbol = isToken(operator) ? operator.text.toUpperCase() : "";
        const kind: Predicate["kind"] | undefined = symbol === "=" || symbol === "IN" ? "equality" : ["<", ">", "<=", ">=", "BETWEEN", "LIKE"].includes(symbol) ? "range" : undefined;
        if (!kind) continue;

        if (leftRef && rightRef && symbol === "=") {
            predicates.push({ ref: leftRef.ref, column: leftRef.column, kind: "equality", joinedTo: rightRef.ref });
            predicates.push({ ref: rightRef.ref, column: rightRef.column, kind: "equality", joinedTo: leftRef.ref });
            continue;
        }
        if (leftRef && !startsWithWildcard(rest, symbol)) predicates.push({ ref: leftRef.ref, column: leftRef.column, kind });
        else if (!leftRef) {
            const wrapped = wrappedColumn(left, refs, schema);
            if (wrapped) advice.notes.push(`${textOf(left)} ${symbol} … applies ${wrapped.fn} to ${wrapped.ref.table}.${wrapped.column}, so an index on that column can't be used. Compare the bare column with a range instead.`);
        }
    }
}

const splitCondition = (condition: Node[]): [Node[], Node | undefined, ...Node[]] => {
    const index = condition.findIndex((node) => (isOp(node) && ["=", "<", ">", "<=", ">=", "<>", "!="].includes((node as Token).text)) || isWord(node, "BETWEEN", "LIKE", "IN"));
    if (index <= 0) return [condition, undefined];
    return [condition.slice(0, index), condition[index], ...condition.slice(index + 1)];
};

const startsWithWildcard = (rest: Node[], symbol: string) => symbol === "LIKE" && isToken(rest[0]) && rest[0].kind === "string" && /^[%_]/.test(rest[0].value ?? "");

/** The tables in a FROM clause, with their aliases. */
function tableRefs(body: Node[], schema: SchemaContext): TableRef[] {
    const refs: TableRef[] = [];
    let i = 0;
    const known = new Set(schema.tables.map((table) => table.name.toLowerCase()));
    while (i < body.length) {
        const node = body[i];
        const startsTable = i === 0 || isPunct(body[i - 1], ",") || isWord(body[i - 1], "JOIN");
        if (startsTable && isToken(node) && (node.kind === "word" || node.kind === "ident") && !isGroup(body[i + 1]) && !isWord(node, "LATERAL", "ONLY", "SELECT")) {
            let last = node;
            let j = i + 1;
            while (isPunct(body[j], ".") && isToken(body[j + 1])) {
                last = body[j + 1] as Token;
                j += 2;
            }
            const table = nameOf(last);
            let alias = table;
            let next = body[j];
            if (isWord(next, "AS")) {
                j++;
                next = body[j];
            }
            if (isToken(next) && (next.kind === "word" || next.kind === "ident") && !isWord(next, "ON", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "USING", "WHERE")) alias = nameOf(next);
            if (known.has(table)) refs.push({ table, alias });
            i = j;
            continue;
        }
        i++;
    }
    return refs;
}

/** `alias.column` or a bare `column` that belongs to exactly one of the tables. */
function resolveColumn(nodes: Node[], refs: TableRef[], schema: SchemaContext): { ref: TableRef; column: string } | undefined {
    if (nodes.length === 3 && isToken(nodes[0]) && isPunct(nodes[1], ".") && isToken(nodes[2])) {
        const ref = refs.find((candidate) => candidate.alias === nameOf(nodes[0] as Token));
        const column = nameOf(nodes[2] as Token);
        const table = ref && schema.tables.find((candidate) => candidate.name.toLowerCase() === ref.table);
        return ref && table?.columns.some((c) => c.name.toLowerCase() === column) ? { ref, column } : undefined;
    }
    if (nodes.length === 1 && isToken(nodes[0]) && (nodes[0].kind === "word" || nodes[0].kind === "ident")) {
        const column = nameOf(nodes[0]);
        const owners = refs.filter((ref) => schema.tables.find((table) => table.name.toLowerCase() === ref.table)?.columns.some((c) => c.name.toLowerCase() === column));
        return owners.length === 1 ? { ref: owners[0], column } : undefined;
    }
    return undefined;
}

/** `EXTRACT(YEAR FROM t.col)`, `UPPER(col)` ...: a column wrapped in a function. */
function wrappedColumn(nodes: Node[], refs: TableRef[], schema: SchemaContext): { fn: string; ref: TableRef; column: string } | undefined {
    const first = nodes[0];
    if (!isToken(first) || first.kind !== "word" || !SARGABLE_BREAKERS.has(first.text.toUpperCase()) || !isGroup(nodes[1])) return undefined;
    const group = nodes[1] as Group;
    for (const part of group.items) {
        const resolved = resolveColumn([part], refs, schema);
        if (resolved) return { fn: first.text.toUpperCase(), ...resolved };
    }
    // qualified: alias.col inside
    for (let i = 0; i + 2 < group.items.length; i++) {
        const resolved = resolveColumn(group.items.slice(i, i + 3), refs, schema);
        if (resolved) return { fn: first.text.toUpperCase(), ...resolved };
    }
    return undefined;
}
