import type { LegacyDialect } from "../types";
import { Ctx } from "./context";
import { Block, columnPath, findClause, parseQuery, splitConjuncts } from "./query";
import { Group, Node, Token, isGroup, isOp, isToken, isWord, normalize, splitTopLevel, textOf, tpl } from "./tokens";

/**
 * Oracle hierarchical queries (START WITH / CONNECT BY PRIOR) as recursive CTEs.
 *
 * Supported: one table, one PRIOR equality, extra non-PRIOR conditions, LEVEL, ORDER SIBLINGS BY one ascending
 * expression, and the CONNECT BY LEVEL <= n row generator. Anything else is reported and left alone.
 */

const nameOf = (token: Token) => (token.value ?? token.text).toLowerCase();

const hasWord = (nodes: Node[], name: string): boolean => nodes.some((node) => (isGroup(node) ? hasWord(node.items, name) : isWord(node, name)));

/** The query as a replacement for the whole block, or undefined if the block isn't a hierarchical query. */
export function convertConnectBy(block: Block, ctx: Ctx, dialect: LegacyDialect): Node[] | undefined {
    const connect = findClause(block, "CONNECT BY");
    if (!connect) return undefined;

    const select = findClause(block, "SELECT");
    const from = findClause(block, "FROM");
    const where = findClause(block, "WHERE");
    const start = findClause(block, "START WITH");
    const siblings = findClause(block, "ORDER SIBLINGS BY");
    const orderBy = findClause(block, "ORDER BY");
    const construct = textOf([...connect.head, ...connect.body]);

    const fail = (reason: string, hint?: string) => {
        ctx.unsupported(construct, reason, hint ?? "Write the hierarchy as WITH RECURSIVE by hand.");
        return undefined;
    };

    if (!select) return undefined;
    if (block.clauses.some((clause) => !["SELECT", "FROM", "WHERE", "START WITH", "CONNECT BY", "ORDER BY", "ORDER SIBLINGS BY"].includes(clause.name))) return fail("The hierarchical query also uses GROUP BY, HAVING or another clause");
    if (isWord(connect.body[0], "NOCYCLE")) return fail("NOCYCLE has no direct equivalent", "PostgreSQL 14+ can detect cycles with the CYCLE clause of WITH RECURSIVE.");
    if (hasWord(connect.body, "PRIOR") === false) return convertGenerator(block, ctx);

    if (!from) return fail("A hierarchical query without a FROM clause");
    const tables = splitTopLevel(from.body);
    if (tables.length !== 1 || isGroup(tables[0][0])) return fail("The hierarchical query joins several tables or reads from a subquery");

    // table and alias
    const path = takePath(tables[0]);
    if (!path) return fail("The FROM item isn't a plain table");
    const tableNodes = tables[0].slice(0, path.length);
    let aliasRest = tables[0].slice(path.length);
    if (isWord(aliasRest[0], "AS")) aliasRest = aliasRest.slice(1);
    const aliasToken = aliasRest.length === 1 && isToken(aliasRest[0]) ? (aliasRest[0] as Token) : undefined;
    if (aliasRest.length > 1) return fail("The FROM item isn't a plain table");
    const tableName = nameOf(path.parts[path.parts.length - 1]);
    const alias = aliasToken ? nameOf(aliasToken) : tableName;
    const cteName = `${tableName.replace(/[^a-z0-9_]/g, "_")}_hierarchy`;

    // CONNECT BY PRIOR parent = child
    const conjuncts = splitConjuncts(connect.body);
    const priorConjuncts = conjuncts.filter((conjunct) => hasWord(conjunct, "PRIOR"));
    if (priorConjuncts.length !== 1) return fail("The CONNECT BY condition has more than one PRIOR");
    const link = parseLink(priorConjuncts[0]);
    if (!link) return fail("The PRIOR condition isn't a simple column = column comparison");
    const extra = conjuncts.filter((conjunct) => conjunct !== priorConjuncts[0]);
    if (extra.some((conjunct) => hasWord(conjunct, "LEVEL"))) return fail("A LEVEL condition inside CONNECT BY");

    // PRIOR in the select list, or pseudo-columns we can't carry
    if (hasWord(select.body, "PRIOR") || hasWord(select.body, "CONNECT_BY_ISLEAF") || hasWord(select.body, "CONNECT_BY_ISCYCLE")) return fail("The select list uses PRIOR or CONNECT_BY_ISLEAF");

    // ORDER SIBLINGS BY one ascending expression
    let siblingExpr: Node[] | undefined;
    if (siblings) {
        const parts = splitTopLevel(siblings.body);
        const expr = parts[0];
        if (parts.length !== 1 || expr.length === 0 || isWord(expr[expr.length - 1], "DESC")) return fail("ORDER SIBLINGS BY with several columns or DESC");
        siblingExpr = isWord(expr[expr.length - 1], "ASC") ? expr.slice(0, -1) : expr;
    }

    const normalizedAlias = normalize([aliasToken ?? path.parts[path.parts.length - 1]]);
    const qualifier = textOf(normalizedAlias);
    const table = textOf(tableNodes);
    const aliasText = aliasToken ? ` ${textOf([aliasToken])}` : "";

    const startCondition = start ? start.body : undefined;
    // in the recursive part a bare column means the child row, and both the table and the CTE have it
    const qualified = (nodes: Node[]) => qualifyColumns(nodes, qualifier);
    const extraOn = extra.length > 0 ? tpl` AND ${normalize(qualified(extra.flatMap((conjunct, index) => (index === 0 ? conjunct : [...tpl`AND`, ...conjunct]))))}` : [];

    const sortFirst = siblingExpr ? tpl`, ARRAY[${normalize(siblingExpr)}] AS sort_path` : [];
    const sortNext = siblingExpr ? tpl`, ${cteName}.sort_path || ${normalize(qualified(siblingExpr))}` : [];

    const anchor = tpl`SELECT ${qualifier}.*, 1 AS level${sortFirst} FROM ${table}${aliasText}${startCondition ? tpl` WHERE ${normalize(startCondition)}` : []}`;
    const recursive = tpl`SELECT ${qualifier}.*, ${cteName}.level + 1${sortNext} FROM ${table}${aliasText} JOIN ${cteName} ON ${cteName}.${link.parent} = ${qualifier}.${link.child}${extraOn}`;

    const outerFrom = tpl`FROM ${cteName} ${aliasToken ? textOf([aliasToken]) : ""}`;
    const nl = /\n/.test(print(select.body));
    const outer: Node[] = [...tpl`SELECT`, ...normalize(select.body), ...outerFrom];
    if (where) outer.push(...tpl`WHERE`, ...normalize(where.body));
    if (siblingExpr) outer.push(...tpl`ORDER BY sort_path`);
    else if (orderBy) outer.push(...tpl`ORDER BY`, ...normalize(orderBy.body));
    void nl;

    const cte: Group = { kind: "group", open: { kind: "punct", text: "(" }, close: { kind: "punct", text: ")" }, items: [...anchor, ...tpl`UNION ALL`, ...recursive] };
    const out: Node[] = [...tpl`WITH RECURSIVE ${cteName} AS`, cte, ...outer];

    ctx.apply("connect-by", construct, "WITH RECURSIVE …");
    ctx.trap({
        id: "connect-by-cycles",
        severity: "check",
        title: "A cycle in the data will make the recursive query run on",
        explanation: "Oracle stops with an error when the parent/child data loops back on itself. A recursive CTE keeps going until it runs out of memory or time. Check for cycles first, or add a depth limit (WHERE level < 50) in the recursive part.",
    });
    if (!siblingExpr && !orderBy) {
        ctx.trap({
            id: "connect-by-order",
            severity: "check",
            title: "Row order differs from CONNECT BY",
            explanation: "CONNECT BY returns rows depth-first (each parent followed by its children). A recursive CTE returns them level by level. Add an ORDER BY if the order matters.",
        });
    }
    void dialect;
    void parseQuery;
    return out;
}

const NOT_COLUMNS = new Set(["AND", "OR", "NOT", "NULL", "IS", "IN", "LIKE", "BETWEEN", "CASE", "WHEN", "THEN", "ELSE", "END", "TRUE", "FALSE", "EXISTS", "ANY", "ALL", "SOME", "DISTINCT", "AS", "ASC", "DESC", "INTERVAL", "DATE", "TIMESTAMP", "CURRENT_TIMESTAMP", "CURRENT_DATE", "LEVEL", "PRIOR"]);

/** Puts `qualifier.` in front of bare column names (not keywords, functions, literals or already-qualified names). */
function qualifyColumns(nodes: Node[], qualifier: string): Node[] {
    const out: Node[] = [];
    nodes.forEach((node, index) => {
        if (isGroup(node)) {
            out.push(isWord(node.items[0], "SELECT") ? node : { ...node, items: qualifyColumns(node.items, qualifier) });
            return;
        }
        const previous = nodes[index - 1];
        const next = nodes[index + 1];
        const isName = (node.kind === "word" || node.kind === "ident") && !(node.kind === "word" && NOT_COLUMNS.has(node.text.toUpperCase()));
        const dotted = (isToken(previous) && previous.text === ".") || (isToken(next) && next.text === ".");
        if (isName && !dotted && !isGroup(next) && !(isToken(previous) && previous.kind === "word" && /^(INTERVAL|DATE|TIMESTAMP)$/i.test(previous.text))) {
            out.push(...tpl`${qualifier}.${node.text}`.map((token, i) => (i === 0 ? { ...token, ws: node.ws } : token)));
            return;
        }
        out.push(node);
    });
    return out;
}

function print(nodes: Node[]): string {
    return textOf(nodes);
}

function takePath(nodes: Node[]): { parts: Token[]; length: number } | undefined {
    const parts: Token[] = [];
    let i = 0;
    while (i < nodes.length && isToken(nodes[i]) && ((nodes[i] as Token).kind === "word" || (nodes[i] as Token).kind === "ident")) {
        parts.push(nodes[i] as Token);
        i++;
        if (isToken(nodes[i]) && (nodes[i] as Token).text === "." && i + 1 < nodes.length) i++;
        else break;
    }
    if (parts.length === 0) return undefined;
    return { parts, length: i };
}

/** `PRIOR a.id = a.parent_id` (either order) as the parent and child column names. */
function parseLink(conjunct: Node[]): { parent: string; child: string } | undefined {
    const equals = conjunct.findIndex((node) => isOp(node, "="));
    if (equals < 0) return undefined;
    const left = conjunct.slice(0, equals);
    const right = conjunct.slice(equals + 1);
    const priorLeft = isWord(left[0], "PRIOR");
    const priorRight = isWord(right[0], "PRIOR");
    if (priorLeft === priorRight) return undefined;
    const parentPath = columnPath(priorLeft ? left.slice(1) : right.slice(1));
    const childPath = columnPath(priorLeft ? right : left);
    if (!parentPath || !childPath) return undefined;
    return { parent: textOf([parentPath[parentPath.length - 1]]), child: textOf([childPath[childPath.length - 1]]) };
}

/** SELECT LEVEL FROM DUAL CONNECT BY LEVEL <= n: a row generator. */
function convertGenerator(block: Block, ctx: Ctx): Node[] | undefined {
    const connect = findClause(block, "CONNECT BY");
    const select = findClause(block, "SELECT");
    if (!connect || !select) return undefined;
    const body = connect.body;
    const construct = textOf([...connect.head, ...body]);
    if (!(body.length === 3 && isWord(body[0], "LEVEL") && isOp(body[1], "<=", "<") && isToken(body[2]) && (body[2] as Token).kind === "number")) {
        ctx.unsupported(construct, "CONNECT BY without PRIOR is only converted for the form CONNECT BY LEVEL <= n", "Use generate_series() for row generators.");
        return undefined;
    }
    if (findClause(block, "FROM")) {
        ctx.unsupported(construct, "A CONNECT BY LEVEL row generator combined with other tables");
        return undefined;
    }
    const limit = Number((body[2] as Token).text) - (isOp(body[1], "<") ? 1 : 0);
    const others = block.clauses.filter((clause) => !["SELECT", "CONNECT BY"].includes(clause.name));
    const tail = others.flatMap((clause) => [...clause.head, ...clause.body]);
    const out = [...tpl`SELECT`, ...normalize(select.body), ...tpl`FROM generate_series(1, ${String(limit)}) AS level`, ...tail];
    ctx.apply("connect-by", construct, `generate_series(1, ${limit})`);
    return out;
}
