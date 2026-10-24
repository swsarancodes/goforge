import type { LegacyDialect } from "../types";

/**
 * Tokens and token trees for legacy SQL.
 *
 * The converter works on a token tree, not on text: every parenthesised group is one node, so a rule that rewrites
 * `DECODE(a, b, c)` never has to count brackets, and anything a rule doesn't touch is printed back exactly as it was.
 */

export type TokenKind =
    | "word" // keyword or unquoted identifier
    | "ident" // quoted identifier: "x", [x], `x`
    | "string" // 'text'
    | "number"
    | "op" // + - * / = <> || ...
    | "punct" // , . ;
    | "param" // @x, :x, ?
    | "outer" // the Oracle outer-join marker (+)
    | "hint"; // an Oracle optimizer hint comment

export interface Token {
    kind: TokenKind;
    /** What is printed. */
    text: string;
    /** Whitespace and comments before the token. `undefined` means "decide when printing" (tokens made by rules). */
    ws?: string;
    /** Decoded content of identifiers and strings. */
    value?: string;
    /** How an identifier was quoted in the source. */
    quote?: "double" | "bracket" | "backtick";
    /** The name was spelled differently in the source (quotes dropped, case folded) and `text` is its PostgreSQL spelling. */
    converted?: boolean;
}

export interface Group {
    kind: "group";
    open: Token;
    close: Token;
    items: Node[];
}

export type Node = Token | Group;

export const isGroup = (node: Node | undefined): node is Group => node !== undefined && (node as Group).kind === "group";
export const isToken = (node: Node | undefined): node is Token => node !== undefined && (node as Group).kind !== "group";

export class SqlSyntaxError extends Error {}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$#\u0080-￿]/;
const DIGIT = /[0-9]/;
const OPERATORS = ["!~*", "<=>", "||", "~*", "!~", "@>", "<@", "&&", "<=", ">=", "<>", "!=", "::", ":=", "**", "!<", "!>", "=>", "->>", "->", "+", "-", "*", "/", "%", "=", "<", ">", "^", "&", "|", "~", "!"];

/** Opening and closing characters of Oracle's alternative quoting, q'[...]'. */
const Q_QUOTE_CLOSE: Record<string, string> = { "[": "]", "(": ")", "{": "}", "<": ">" };

export function tokenize(sql: string, dialect: LegacyDialect): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    let ws = "";
    const n = sql.length;

    const push = (token: Token) => {
        token.ws = ws;
        ws = "";
        tokens.push(token);
    };

    while (i < n) {
        const ch = sql[i];

        // whitespace
        if (/\s/.test(ch)) {
            let j = i;
            while (j < n && /\s/.test(sql[j])) j++;
            ws += sql.slice(i, j);
            i = j;
            continue;
        }

        // -- comment (MySQL needs a space after the dashes, the others don't)
        if (ch === "-" && sql[i + 1] === "-" && (dialect !== "mysql" || /[\s]|^$/.test(sql[i + 2] ?? " "))) {
            let j = i;
            while (j < n && sql[j] !== "\n") j++;
            ws += sql.slice(i, j);
            i = j;
            continue;
        }
        if (ch === "#" && dialect === "mysql") {
            let j = i;
            while (j < n && sql[j] !== "\n") j++;
            ws += sql.slice(i, j);
            i = j;
            continue;
        }

        // /* block comment */ and /*+ hint */
        if (ch === "/" && sql[i + 1] === "*") {
            const end = sql.indexOf("*/", i + 2);
            if (end === -1) throw new SqlSyntaxError("A /* comment is never closed.");
            const text = sql.slice(i, end + 2);
            if (text.startsWith("/*+") && dialect === "oracle") push({ kind: "hint", text });
            else ws += text;
            i = end + 2;
            continue;
        }

        // Oracle q'[ ... ]' and national / unicode prefixes
        if ((ch === "q" || ch === "Q") && sql[i + 1] === "'" && dialect === "oracle" && Q_QUOTE_CLOSE[sql[i + 2]]) {
            const open = sql[i + 2];
            const close = Q_QUOTE_CLOSE[open];
            const end = sql.indexOf(`${close}'`, i + 3);
            if (end === -1) throw new SqlSyntaxError("A q'[...]' string is never closed.");
            push({ kind: "string", text: quoteString(sql.slice(i + 3, end)), value: sql.slice(i + 3, end) });
            i = end + 2;
            continue;
        }
        if ((ch === "N" || ch === "n") && sql[i + 1] === "'" && (dialect === "mssql" || dialect === "oracle")) {
            i += 1; // the N prefix has no meaning in PostgreSQL
            continue;
        }

        // 'string'
        if (ch === "'") {
            const { value, next } = readString(sql, i, "'", dialect === "mysql");
            push({ kind: "string", text: quoteString(value), value });
            i = next;
            continue;
        }

        // "..." is an identifier everywhere except MySQL (where it is a string by default)
        if (ch === '"') {
            const { value, next } = readString(sql, i, '"', dialect === "mysql");
            if (dialect === "mysql") push({ kind: "string", text: quoteString(value), value });
            else if ((dialect === "oracle" || dialect === "db2") && /^[A-Z][A-Z0-9_$]*$/.test(value)) {
                // Oracle and DB2 store bare names in upper case, so "NAME" is the same column as name
                push({ kind: "ident", text: identifierText(value), value, quote: "double", converted: true });
            } else push({ kind: "ident", text: `"${value.replace(/"/g, '""')}"`, value, quote: "double" });
            i = next;
            continue;
        }

        if (ch === "`" && dialect === "mysql") {
            const end = sql.indexOf("`", i + 1);
            if (end === -1) throw new SqlSyntaxError("A `quoted` name is never closed.");
            const value = sql.slice(i + 1, end);
            push({ kind: "ident", text: identifierText(value), value, quote: "backtick" });
            i = end + 1;
            continue;
        }

        if (ch === "[" && dialect === "mssql") {
            const end = sql.indexOf("]", i + 1);
            if (end === -1) throw new SqlSyntaxError("A [bracketed] name is never closed.");
            const value = sql.slice(i + 1, end);
            push({ kind: "ident", text: identifierText(value), value, quote: "bracket" });
            i = end + 1;
            continue;
        }

        // Oracle's (+) outer join marker
        if (ch === "(" && dialect === "oracle") {
            const marker = /^\(\s*\+\s*\)/.exec(sql.slice(i, i + 12));
            if (marker) {
                push({ kind: "outer", text: "(+)" });
                i += marker[0].length;
                continue;
            }
        }

        // numbers
        if (DIGIT.test(ch) || (ch === "." && DIGIT.test(sql[i + 1] ?? ""))) {
            let j = i;
            while (j < n && DIGIT.test(sql[j])) j++;
            if (sql[j] === "." && DIGIT.test(sql[j + 1] ?? "")) {
                j++;
                while (j < n && DIGIT.test(sql[j])) j++;
            } else if (sql[j] === "." && !WORD_START.test(sql[j + 1] ?? "")) {
                j++;
            }
            if ((sql[j] === "e" || sql[j] === "E") && /[0-9+-]/.test(sql[j + 1] ?? "")) {
                j++;
                if (sql[j] === "+" || sql[j] === "-") j++;
                while (j < n && DIGIT.test(sql[j])) j++;
            }
            // Oracle float/double suffixes (1.5f, 2d) carry no meaning in PostgreSQL
            const text = sql.slice(i, j);
            push({ kind: "number", text });
            i = j;
            if (dialect === "oracle" && /[fFdD]/.test(sql[i] ?? "") && !WORD_PART.test(sql[i + 1] ?? "")) i++;
            continue;
        }

        // parameters
        if (ch === "@" && (dialect === "mssql" || dialect === "mysql")) {
            let j = i + 1;
            if (sql[j] === "@") j++;
            while (j < n && WORD_PART.test(sql[j])) j++;
            push({ kind: "param", text: sql.slice(i, j) });
            i = j;
            continue;
        }
        if (ch === ":" && sql[i + 1] !== ":" && sql[i + 1] !== "=" && WORD_PART.test(sql[i + 1] ?? "") && dialect === "oracle") {
            let j = i + 1;
            while (j < n && WORD_PART.test(sql[j])) j++;
            push({ kind: "param", text: sql.slice(i, j) });
            i = j;
            continue;
        }
        if (ch === "?") {
            push({ kind: "param", text: "?" });
            i++;
            continue;
        }

        // words
        if (WORD_START.test(ch) || (ch === "#" && dialect === "mssql")) {
            let j = i + 1;
            while (j < n && (WORD_PART.test(sql[j]) || (sql[j] === "#" && dialect === "mssql"))) j++;
            push({ kind: "word", text: sql.slice(i, j) });
            i = j;
            continue;
        }

        // punctuation
        if ("(),;.[]".includes(ch)) {
            push({ kind: "punct", text: ch });
            i++;
            continue;
        }

        // operators
        const op = OPERATORS.find((candidate) => sql.startsWith(candidate, i));
        if (op) {
            push({ kind: "op", text: op });
            i += op.length;
            continue;
        }

        throw new SqlSyntaxError(`Unexpected character "${ch}" at position ${i + 1}.`);
    }

    // keep trailing comments/whitespace out of the stream; the engine trims statements anyway
    return tokens;
}

function readString(sql: string, start: number, quote: string, backslashEscapes: boolean): { value: string; next: number } {
    let i = start + 1;
    let value = "";
    while (i < sql.length) {
        const ch = sql[i];
        if (ch === "\\" && backslashEscapes && i + 1 < sql.length) {
            const next = sql[i + 1];
            const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", b: "\b", Z: "\x1a" };
            value += map[next] ?? next;
            i += 2;
            continue;
        }
        if (ch === quote) {
            if (sql[i + 1] === quote) {
                value += quote;
                i += 2;
                continue;
            }
            return { value, next: i + 1 };
        }
        value += ch;
        i++;
    }
    throw new SqlSyntaxError(`A ${quote}...${quote} string is never closed.`);
}

export function quoteString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** Words PostgreSQL won't accept as a bare name. A name that is one of them stays quoted. */
const PG_RESERVED = new Set(
    "all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references returning select session_user some symmetric table then to trailing true union unique user using variadic when where window with".split(" "),
);

/** Plain names are written bare in lower case (what an unquoted name means in PostgreSQL); reserved words and anything unusual stay quoted. */
export function identifierText(name: string): string {
    const lower = name.toLowerCase();
    const simple = /^[a-z_][a-z0-9_$]*$/.test(lower) && !/\s/.test(name);
    if (simple && !PG_RESERVED.has(lower)) return lower;
    return simple ? `"${lower}"` : `"${name.replace(/"/g, '""')}"`;
}

// ---- token tree -----------------------------------------------------------------------------------------------

export function buildTree(tokens: Token[]): Node[] {
    const root: Node[] = [];
    const stack: { open: Token; items: Node[] }[] = [];
    let items = root;

    for (const token of tokens) {
        if (token.kind === "punct" && token.text === "(") {
            stack.push({ open: token, items });
            items = [];
            continue;
        }
        if (token.kind === "punct" && token.text === ")") {
            const frame = stack.pop();
            if (!frame) throw new SqlSyntaxError("There is a closing bracket with no opening one.");
            const group: Group = { kind: "group", open: frame.open, close: token, items };
            items = frame.items;
            items.push(group);
            continue;
        }
        items.push(token);
    }
    if (stack.length > 0) throw new SqlSyntaxError("A bracket is never closed.");
    return root;
}

// ---- construction helpers ---------------------------------------------------------------------------------------

export const word = (text: string): Token => ({ kind: "word", text });
export const op = (text: string): Token => ({ kind: "op", text });
export const comma = (): Token => ({ kind: "punct", text: "," });
export const str = (value: string): Token => ({ kind: "string", text: quoteString(value), value });
export const num = (text: string | number): Token => ({ kind: "number", text: String(text) });
export const group = (items: Node[]): Group => ({ kind: "group", open: { kind: "punct", text: "(" }, close: { kind: "punct", text: ")" }, items });
export const call = (name: string, args: Node[][]): Node[] => [word(name), group(joinArgs(args))];

/** Words (keywords) from a string: words("CASE WHEN") -> [CASE, WHEN]. */
export const words = (text: string): Token[] => text.split(/\s+/).filter(Boolean).map(word);

export function joinArgs(args: Node[][]): Node[] {
    const out: Node[] = [];
    args.forEach((arg, index) => {
        if (index > 0) out.push(comma());
        out.push(...normalize(arg));
    });
    return out;
}

/** Copies the nodes with the leading whitespace of the first one reset, so a node can be moved to a new place. */
export function normalize(nodes: Node[]): Node[] {
    if (nodes.length === 0) return nodes;
    return [withoutLeadingSpace(nodes[0]), ...nodes.slice(1)];
}

export function withoutLeadingSpace(node: Node): Node {
    if (isGroup(node)) return { ...node, open: { ...node.open, ws: undefined } };
    return { ...node, ws: undefined };
}

export function upper(node: Node | undefined): string {
    return isToken(node) && node.kind === "word" ? node.text.toUpperCase() : "";
}

export const isWord = (node: Node | undefined, ...names: string[]): node is Token => isToken(node) && node.kind === "word" && (names.length === 0 || names.includes(node.text.toUpperCase()));
export const isOp = (node: Node | undefined, ...texts: string[]): node is Token => isToken(node) && node.kind === "op" && (texts.length === 0 || texts.includes(node.text));
export const isPunct = (node: Node | undefined, text: string): node is Token => isToken(node) && node.kind === "punct" && node.text === text;

/** Splits on commas that are not inside a group. */
export function splitTopLevel(items: Node[], isSeparator: (node: Node) => boolean = (node) => isPunct(node, ",")): Node[][] {
    const parts: Node[][] = [[]];
    for (const item of items) {
        if (isSeparator(item)) parts.push([]);
        else parts[parts.length - 1].push(item);
    }
    return parts;
}

// ---- printing ---------------------------------------------------------------------------------------------------

export function print(nodes: Node[]): string {
    let out = "";
    let previous: Token | undefined;

    const emit = (token: Token) => {
        let ws = token.ws;
        if (ws === undefined) ws = autoSpace(previous, token);
        out += ws + token.text;
        previous = token;
    };

    const visit = (list: Node[]) => {
        for (const node of list) {
            if (isGroup(node)) {
                emit(node.open);
                visit(node.items);
                emit(node.close);
            } else emit(node);
        }
    };
    visit(nodes);
    return out;
}

function autoSpace(previous: Token | undefined, token: Token): string {
    if (!previous) return "";
    if (token.kind === "punct" && (token.text === "," || token.text === ")" || token.text === ";" || token.text === "." || token.text === "[" || token.text === "]")) return "";
    if (previous.kind === "punct" && (previous.text === "(" || previous.text === "." || previous.text === "[")) return "";
    if (token.kind === "punct" && token.text === "(" && previous.kind === "word" && !SPACED_BEFORE_PAREN.has(previous.text.toUpperCase())) return "";
    if (token.kind === "op" && token.text === "::") return "";
    if (previous.kind === "op" && previous.text === "::") return "";
    return " ";
}

/** Keywords that are followed by a space before an opening bracket (as opposed to a function name, which isn't). */
const SPACED_BEFORE_PAREN = new Set(["IN", "EXISTS", "AND", "OR", "NOT", "ON", "AS", "FROM", "JOIN", "WHERE", "SELECT", "VALUES", "UNION", "ALL", "ANY", "SOME", "USING", "WITH", "BY", "CASE", "WHEN", "THEN", "ELSE", "BETWEEN", "LIKE", "IS", "INTO", "SET", "OVER", "LATERAL", "LIMIT", "OFFSET", "HAVING", "EXCEPT", "INTERSECT", "MINUS", "RETURNING", "CONFLICT", "DISTINCT", "TABLE", "WITHIN", "GROUP", "ORDER", "PARTITION", "FILTER", "UPDATE", "INSERT", "DELETE"]);

/** Flattens a tree back to a token list (groups become their brackets and content). */
export function flatten(nodes: Node[]): Token[] {
    const out: Token[] = [];
    for (const node of nodes) {
        if (isGroup(node)) {
            out.push(node.open, ...flatten(node.items), node.close);
        } else out.push(node);
    }
    return out;
}

export function textOf(nodes: Node[]): string {
    return print(normalize(nodes)).trim();
}

/** Does this token sequence contain a word (at any depth) with one of these names? */
export function containsWord(nodes: Node[], ...names: string[]): boolean {
    return nodes.some((node) => (isGroup(node) ? containsWord(node.items, ...names) : isWord(node, ...names)));
}

// ---- templates --------------------------------------------------------------------------------------------------

/**
 * Builds nodes from PostgreSQL text with nodes of the original query spliced in:
 *   tpl`COALESCE(${a}, ${b})`
 * Fragments are tokenized (so brackets become groups again) and get automatic spacing; spliced nodes keep their own.
 */
export function tpl(strings: TemplateStringsArray, ...values: (Node[] | string)[]): Node[] {
    const args: Node[][] = [];
    let text = "";
    strings.forEach((piece, index) => {
        text += piece;
        if (index < values.length) {
            const value = values[index];
            if (typeof value === "string") text += value;
            else {
                text += ` __arg${args.length}__ `;
                args.push(value);
            }
        }
    });

    const tokens: Token[] = [];
    for (const token of tokenize(text, "db2")) {
        const placeholder = token.kind === "word" ? /^__arg(\d+)__$/.exec(token.text) : null;
        if (placeholder) {
            const flat = flatten(args[Number(placeholder[1])]);
            flat.forEach((inner, index) => tokens.push({ ...inner, ws: index === 0 ? undefined : inner.ws }));
        } else tokens.push({ ...token, ws: undefined });
    }
    return buildTree(tokens);
}

/** The nodes wrapped in brackets, unless they are already a single operand. */
export function paren(nodes: Node[]): Node[] {
    if (nodes.length === 1) return nodes;
    // a function call
    if (nodes.length === 2 && isGroup(nodes[1]) && isToken(nodes[0]) && nodes[0].kind === "word") return nodes;
    // a column path: a.b or a.b.c
    if (nodes.length % 2 === 1 && nodes.every((node, index) => (index % 2 === 0 ? isToken(node) && (node.kind === "word" || node.kind === "ident") : isPunct(node, ".")))) return nodes;
    return [group(normalize(nodes))];
}
