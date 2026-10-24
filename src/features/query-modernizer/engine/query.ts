import type { LegacyDialect } from "../types";
import { Ctx } from "./context";
import { Group, Node, Token, group, isGroup, isOp, isPunct, isToken, isWord, normalize, paren, print, splitTopLevel, textOf, tpl, upper, word } from "./tokens";

/**
 * Statement structure: a query is split into its clauses (SELECT, FROM, WHERE, ...) at the top level of its token
 * list, so a rule can change one clause without touching how the rest is written. Set operations (UNION, MINUS, ...)
 * separate blocks.
 */

export interface Clause {
    name: string;
    head: Token[];
    body: Node[];
}

export interface Block {
    clauses: Clause[];
    /** Wrap the block in brackets when it is printed (a LIMIT inside one arm of a UNION needs them). */
    parens?: boolean;
}

export interface QueryParts {
    blocks: Block[];
    /** Set operator tokens between block i and block i + 1. */
    connectors: Token[][];
    /** Anything before the first clause (should be nothing). */
    prefix: Node[];
}

const CLAUSE_ORDER = ["WITH", "SELECT", "INTO", "FROM", "WHERE", "START WITH", "CONNECT BY", "GROUP BY", "HAVING", "ORDER BY", "ORDER SIBLINGS BY", "LIMIT", "OFFSET", "FETCH", "FOR", "OPTION"];
const SET_OPERATORS = new Set(["UNION", "INTERSECT", "EXCEPT", "MINUS"]);

interface ClauseStart {
    name: string;
    length: number;
    setOperator?: boolean;
}

function clauseStartAt(items: Node[], index: number, dialect: LegacyDialect): ClauseStart | undefined {
    const node = items[index];
    if (!isToken(node) || node.kind !== "word") return undefined;
    const name = node.text.toUpperCase();
    const next = upper(items[index + 1]);
    switch (name) {
        case "WITH":
            return index === 0 ? { name: "WITH", length: 1 } : undefined;
        case "SELECT":
        case "FROM":
        case "WHERE":
        case "HAVING":
        case "LIMIT":
        case "OFFSET":
        case "FETCH":
        case "INTO":
            return { name, length: 1 };
        case "OPTION":
            return dialect === "mssql" && isGroup(items[index + 1]) ? { name, length: 1 } : undefined;
        case "GROUP":
            return next === "BY" ? { name: "GROUP BY", length: 2 } : undefined;
        case "ORDER":
            if (next === "BY") return { name: "ORDER BY", length: 2 };
            if (next === "SIBLINGS" && upper(items[index + 2]) === "BY") return { name: "ORDER SIBLINGS BY", length: 3 };
            return undefined;
        case "START":
            return next === "WITH" ? { name: "START WITH", length: 2 } : undefined;
        case "CONNECT":
            return next === "BY" ? { name: "CONNECT BY", length: 2 } : undefined;
        case "FOR":
            return ["UPDATE", "SHARE", "XML", "JSON", "READ"].includes(next) ? { name: "FOR", length: 1 } : undefined;
        default:
            if (SET_OPERATORS.has(name)) {
                const modifier = ["ALL", "DISTINCT"].includes(next) ? 1 : 0;
                return { name, length: 1 + modifier, setOperator: true };
            }
            return undefined;
    }
}

export function parseQuery(items: Node[], dialect: LegacyDialect): QueryParts | undefined {
    const blocks: Block[] = [];
    const connectors: Token[][] = [];
    let current: Block | undefined;
    let clause: Clause | undefined;
    const prefix: Node[] = [];

    let i = 0;
    while (i < items.length) {
        const start = clauseStartAt(items, i, dialect);
        if (start?.setOperator) {
            connectors.push(items.slice(i, i + start.length) as Token[]);
            current = undefined;
            clause = undefined;
            i += start.length;
            continue;
        }
        if (start && !(start.name === "INTO" && !current?.clauses.some((candidate) => candidate.name === "SELECT"))) {
            if (!current) {
                current = { clauses: [] };
                blocks.push(current);
            }
            clause = { name: start.name, head: items.slice(i, i + start.length) as Token[], body: [] };
            current.clauses.push(clause);
            i += start.length;
            continue;
        }
        if (clause) clause.body.push(items[i]);
        else prefix.push(items[i]);
        i++;
    }

    if (blocks.length === 0 || prefix.length > 0 || !blocks[0].clauses.some((candidate) => candidate.name === "SELECT")) return undefined;
    if (connectors.length !== blocks.length - 1) return undefined;
    return { blocks, connectors, prefix };
}

export function assemble(parts: QueryParts): Node[] {
    const out: Node[] = [];
    parts.blocks.forEach((block, index) => {
        if (index > 0) out.push(...parts.connectors[index - 1]);
        const nodes = block.clauses.flatMap((clause) => [...clause.head, ...clause.body]);
        if (block.parens) {
            const first = nodes[0];
            const ws = isToken(first) ? first.ws : undefined;
            out.push({ ...group(nodes.map((node, i) => (i === 0 ? withWs(node, "") : node))), open: { kind: "punct", text: "(", ws } });
        } else out.push(...nodes);
    });
    return out;
}

const withWs = (node: Node, ws: string | undefined): Node => (isGroup(node) ? { ...node, open: { ...node.open, ws } } : { ...node, ws });

export const findClause = (block: Block, name: string): Clause | undefined => block.clauses.find((clause) => clause.name === name);

export function removeClause(block: Block, name: string) {
    block.clauses = block.clauses.filter((clause) => clause.name !== name);
}

/** Adds a clause in the position PostgreSQL expects, using the line style of the clauses already there. */
export function addClause(block: Block, name: string, body: Node[]) {
    const lines = block.clauses.some((clause) => /\n/.test(clause.head[0]?.ws ?? ""));
    const clause: Clause = { name, head: name.split(" ").map((text, index) => ({ kind: "word", text, ws: index === 0 ? (lines ? "\n" : " ") : " " }) as Token), body: body.map((node, index) => (index === 0 ? withWs(node, " ") : node)) };
    const rank = CLAUSE_ORDER.indexOf(name);
    let at = block.clauses.length;
    for (let i = 0; i < block.clauses.length; i++) {
        if (CLAUSE_ORDER.indexOf(block.clauses[i].name) > rank) {
            at = i;
            break;
        }
    }
    block.clauses.splice(at, 0, clause);
}

// ---- helpers on clause bodies ---------------------------------------------------------------------------------------

/** Splits a condition on top-level AND (an AND that belongs to BETWEEN or a CASE is not a separator). */
export function splitConjuncts(nodes: Node[]): Node[][] {
    const parts: Node[][] = [[]];
    let between = 0;
    let caseDepth = 0;
    for (const node of nodes) {
        if (isWord(node, "CASE")) caseDepth++;
        else if (isWord(node, "END") && caseDepth > 0) caseDepth--;
        else if (isWord(node, "BETWEEN") && caseDepth === 0) between++;
        else if (isWord(node, "AND") && caseDepth === 0) {
            if (between > 0) between--;
            else {
                parts.push([]);
                continue;
            }
        }
        parts[parts.length - 1].push(node);
    }
    return parts.filter((part) => part.length > 0);
}

export function joinConjuncts(parts: Node[][]): Node[] {
    const out: Node[] = [];
    parts.forEach((part, index) => {
        const normalized = normalize(part);
        if (index > 0) out.push(...tpl`AND`);
        out.push(...normalized);
    });
    return out;
}

/** A column reference such as `e.dept_id` or `dept_id`, as name parts. */
export function columnPath(nodes: Node[]): Token[] | undefined {
    const parts: Token[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (i % 2 === 0) {
            if (!isToken(node) || (node.kind !== "word" && node.kind !== "ident")) return undefined;
            parts.push(node);
        } else if (!isPunct(node, ".")) return undefined;
    }
    return parts.length > 0 && nodes.length % 2 === 1 ? parts : undefined;
}

const nameOf = (token: Token) => (token.value ?? token.text).toLowerCase();

// ---- rules on blocks -----------------------------------------------------------------------------------------------

/** MINUS is EXCEPT. */
export function renameMinus(parts: QueryParts, ctx: Ctx) {
    parts.connectors.forEach((connector, index) => {
        if (connector[0].text.toUpperCase() === "MINUS") {
            ctx.apply("minus", "MINUS", "EXCEPT");
            parts.connectors[index] = [{ ...connector[0], text: "EXCEPT" }, ...connector.slice(1)];
        }
    });
}

/** SELECT TOP n ... becomes LIMIT n at the end. */
export function convertTop(block: Block, ctx: Ctx, multiBlock: boolean) {
    const select = findClause(block, "SELECT");
    if (!select) return;
    const body = select.body;
    let i = 0;
    while (isWord(body[i], "DISTINCT", "ALL")) i++;
    if (!isWord(body[i], "TOP")) return;
    const topIndex = i;
    const countNode = body[i + 1];
    if (!countNode || !(isGroup(countNode) || (isToken(countNode) && (countNode.kind === "number" || countNode.kind === "param")))) {
        ctx.unsupported(textOf(body.slice(i, i + 3)), "TOP is followed by something other than a number, a bracketed value or a variable");
        return;
    }
    let end = i + 2;
    let percent = false;
    let ties = false;
    if (isWord(body[end], "PERCENT")) {
        percent = true;
        end++;
    }
    if (isWord(body[end], "WITH") && isWord(body[end + 1], "TIES")) {
        ties = true;
        end += 2;
    }
    if (percent) {
        ctx.unsupported(textOf(body.slice(topIndex, end)), "TOP … PERCENT has no PostgreSQL equivalent", "Compute the row count first (SELECT count(*) …) or use ntile() / percent_rank().");
        return;
    }
    const countText = textOf([countNode]);
    const countValue: Node[] = isGroup(countNode) ? (countNode.items.length === 1 ? countNode.items : [countNode]) : [countNode];
    const top = textOf(body.slice(topIndex, end));
    const rest = [...body.slice(0, topIndex), ...body.slice(end)];
    if (rest[topIndex] && isToken(rest[topIndex])) rest[topIndex] = { ...(rest[topIndex] as Token), ws: (body[topIndex] as Token).ws };
    select.body = rest;

    if (ties) addClause(block, "FETCH", tpl`FIRST ${countValue} ROWS WITH TIES`);
    else addClause(block, "LIMIT", countValue);
    if (multiBlock) block.parens = true;
    ctx.apply("top", top, ties ? `FETCH FIRST ${countText} ROWS WITH TIES` : `LIMIT ${countText}`);
}

const DUAL_NAMES = [["DUAL"], ["SYS", "DUAL"], ["SYSIBM", "SYSDUMMY1"], ["SYSIBM", "DUAL"]];

export function removeDual(block: Block, ctx: Ctx) {
    const from = findClause(block, "FROM");
    if (!from) return;
    const path = columnPath(from.body);
    if (!path) return;
    const names = path.map((part) => part.text.toUpperCase());
    if (!DUAL_NAMES.some((candidate) => candidate.length === names.length && candidate.every((part, index) => part === names[index]))) return;
    removeClause(block, "FROM");
    ctx.apply("dual", `FROM ${textOf(from.body)}`, "");
}

/** MySQL LIMIT offset, count */
export function convertMysqlLimit(block: Block, ctx: Ctx) {
    const limit = findClause(block, "LIMIT");
    if (!limit) return;
    const parts = splitTopLevel(limit.body);
    if (parts.length !== 2) return;
    const before = `LIMIT ${textOf(limit.body)}`;
    limit.body = [withWs(normalize(parts[1])[0], " "), ...normalize(parts[1]).slice(1)];
    addClause(block, "OFFSET", normalize(parts[0]));
    ctx.apply("limit-offset", before, `LIMIT ${textOf(limit.body)} OFFSET ${textOf(parts[0])}`);
}

const LOCK_HINT = /^(NOLOCK|READUNCOMMITTED)$/i;

/** Table hints and index hints in the FROM clause. */
export function removeFromHints(block: Block, ctx: Ctx) {
    const from = findClause(block, "FROM");
    if (!from) return;
    const out: Node[] = [];
    const body = from.body;
    for (let i = 0; i < body.length; i++) {
        const node = body[i];
        // SQL Server: WITH (NOLOCK, INDEX(ix)) and the older (NOLOCK)
        if (ctx.dialect === "mssql" && isWord(node, "WITH") && isGroup(body[i + 1]) && hintList(body[i + 1] as Group)) {
            noteHint(body[i + 1] as Group, ctx);
            ctx.apply("hints", textOf([node, body[i + 1]]), "");
            i++;
            continue;
        }
        if (ctx.dialect === "mssql" && isGroup(node) && out.length > 0 && hintList(node) && node.items.some((item) => isWord(item) && LOCK_HINT.test((item as Token).text))) {
            noteHint(node, ctx);
            ctx.apply("hints", textOf([node]), "");
            continue;
        }
        // MySQL: USE INDEX (...), FORCE INDEX (...), IGNORE INDEX (...)
        if (ctx.dialect === "mysql" && isWord(node, "USE", "FORCE", "IGNORE") && isWord(body[i + 1], "INDEX", "KEY") && isGroup(body[i + 2])) {
            ctx.apply("hints", textOf(body.slice(i, i + 3)), "");
            i += 2;
            continue;
        }
        out.push(node);
    }
    from.body = out;
}

function hintList(g: Group): boolean {
    if (g.items.length === 0) return false;
    return splitTopLevel(g.items).every((part) => part.length >= 1 && isToken(part[0]) && part[0].kind === "word" && /^(NOLOCK|READUNCOMMITTED|READCOMMITTED|REPEATABLEREAD|SERIALIZABLE|ROWLOCK|PAGLOCK|TABLOCK|TABLOCKX|UPDLOCK|XLOCK|HOLDLOCK|READPAST|NOWAIT|NOEXPAND|FORCESEEK|FORCESCAN|INDEX|SNAPSHOT)$/i.test(part[0].text));
}

function noteHint(g: Group, ctx: Ctx) {
    if (g.items.some((item) => isToken(item) && item.kind === "word" && LOCK_HINT.test(item.text))) {
        ctx.trap({
            id: "nolock",
            severity: "check",
            title: "NOLOCK was removed",
            explanation: "NOLOCK let the query read rows other transactions had not committed. PostgreSQL never shows uncommitted rows, so readers are not blocked and no hint is needed, but a result that depended on seeing dirty data will differ.",
        });
    }
}

/** DB2: WITH UR / CS / RS / RR, FOR READ ONLY, OPTIMIZE FOR n ROWS. */
export function removeDb2Options(block: Block, ctx: Ctx) {
    for (const clause of block.clauses) {
        const body = clause.body;
        const out: Node[] = [];
        for (let i = 0; i < body.length; i++) {
            if (isWord(body[i], "WITH") && isWord(body[i + 1], "UR", "CS", "RS", "RR")) {
                ctx.apply("hints", textOf(body.slice(i, i + 2)), "");
                i += 1;
                continue;
            }
            if (isWord(body[i], "OPTIMIZE") && isWord(body[i + 1], "FOR")) {
                const end = isWord(body[i + 3], "ROW", "ROWS") ? i + 3 : i + 2;
                ctx.apply("hints", textOf(body.slice(i, end + 1)), "");
                i = end;
                continue;
            }
            out.push(body[i]);
        }
        clause.body = out;
    }
    const forClause = block.clauses.find((clause) => clause.name === "FOR" && isWord(clause.body[0], "READ", "FETCH"));
    if (forClause) {
        ctx.apply("hints", textOf([...forClause.head, ...forClause.body]), "");
        removeClause(block, "FOR");
    }
}

/** OPTION (RECOMPILE, MAXDOP 1) */
export function removeOptionClause(block: Block, ctx: Ctx) {
    const option = findClause(block, "OPTION");
    if (!option) return;
    ctx.apply("hints", textOf([...option.head, ...option.body]), "");
    removeClause(block, "OPTION");
}

/** CROSS APPLY / OUTER APPLY in the FROM clause. */
export function convertApply(block: Block, ctx: Ctx) {
    const from = findClause(block, "FROM");
    if (!from) return;
    const body = from.body;
    const out: Node[] = [];
    for (let i = 0; i < body.length; i++) {
        const node = body[i];
        if (isWord(node, "CROSS", "OUTER") && isWord(body[i + 1], "APPLY")) {
            const outer = upper(node) === "OUTER";
            const before = `${upper(node)} APPLY`;
            out.push(...(outer ? tpl`LEFT JOIN LATERAL` : tpl`CROSS JOIN LATERAL`).map((token, index) => (index === 0 ? { ...token, ws: (node as Token).ws } : token)));
            i += 1;
            // the applied subquery or table function
            let j = i + 1;
            if (isGroup(body[j])) {
                out.push(body[j]);
                j++;
            } else {
                while (j < body.length && isToken(body[j]) && ((body[j] as Token).kind === "word" || (body[j] as Token).kind === "ident" || isPunct(body[j], "."))) {
                    if (isGroup(body[j + 1])) {
                        out.push(body[j], body[j + 1]);
                        j += 2;
                        break;
                    }
                    out.push(body[j]);
                    j++;
                }
            }
            // optional alias
            if (isWord(body[j], "AS") && isToken(body[j + 1])) {
                out.push(body[j], body[j + 1]);
                j += 2;
            } else if (isToken(body[j]) && (body[j] as Token).kind === "word" && !/^(CROSS|INNER|LEFT|RIGHT|FULL|OUTER|JOIN|ON|NATURAL)$/i.test((body[j] as Token).text)) {
                out.push(body[j]);
                j++;
            }
            if (outer) out.push(...tpl`ON TRUE`);
            ctx.apply("apply", before, outer ? "LEFT JOIN LATERAL … ON TRUE" : "CROSS JOIN LATERAL");
            i = j - 1;
            continue;
        }
        out.push(node);
    }
    from.body = out;
}

/** PostgreSQL before 16 needs a name on every subquery in FROM. */
export function ensureDerivedAliases(block: Block, ctx: Ctx, counter: { n: number }) {
    const from = findClause(block, "FROM");
    if (!from) return;
    const body = from.body;
    const out: Node[] = [];
    const boundary = (node: Node | undefined) => node === undefined || isPunct(node, ",") || isWord(node, "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "ON", "USING", "OUTER");
    for (let i = 0; i < body.length; i++) {
        const node = body[i];
        out.push(node);
        if (isGroup(node) && (isWord(node.items[0], "SELECT", "WITH", "VALUES")) && boundary(body[i + 1]) && !isWord(body[i - 1], "LATERAL") && !isWord(body[i - 1], "ON", "IN")) {
            counter.n += 1;
            out.push(...tpl`AS subquery_${String(counter.n)}`);
            ctx.apply("derived-alias", "(SELECT …)", `(SELECT …) AS subquery_${counter.n}`);
        }
    }
    from.body = out;
}

// ---- ROWNUM ----------------------------------------------------------------------------------------------------------

const isRownum = (node: Node | undefined) => isWord(node, "ROWNUM");

interface RownumLimit {
    limit: Node[];
    /** The number as a JavaScript number, when it is a plain integer. */
    value?: number;
}

/** `ROWNUM <= n`, `ROWNUM < n`, `ROWNUM = 1`, `n >= ROWNUM` as a row limit. */
function rownumConjunct(nodes: Node[]): RownumLimit | "impossible" | undefined {
    if (nodes.length !== 3) return undefined;
    const [a, operator, b] = nodes;
    if (!isOp(operator)) return undefined;
    let op = (operator as Token).text;
    let numberNode: Node | undefined;
    if (isRownum(a)) numberNode = b;
    else if (isRownum(b)) {
        numberNode = a;
        op = ({ "<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=" } as Record<string, string>)[op] ?? op;
    } else return undefined;
    if (!isToken(numberNode) || (numberNode.kind !== "number" && numberNode.kind !== "param")) return undefined;
    const isNumber = numberNode.kind === "number" && /^\d+$/.test(numberNode.text);
    const value = isNumber ? Number(numberNode.text) : undefined;
    if (op === "<=") return { limit: [{ ...numberNode, ws: undefined }], value };
    if (op === "<") {
        if (value !== undefined) return value <= 1 ? "impossible" : { limit: [{ kind: "number", text: String(value - 1) }], value: value - 1 };
        return undefined;
    }
    if (op === "=") return value === 1 ? { limit: [{ kind: "number", text: "1" }], value: 1 } : "impossible";
    return undefined;
}

const AGGREGATES = /^(COUNT|SUM|AVG|MIN|MAX|LISTAGG|STRING_AGG|GROUP_CONCAT|ARRAY_AGG|MEDIAN|STDDEV|VARIANCE|STDDEV_POP|VARIANCE_POP|COLLECT)$/i;

/** What in this block runs after ROWNUM in Oracle but before LIMIT in PostgreSQL (aggregation, DISTINCT, window functions). */
function limitsBeforeGrouping(block: Block): string | undefined {
    if (findClause(block, "GROUP BY") || findClause(block, "HAVING")) return "GROUP BY / HAVING";
    const select = findClause(block, "SELECT");
    if (!select) return undefined;
    if (isWord(select.body[0], "DISTINCT", "UNIQUE")) return "DISTINCT";
    const scan = (nodes: Node[]): string | undefined => {
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (isGroup(node)) {
                if (isWord(node.items[0], "SELECT", "WITH")) continue;
                const inner = scan(node.items);
                if (inner) return inner;
            } else if (isToken(node) && node.kind === "word") {
                if (isGroup(nodes[i + 1]) && AGGREGATES.test(node.text)) return "the aggregate function " + node.text.toUpperCase();
                if (/^OVER$/i.test(node.text) && isGroup(nodes[i + 1])) return "window functions";
            }
        }
        return undefined;
    };
    return scan(select.body);
}

export function convertRownum(block: Block, ctx: Ctx, multiBlock = false) {
    const where = findClause(block, "WHERE");
    if (!where) return;
    const conjuncts = splitConjuncts(where.body);
    const kept: Node[][] = [];
    let found: RownumLimit | undefined;
    for (const conjunct of conjuncts) {
        const result = conjunct.some(isRownum) ? rownumConjunct(conjunct) : undefined;
        if (result === "impossible") {
            ctx.unsupported(textOf(conjunct), "This ROWNUM condition can never be true in Oracle (or only for the first row), so the query returns no rows or one", "Check whether the condition was meant to be ROWNUM <= n.");
            return;
        }
        if (result && !found) {
            found = result;
            continue;
        }
        kept.push(conjunct);
    }
    if (!found) return;
    const unsafe = limitsBeforeGrouping(block);
    if (unsafe) {
        ctx.unsupported(`WHERE ${textOf(where.body)}`, `ROWNUM limits the rows before ${unsafe}, so a plain LIMIT would return something different`, "Put the ROWNUM filter in a subquery and aggregate or de-duplicate outside it.");
        return;
    }
    const before = `WHERE ${textOf(where.body)}`;
    if (kept.length === 0) removeClause(block, "WHERE");
    else where.body = [withWs(normalize(joinConjuncts(kept))[0], " "), ...joinConjuncts(kept).slice(1)];
    addClause(block, "LIMIT", found.limit);
    if (multiBlock) block.parens = true;
    ctx.apply("rownum-limit", before, `LIMIT ${textOf(found.limit)}`);
    if (findClause(block, "ORDER BY")) {
        ctx.trap({
            id: "rownum-order-by",
            severity: "changes-results",
            title: "ROWNUM is applied before ORDER BY in Oracle",
            explanation: "In the Oracle query, the first n rows are picked in no particular order and only then sorted. The converted query sorts first and then takes n rows, which is almost certainly what the query was meant to do, but it returns different rows. To keep the old result, put the LIMIT in a subquery and sort the outside.",
        });
    }
}

/** The classic three-level ROWNUM paging query becomes LIMIT / OFFSET. */
export function convertRownumPagination(block: Block, ctx: Ctx, dialect: LegacyDialect): boolean {
    const select = findClause(block, "SELECT");
    const from = findClause(block, "FROM");
    const where = findClause(block, "WHERE");
    if (!select || !from || !where) return false;
    if (block.clauses.some((clause) => !["SELECT", "FROM", "WHERE"].includes(clause.name))) return false;

    // FROM (middle) [alias]
    const fromNodes = from.body;
    const middleGroup = fromNodes[0];
    if (!isGroup(middleGroup) || fromNodes.length > 3) return false;
    const aliasNode = fromNodes.length >= 2 ? fromNodes[fromNodes.length - 1] : undefined;
    const outerAlias = aliasNode && isToken(aliasNode) ? nameOf(aliasNode) : undefined;
    const middle = parseQuery(middleGroup.items, dialect);
    if (!middle || middle.blocks.length !== 1) return false;
    const middleBlock = middle.blocks[0];
    const middleSelect = findClause(middleBlock, "SELECT");
    if (!middleSelect) return false;

    // exactly one `ROWNUM [AS] alias` item in the middle select list
    const items = splitTopLevel(middleSelect.body);
    const rownumIndex = items.findIndex((item) => isRownum(item[0]));
    if (rownumIndex < 0) return false;
    const rownumItem = items[rownumIndex];
    const rnAlias = rownumItem.length === 2 ? rownumItem[1] : rownumItem.length === 3 && isWord(rownumItem[1], "AS") ? rownumItem[2] : undefined;
    if (!rnAlias || !isToken(rnAlias)) return false;
    const rn = nameOf(rnAlias);
    if (items.filter((item) => item.some(isRownum)).length !== 1) return false;

    // outer WHERE: rn > lo | rn >= lo | rn BETWEEN lo AND hi  (and nothing else)
    const conjuncts = splitConjuncts(where.body);
    const middleLimit = findClause(middleBlock, "LIMIT");
    let lo: number | undefined;
    let hi: number | undefined;
    for (const conjunct of conjuncts) {
        const [a, operator, b, and, c] = conjunct;
        const isRn = (node: Node | undefined) => isToken(node) && (node.kind === "word" || node.kind === "ident") && nameOf(node) === rn;
        const isInt = (node: Node | undefined) => isToken(node) && node.kind === "number" && /^\d+$/.test(node.text);
        if (conjunct.length === 3 && isRn(a) && isOp(operator) && isInt(b)) {
            const n = Number((b as Token).text);
            const symbol = (operator as Token).text;
            if (symbol === ">") lo = n;
            else if (symbol === ">=") lo = n - 1;
            else if (symbol === "<=") hi = n;
            else if (symbol === "<") hi = n - 1;
            else return false;
        } else if (conjunct.length === 5 && isRn(a) && isWord(operator, "BETWEEN") && isInt(b) && isWord(and, "AND") && isInt(c)) {
            lo = Number((b as Token).text) - 1;
            hi = Number((c as Token).text);
        } else return false;
    }
    if (lo === undefined) return false;
    if (middleLimit) {
        const limitValue = Number(textOf(middleLimit.body));
        if (!Number.isInteger(limitValue)) return false;
        hi = hi === undefined ? limitValue : Math.min(hi, limitValue);
    }
    if (hi === undefined || hi <= lo) return false;

    // the new middle: without the ROWNUM column and the LIMIT it had
    const remaining = items.filter((_, index) => index !== rownumIndex);
    if (remaining.length === 0) return false;
    middleSelect.body = remaining.flatMap((item, index) => (index === 0 ? item : [{ kind: "punct", text: "," } as Token, ...item]));
    if (middleLimit) removeClause(middleBlock, "LIMIT");
    addClause(middleBlock, "LIMIT", [{ kind: "number", text: String(hi - lo) }]);
    addClause(middleBlock, "OFFSET", [{ kind: "number", text: String(lo) }]);

    // outer select list: * or alias.* means the middle query is the whole answer
    const outerItems = splitTopLevel(select.body);
    const isStar = (item: Node[]) => (item.length === 1 && isOp(item[0], "*")) || (item.length === 3 && isPunct(item[1], ".") && isOp(item[2], "*") && (!outerAlias || (isToken(item[0]) && nameOf(item[0]) === outerAlias)));
    if (outerItems.some((item) => item.some((node) => isToken(node) && (node.kind === "word" || node.kind === "ident") && nameOf(node) === rn))) {
        ctx.unsupported(textOf(select.body), `The outer query selects the row-number column "${rn}"`, "Use row_number() OVER (ORDER BY …) in the query where you need the number.");
        return false;
    }

    // unwrap `SELECT x.* FROM (inner) x` to inner
    let newMiddleItems = assemble(middle);
    const mSelectItems = splitTopLevel(findClause(middleBlock, "SELECT")!.body);
    const middleFrom = findClause(middleBlock, "FROM");
    const onlyStar = mSelectItems.length === 1 && (mSelectItems[0].length === 1 ? isOp(mSelectItems[0][0], "*") : mSelectItems[0].length === 3 && isOp(mSelectItems[0][2], "*"));
    const innerGroup = middleFrom && middleFrom.body.length >= 1 && isGroup(middleFrom.body[0]) && middleFrom.body.length <= 3 ? (middleFrom.body[0] as Group) : undefined;
    const middleHasOtherClauses = middleBlock.clauses.some((clause) => !["SELECT", "FROM", "LIMIT", "OFFSET"].includes(clause.name));
    if (onlyStar && innerGroup && !middleHasOtherClauses) {
        const inner = parseQuery(innerGroup.items, dialect);
        if (inner && inner.blocks.length === 1 && !findClause(inner.blocks[0], "LIMIT") && !findClause(inner.blocks[0], "OFFSET")) {
            addClause(inner.blocks[0], "LIMIT", [{ kind: "number", text: String(hi - lo) }]);
            addClause(inner.blocks[0], "OFFSET", [{ kind: "number", text: String(lo) }]);
            newMiddleItems = assemble(inner);
        }
    }

    const star = outerItems.length === 1 && isStar(outerItems[0]);
    const before = print(normalize(block.clauses.flatMap((clause) => [...clause.head, ...clause.body]))).trim();
    if (star) {
        // the whole outer block is replaced by the (unwrapped) middle query
        block.clauses = [{ name: "SELECT", head: [], body: newMiddleItems }];
    } else {
        // keep the outer projection over the new middle
        middleGroup.items = newMiddleItems;
        removeClause(block, "WHERE");
    }
    ctx.apply("rownum-pagination", before, `LIMIT ${hi - lo} OFFSET ${lo}`);
    ctx.trap({
        id: "rownum-pagination-column",
        severity: "check",
        title: "The row-number column is no longer returned",
        explanation: `The paging query also returned its row number (${rn}). LIMIT / OFFSET returns the page without it. Code that reads that column needs row_number() OVER (ORDER BY …) instead.`,
    });
    return true;
}

// ---- (+) outer joins -----------------------------------------------------------------------------------------------

interface FromItem {
    nodes: Node[];
    alias: string;
}

function parseFromItems(body: Node[]): FromItem[] | undefined {
    const parts = splitTopLevel(body);
    const items: FromItem[] = [];
    for (const part of parts) {
        if (part.length === 0) return undefined;
        if (part.some((node) => isWord(node, "JOIN", "CROSS", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "NATURAL", "APPLY", "LATERAL"))) return undefined;
        let alias: string | undefined;
        if (isGroup(part[0])) {
            const last = part[part.length - 1];
            if (part.length >= 2 && isToken(last) && (last.kind === "word" || last.kind === "ident")) alias = nameOf(last);
        } else {
            // name path, optional AS, optional alias
            let i = 0;
            const path: Token[] = [];
            while (i < part.length && isToken(part[i]) && ((part[i] as Token).kind === "word" || (part[i] as Token).kind === "ident")) {
                path.push(part[i] as Token);
                i++;
                if (isPunct(part[i], ".")) i++;
                else break;
            }
            if (path.length === 0) return undefined;
            let rest = part.slice(i);
            if (isWord(rest[0], "AS")) rest = rest.slice(1);
            if (rest.length === 1 && isToken(rest[0]) && ((rest[0] as Token).kind === "word" || (rest[0] as Token).kind === "ident")) alias = nameOf(rest[0] as Token);
            else if (rest.length > 0) return undefined;
            if (!alias) alias = nameOf(path[path.length - 1]);
        }
        if (!alias) return undefined;
        items.push({ nodes: part, alias });
    }
    return items;
}

/** Aliases used as `alias.column` anywhere in the nodes (looking inside brackets, but not into subqueries). */
function referencedAliases(nodes: Node[], known: Set<string>, dialect: LegacyDialect): Set<string> {
    const found = new Set<string>();
    const visit = (list: Node[]) => {
        for (let i = 0; i < list.length; i++) {
            const node = list[i];
            if (isGroup(node)) {
                if (clauseStartAt(node.items, 0, dialect)?.name === "SELECT" || upper(node.items[0]) === "WITH") continue;
                visit(node.items);
            } else if (isToken(node) && (node.kind === "word" || node.kind === "ident") && isPunct(list[i + 1], ".") && !isPunct(list[i - 1], ".")) {
                const name = nameOf(node);
                if (known.has(name)) found.add(name);
            }
        }
    };
    visit(nodes);
    return found;
}

function containsOuterMarker(nodes: Node[]): boolean {
    return nodes.some((node) => (isGroup(node) ? containsOuterMarker(node.items) : node.kind === "outer"));
}

/** Removes the (+) tokens and returns the alias each one qualified. */
function stripOuterMarkers(nodes: Node[]): { nodes: Node[]; aliases: string[]; bad: boolean } {
    const aliases: string[] = [];
    let bad = false;
    const out: Node[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (isToken(node) && node.kind === "outer") {
            // the column path right before it: [a.]b
            const path: Node[] = [];
            let j = out.length - 1;
            if (j >= 0 && isToken(out[j]) && ((out[j] as Token).kind === "word" || (out[j] as Token).kind === "ident")) {
                path.unshift(out[j]);
                j--;
                while (j >= 1 && isPunct(out[j], ".") && isToken(out[j - 1]) && ((out[j - 1] as Token).kind === "word" || (out[j - 1] as Token).kind === "ident")) {
                    path.unshift(out[j - 1], out[j]);
                    j -= 2;
                }
            }
            const parts = columnPath(path);
            if (!parts || parts.length < 2) bad = true;
            else aliases.push(nameOf(parts[parts.length - 2]));
            continue;
        }
        if (isGroup(node)) {
            if (containsOuterMarker(node.items)) {
                const inner = stripOuterMarkers(node.items);
                aliases.push(...inner.aliases);
                bad = bad || inner.bad;
                out.push({ ...node, items: inner.nodes });
                continue;
            }
        }
        out.push(node);
    }
    return { nodes: out, aliases, bad };
}

export function convertOuterJoins(block: Block, ctx: Ctx, dialect: LegacyDialect) {
    const where = findClause(block, "WHERE");
    const from = findClause(block, "FROM");
    if (!where || !from || !containsOuterMarker(where.body)) return;

    const fail = (reason: string, hint?: string) => ctx.unsupported(textOf(where.body), reason, hint ?? "Rewrite it with LEFT JOIN … ON by hand.");
    const items = parseFromItems(from.body);
    if (!items) return fail("The (+) outer join is mixed with explicit JOIN syntax or an unusual FROM item");
    const known = new Set(items.map((item) => item.alias));
    if (known.size !== items.length) return fail("Two FROM items share the same alias");

    const conjuncts = splitConjuncts(where.body);
    interface Analysed {
        nodes: Node[];
        outer?: string;
        refs: Set<string>;
        isOuterJoin: boolean;
    }
    const analysed: Analysed[] = [];
    for (const conjunct of conjuncts) {
        if (!containsOuterMarker(conjunct)) {
            analysed.push({ nodes: conjunct, refs: referencedAliases(conjunct, known, dialect), isOuterJoin: false });
            continue;
        }
        const stripped = stripOuterMarkers(conjunct);
        const owners = [...new Set(stripped.aliases)];
        if (stripped.bad || owners.length !== 1 || !known.has(owners[0])) return fail("A (+) marker is on a column with no table alias, on several tables at once, or on a table that isn't in this FROM clause");
        // an OR across (+) is an error in Oracle; leave it
        if (conjunct.some((node) => isWord(node, "OR"))) return fail("(+) inside an OR condition");
        const refs = referencedAliases(stripped.nodes, known, dialect);
        analysed.push({ nodes: stripped.nodes, outer: owners[0], refs, isOuterJoin: true });
    }

    const outerTables = new Set(analysed.filter((entry) => entry.outer).map((entry) => entry.outer!));
    const onFor = (alias: string) => analysed.filter((entry) => entry.outer === alias);

    // attach items one by one: base tables first, then each outer table once everything it joins to is there
    const attached: FromItem[] = [];
    const attachedAliases = new Set<string>();
    const pending = [...items];
    const base = pending.filter((item) => !outerTables.has(item.alias));
    if (base.length === 0) return fail("Every table in the FROM clause is on the optional side");
    const used = new Set<Analysed>();
    const parts: Node[] = [];
    const lineBreak = /\n/.test(from.body.map((node) => (isToken(node) ? (node.ws ?? "") : "")).join("") + (from.head[0].ws ?? ""));
    const gap = lineBreak ? "\n    " : " ";
    const join = (text: string): Node[] => tpl`${text}`.map((token, index) => (index === 0 ? { ...token, ws: gap } : token));

    const attach = (item: FromItem, kind: "FIRST" | "LEFT" | "INNER", on: Analysed[]) => {
        const nodes = normalize(item.nodes);
        if (kind === "FIRST") parts.push(...nodes.map((node, index) => (index === 0 ? withWs(node, " ") : node)));
        else if (kind === "LEFT") parts.push(...join("LEFT JOIN"), ...nodes, ...tpl`ON`, ...joinConjuncts(on.map((entry) => entry.nodes)));
        else if (on.length > 0) parts.push(...join("INNER JOIN"), ...nodes, ...tpl`ON`, ...joinConjuncts(on.map((entry) => entry.nodes)));
        else parts.push(...join("CROSS JOIN"), ...nodes);
        attached.push(item);
        attachedAliases.add(item.alias);
        for (const entry of on) used.add(entry);
    };

    attach(base[0], "FIRST", []);
    const remainingBase = base.slice(1);
    const remainingOuter = items.filter((item) => outerTables.has(item.alias));
    const external = (alias: string) => !known.has(alias);
    let guard = 0;
    while ((remainingBase.length > 0 || remainingOuter.length > 0) && guard++ < 200) {
        // an outer table whose other side is already attached
        const outerIndex = remainingOuter.findIndex((item) => onFor(item.alias).every((entry) => [...entry.refs].every((ref) => ref === item.alias || attachedAliases.has(ref) || external(ref))));
        if (outerIndex >= 0) {
            const item = remainingOuter.splice(outerIndex, 1)[0];
            attach(item, "LEFT", onFor(item.alias));
            continue;
        }
        if (remainingBase.length > 0) {
            const item = remainingBase.shift()!;
            const joining = analysed.filter((entry) => !entry.isOuterJoin && !used.has(entry) && entry.refs.has(item.alias) && entry.refs.size > 1 && [...entry.refs].every((ref) => ref === item.alias || attachedAliases.has(ref)));
            attach(item, "INNER", joining);
            continue;
        }
        return fail("The (+) conditions form a cycle, so they can't be turned into a join order");
    }

    const leftover = analysed.filter((entry) => !used.has(entry));
    const before = `FROM ${textOf(from.body)} WHERE ${textOf(where.body)}`;
    from.body = parts;
    if (leftover.length === 0) removeClause(block, "WHERE");
    else where.body = [withWs(normalize(joinConjuncts(leftover.map((entry) => entry.nodes)))[0], " "), ...joinConjuncts(leftover.map((entry) => entry.nodes)).slice(1)];
    const after = `FROM ${textOf(from.body)}${leftover.length ? ` WHERE ${textOf(where.body)}` : ""}`;
    ctx.apply("outer-join", before, after);
}

export { word, paren };
