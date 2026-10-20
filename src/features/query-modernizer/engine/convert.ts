import type { LegacyDialect, SchemaContext } from "../types";
import { Ctx } from "./context";
import { rewriteDelete, rewriteInsert, rewriteMerge, checkUpdate } from "./dml";
import { rewriteExpressions } from "./functions";
import { convertConnectBy } from "./hierarchy";
import {
    assemble,
    convertApply,
    convertMysqlLimit,
    convertOuterJoins,
    convertRownum,
    convertRownumPagination,
    convertTop,
    ensureDerivedAliases,
    findClause,
    parseQuery,
    removeDb2Options,
    removeDual,
    removeFromHints,
    removeOptionClause,
} from "./query";
import { AppliedRule, Trap, UnconvertedItem } from "./rules";
import { Node, SqlSyntaxError, Token, buildTree, flatten, isGroup, isPunct, isToken, isWord, print, textOf, tokenize, upper } from "./tokens";
import { auditLeftovers, collectParameters, detectSourceTraps, replaceParameters } from "./traps";

export interface ConvertInput {
    sql: string;
    dialect: LegacyDialect;
    /** Tables on the user's canvas or connection: names, columns and types only. */
    schema?: SchemaContext;
}

export interface StatementOutcome {
    /** The statement as written. */
    source: string;
    /** What it became. */
    sql: string;
    /** SELECT, INSERT, ... or the first word. */
    kind: string;
    /** False when the statement is of a kind this engine leaves alone. */
    handled: boolean;
}

export interface Conversion {
    /** The converted SQL, with a comment at the top for anything that was not converted. */
    sql: string;
    /** The same SQL with bind variables replaced by NULL, so a database can check it. */
    validationSql: string;
    statements: StatementOutcome[];
    applied: AppliedRule[];
    unconverted: UnconvertedItem[];
    traps: Trap[];
    /** Bind variables found (@x, :name, ?). */
    parameters: string[];
    /** Tables the query reads or writes that are not among the supplied tables. Empty when no tables were supplied. */
    unknownTables: string[];
    /** Set when the text could not even be split into tokens (an unclosed quote or bracket). `sql` is then the original. */
    syntaxError?: string;
}

const PROCEDURAL = new Set(["DECLARE", "SET", "EXEC", "EXECUTE", "PRINT", "BEGIN", "IF", "WHILE", "RETURN", "CALL", "GO", "USE", "GRANT", "REVOKE", "RAISERROR", "THROW", "OPEN", "FETCH", "CLOSE", "DEALLOCATE"]);
const DDL = new Set(["CREATE", "ALTER", "DROP", "RENAME", "COMMENT", "ANALYZE"]);

/** Converts a legacy SQL text (one or more statements) to PostgreSQL. */
export function convertQuery(input: ConvertInput): Conversion {
    const ctx = new Ctx(input.dialect, input.schema);
    const source = input.sql;

    let tokens: Token[];
    try {
        tokens = tokenize(source, input.dialect);
    } catch (error) {
        return failed(source, error);
    }
    if (tokens.length === 0) return { sql: source, validationSql: source, statements: [], applied: [], unconverted: [], traps: [], parameters: [], unknownTables: [] };

    tokens = dropDefaultSchema(tokens, ctx);
    detectSourceTraps(tokens, ctx);

    const statementTokens = splitStatements(tokens);
    const outcomes: StatementOutcome[] = [];
    const printed: string[] = [];
    const validation: string[] = [];
    const finalNodes: Node[] = [];
    const state = { hierarchy: false };
    const seenTables = new Set<string>();

    for (const statement of statementTokens) {
        let tree: Node[];
        try {
            tree = buildTree(statement);
        } catch (error) {
            return failed(source, error);
        }
        const kind = firstWord(tree);
        const before = ctx.unconverted.length;
        const { nodes, handled } = convertStatement(tree, kind, ctx, state);
        void before;
        finalNodes.push(...nodes);
        const text = print(nodes);
        printed.push(text);
        validation.push(print(replaceParameters(nodes)));
        outcomes.push({ source: print(tree).trim(), sql: text.trim(), kind: kind || "(empty)", handled });
        for (const table of tablesIn(nodes)) seenTables.add(table);
    }

    auditLeftovers(finalNodes, ctx, state);
    for (const parameter of collectParameters(finalNodes)) ctx.unsupported(parameter, `The bind variable ${parameter} is not converted`, "PostgreSQL drivers use $1, $2 …; replace it with one, or with a literal when you run the query.");

    const unknownTables = ctx.schema.isEmpty ? [] : [...seenTables].filter((table) => !ctx.schema.hasTable(table) && !cteNames(finalNodes).has(table)).sort();

    let sql = printed.join("").trim();
    if (ctx.unconverted.length > 0) {
        const header = ctx.unconverted.map((item) => `-- NOT CONVERTED: ${oneLine(item.construct)} (${oneLine(item.reason)})`).join("\n");
        sql = `${header}\n${sql}`;
    }

    return {
        sql,
        validationSql: validation.join("").trim(),
        statements: outcomes,
        applied: ctx.applied,
        unconverted: ctx.unconverted,
        traps: ctx.traps,
        parameters: collectParameters(finalNodes),
        unknownTables,
    };
}

/** The SQL with bind variables (@x, :name, ?) replaced by NULL, so a database can check it. Unreadable SQL is returned as it is. */
export function neutralizeParameters(sql: string, dialect: LegacyDialect): string {
    try {
        const tokens = tokenize(sql, dialect);
        if (!tokens.some((token) => token.kind === "param")) return sql;
        return print(replaceParameters(buildTree(tokens)));
    } catch {
        return sql;
    }
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 140);

function failed(source: string, error: unknown): Conversion {
    return {
        sql: source,
        validationSql: source,
        statements: [],
        applied: [],
        unconverted: [],
        traps: [],
        parameters: [],
        unknownTables: [],
        syntaxError: error instanceof SqlSyntaxError ? error.message : error instanceof Error ? error.message : String(error),
    };
}

/** SQL Server's dbo schema doesn't exist in PostgreSQL; the name resolves through search_path instead. */
function dropDefaultSchema(tokens: Token[], ctx: Ctx): Token[] {
    if (ctx.dialect !== "mssql") return tokens;
    const out: Token[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const isDbo = (token.kind === "word" || token.kind === "ident") && (token.value ?? token.text).toLowerCase() === "dbo";
        if (isDbo && tokens[i + 1]?.kind === "punct" && tokens[i + 1].text === "." && tokens[i + 2] && (tokens[i + 2].kind === "word" || tokens[i + 2].kind === "ident")) {
            ctx.apply("schema-prefix", `${token.text}.${tokens[i + 2].text}`, tokens[i + 2].text);
            // keep the whitespace that was before dbo
            tokens[i + 2] = { ...tokens[i + 2], ws: token.ws };
            i += 1;
            continue;
        }
        out.push(token);
    }
    return out;
}

/** Statements end at a top-level semicolon, which stays with the statement. */
function splitStatements(tokens: Token[]): Token[][] {
    const statements: Token[][] = [];
    let current: Token[] = [];
    let depth = 0;
    for (const token of tokens) {
        current.push(token);
        if (token.kind === "punct" && token.text === "(") depth++;
        else if (token.kind === "punct" && token.text === ")") depth = Math.max(0, depth - 1);
        else if (token.kind === "punct" && token.text === ";" && depth === 0) {
            statements.push(current);
            current = [];
        }
    }
    if (current.length > 0) statements.push(current);
    return statements.filter((statement) => statement.some((token) => !(token.kind === "punct" && token.text === ";")));
}

const firstWord = (tree: Node[]): string => {
    const first = tree[0];
    if (isGroup(first)) return "SELECT";
    return isToken(first) && first.kind === "word" ? first.text.toUpperCase() : "";
};

function convertStatement(tree: Node[], kind: string, ctx: Ctx, state: { hierarchy: boolean; aliases?: { n: number } }): { nodes: Node[]; handled: boolean } {
    switch (kind) {
        case "SELECT":
        case "WITH":
            return { nodes: rewriteNodes(tree, ctx, state), handled: true };
        case "INSERT": {
            let nodes = rewriteNodes(tree, ctx, state);
            const at = nodes.findIndex((node, index) => index > 0 && isWord(node, "SELECT", "WITH"));
            if (at > 0) nodes = [...nodes.slice(0, at), ...rewriteQuery(nodes.slice(at), ctx, state)];
            return { nodes: rewriteInsert(nodes, ctx), handled: true };
        }
        case "UPDATE": {
            const nodes = rewriteNodes(tree, ctx, state);
            checkUpdate(nodes, ctx);
            return { nodes, handled: true };
        }
        case "DELETE":
            return { nodes: rewriteDelete(rewriteNodes(tree, ctx, state), ctx), handled: true };
        case "MERGE":
            return { nodes: rewriteMerge(rewriteNodes(tree, ctx, state), ctx), handled: true };
        case "TRUNCATE":
        case "COMMIT":
        case "ROLLBACK":
        case "SAVEPOINT":
            return { nodes: tree, handled: true };
        default:
            if (DDL.has(kind)) ctx.unsupported(textOf(tree.slice(0, 5)) + " …", `${kind} statements are not converted here`, "Use Import or AI Schema for table definitions.");
            else if (PROCEDURAL.has(kind)) ctx.unsupported(textOf(tree.slice(0, 5)) + " …", `${kind} is procedural code (T-SQL / PL/SQL), not a query`, "Rewrite it as a PL/pgSQL function or move the logic to the application.");
            else ctx.unsupported(textOf(tree.slice(0, 5)) + " …", `This statement type${kind ? ` (${kind})` : ""} is not converted`);
            return { nodes: tree, handled: false };
    }
}

// ---- the walker ----------------------------------------------------------------------------------------------------

const isQueryList = (items: Node[]): boolean => isWord(items[0], "SELECT") || (isWord(items[0], "WITH") && items.some((node) => isWord(node, "SELECT")));

/** Rewrites children first (so a subquery is done before the query around it), then this list. */
function rewriteNodes(items: Node[], ctx: Ctx, state: { hierarchy: boolean; aliases?: { n: number } }): Node[] {
    const withChildren = items.map((node) => (isGroup(node) ? { ...node, items: rewriteNodes(node.items, ctx, state) } : node));
    const out = rewriteExpressions(withChildren, ctx);
    const renamed = ctx.dialect === "oracle" ? renameMinus(out, ctx) : out;
    return isQueryList(renamed) ? rewriteQuery(renamed, ctx, state) : renamed;
}

function renameMinus(items: Node[], ctx: Ctx): Node[] {
    return items.map((node) => {
        if (isToken(node) && node.kind === "word" && node.text.toUpperCase() === "MINUS") {
            ctx.apply("minus", "MINUS", "EXCEPT");
            return { ...node, text: "EXCEPT" };
        }
        return node;
    });
}

/** The clause-level rules for one query (a SELECT, maybe with set operators). */
function rewriteQuery(items: Node[], ctx: Ctx, state: { hierarchy: boolean; aliases?: { n: number } }): Node[] {
    const parts = parseQuery(items, ctx.dialect);
    if (!parts) return items;
    const multi = parts.blocks.length > 1;

    for (const block of parts.blocks) {
        removeDual(block, ctx);
        ensureDerivedAliases(block, ctx, (state.aliases ??= { n: 0 }));

        if (findClause(block, "CONNECT BY")) {
            if (multi) ctx.unsupported(textOf(findClause(block, "CONNECT BY")!.body), "CONNECT BY inside a UNION or similar", "Write the hierarchy as WITH RECURSIVE by hand.");
            else {
                const replaced = convertConnectBy(block, ctx, ctx.dialect);
                if (replaced) {
                    state.hierarchy = true;
                    return replaced;
                }
            }
        }

        if (ctx.dialect === "oracle" && convertRownumPagination(block, ctx, ctx.dialect)) continue;

        removeFromHints(block, ctx);
        if (ctx.dialect === "db2") removeDb2Options(block, ctx);
        if (ctx.dialect === "mssql") {
            convertApply(block, ctx);
            removeOptionClause(block, ctx);
            convertTop(block, ctx, multi);
        }
        if (ctx.dialect === "oracle") {
            convertOuterJoins(block, ctx, ctx.dialect);
            convertRownum(block, ctx, multi);
        }
        if (ctx.dialect === "mysql") convertMysqlLimit(block, ctx);

        const into = findClause(block, "INTO");
        if (into) ctx.unsupported(`SELECT … INTO ${textOf(into.body)}`, "SELECT INTO creates a table (T-SQL) or fills variables (PL/SQL); PostgreSQL's SELECT INTO creates a table too, but variables don't exist outside functions", "Use CREATE TABLE … AS SELECT, or INSERT … SELECT.");
    }
    return assemble(parts);
}

// ---- names -----------------------------------------------------------------------------------------------------------

/** Names of CTEs defined in the statement. */
function cteNames(nodes: Node[]): Set<string> {
    const names = new Set<string>();
    const visit = (list: Node[]) => {
        list.forEach((node, index) => {
            if (isGroup(node)) visit(node.items);
            else if (isWord(node, "WITH") && index === 0) {
                // WITH [RECURSIVE] name [(cols)] AS (...) [, name AS (...)]
                for (let i = 1; i < list.length; i++) {
                    if (isWord(list[i], "SELECT")) break;
                    const current = list[i];
                    if (isToken(current) && (current.kind === "word" || current.kind === "ident") && (isWord(list[i + 1], "AS") || isGroup(list[i + 1])) && !isWord(current, "RECURSIVE", "AS")) {
                        names.add((current.value ?? current.text).toLowerCase());
                    }
                }
            }
        });
    };
    visit(nodes);
    return names;
}

/** Table names after FROM / JOIN / INTO / UPDATE / USING. */
function tablesIn(nodes: Node[]): string[] {
    const found: string[] = [];
    const visit = (list: Node[]) => {
        for (let i = 0; i < list.length; i++) {
            const node = list[i];
            if (isGroup(node)) {
                visit(node.items);
                continue;
            }
            if (!isToken(node) || node.kind !== "word") continue;
            const word = node.text.toUpperCase();
            if (!["FROM", "JOIN", "INTO", "UPDATE", "USING"].includes(word)) continue;
            if (word === "FROM" && isWord(list[i - 1], "EXTRACT", "TRIM", "SUBSTRING", "OVERLAY")) continue;
            let j = i + 1;
            for (;;) {
                const nameToken = list[j];
                if (!(isToken(nameToken) && (nameToken.kind === "word" || nameToken.kind === "ident")) || isWord(nameToken, "SELECT", "LATERAL", "ONLY", "DUAL")) break;
                let last: Token = nameToken;
                j++;
                while (isPunct(list[j], ".") && isToken(list[j + 1])) {
                    last = list[j + 1] as Token;
                    j += 2;
                }
                if (isGroup(list[j])) break; // a function call or a column list
                found.push((last.value ?? last.text).toLowerCase());
                if (word !== "FROM") break;
                // alias, then a comma continues the list
                while (j < list.length && !isPunct(list[j], ",") && !isWord(list[j], "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "WHERE", "ON", "GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "EXCEPT", "INTERSECT", "OFFSET", "FETCH", "FOR", "WINDOW", "NATURAL", "USING", "WITH", "RETURNING")) {
                    if (isGroup(list[j])) break;
                    j++;
                }
                if (isPunct(list[j], ",")) j++;
                else break;
            }
        }
    };
    visit(nodes);
    return found;
}

export { flatten, upper };
