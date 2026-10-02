import { InferInsertModel, InferSelectModel, relations } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tables } from "./table-schema";

/**
 * A named table-level CHECK constraint. `expression` is the boolean SQL expression
 * exactly as it appears between the parentheses of `CHECK (...)`, so it round-trips
 * through every dialect without being re-serialized.
 */
export const check_constraints = sqliteTable("check_constraints", {
    id: text("id").primaryKey().notNull().unique(),
    tableId: text("tableId").notNull().references(() => tables.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    expression: text("expression").notNull(),
    createdAt: text("createdAt"),
});

export const checkConstraintRelations = relations(check_constraints, ({ one }) => ({
    table: one(tables, {
        fields: [check_constraints.tableId],
        references: [tables.id],
    }),
}));

export interface CheckConstraintType extends InferSelectModel<typeof check_constraints> {}
export interface CheckConstraintInsertType extends InferInsertModel<typeof check_constraints> {}

/** Accept the row-array shape used by the app and the id-keyed shape used by diffs. */
export function checkConstraintValues<T>(value: T[] | Record<string, T> | undefined | null): T[] {
    if (!value) return [];
    return Array.isArray(value) ? value : Object.values(value);
}

export const CHECK_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Scans SQL text, calling `visit` for every character that is NOT inside a string
 * literal, quoted identifier, or comment. Returns the first problem found while
 * scanning (unterminated quote/comment), or undefined.
 */
const scanUnquoted = (sql: string, visit: (character: string, index: number) => boolean | void): string | undefined => {
    let index = 0;
    while (index < sql.length) {
        const character = sql[index];
        const next = sql[index + 1];

        if (character === "'" || character === '"' || character === "`") {
            // Doubled quote is an escaped quote inside the literal.
            let cursor = index + 1;
            for (;;) {
                if (cursor >= sql.length) return "contains an unterminated quote";
                if (sql[cursor] === character) {
                    if (sql[cursor + 1] === character) { cursor += 2; continue; }
                    break;
                }
                cursor += 1;
            }
            index = cursor + 1;
            continue;
        }
        if (character === "[") {
            const end = sql.indexOf("]", index + 1);
            if (end === -1) return "contains an unterminated [identifier]";
            index = end + 1;
            continue;
        }
        if (character === "-" && next === "-") return "must not contain comments";
        if (character === "/" && next === "*") return "must not contain comments";
        if (character === "#") return "must not contain comments";

        if (visit(character, index) === false) return undefined;
        index += 1;
    }
    return undefined;
};

/**
 * Validates a CHECK expression before it is stored or spliced into DDL. The text is
 * emitted verbatim, so anything that could end the statement or hide the closing
 * parenthesis (a `;`, a comment, unbalanced parentheses) is rejected up front.
 * Returns an error message, or undefined when the expression is acceptable.
 */
export function validateCheckExpression(expression: string | null | undefined): string | undefined {
    const trimmed = (expression ?? "").trim();
    if (!trimmed) return "Expression is required.";

    let depth = 0;
    let problem: string | undefined;
    const scanProblem = scanUnquoted(trimmed, (character) => {
        if (character === ";") { problem = "must be a single expression (no semicolons)"; return false; }
        if (character === "(") depth += 1;
        if (character === ")") {
            depth -= 1;
            if (depth < 0) { problem = "has an unmatched closing parenthesis"; return false; }
        }
    });
    if (scanProblem) return `Expression ${scanProblem}.`;
    if (problem) return `Expression ${problem}.`;
    if (depth !== 0) return "Expression has unbalanced parentheses.";
    return undefined;
}

export function validateCheckName(name: string | null | undefined): string | undefined {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return "Name is required.";
    if (!CHECK_NAME_PATTERN.test(trimmed)) return "Name may only contain letters, digits, underscores and $, and must not start with a digit.";
    if (trimmed.length > 63) return "Name must be 63 characters or fewer.";
    return undefined;
}

/**
 * Whitespace/punctuation-insensitive form of an expression, used only to decide
 * whether two expressions mean the same thing after a formatter or SQL round trip
 * (`price>0` vs `price > 0`, or a line-wrapped AND chain). Quoted text is kept
 * verbatim and keyword/identifier case is preserved.
 */
export function canonicalCheckExpression(expression: string): string {
    const tokens: string[] = [];
    let word = "";
    const flush = () => { if (word) { tokens.push(word); word = ""; } };
    let index = 0;
    const text = expression.trim();
    while (index < text.length) {
        const character = text[index];
        if (character === "'" || character === '"' || character === "`") {
            flush();
            let cursor = index + 1;
            while (cursor < text.length) {
                if (text[cursor] === character) {
                    if (text[cursor + 1] === character) { cursor += 2; continue; }
                    break;
                }
                cursor += 1;
            }
            tokens.push(text.slice(index, cursor + 1));
            index = cursor + 1;
        } else if (/\s/.test(character)) {
            flush();
            tokens.push(" ");
            index += 1;
        } else if (/[A-Za-z0-9_$.]/.test(character)) {
            word += character;
            index += 1;
        } else {
            flush();
            tokens.push(character);
            index += 1;
        }
    }
    flush();

    // Keep a single space only between two word-like tokens; drop it next to punctuation.
    const isWord = (token: string | undefined) => token !== undefined && /^[A-Za-z0-9_$.]/.test(token);
    const out: string[] = [];
    for (let position = 0; position < tokens.length; position++) {
        if (tokens[position] !== " ") { out.push(tokens[position]); continue; }
        const previous = out[out.length - 1];
        let upcoming: string | undefined;
        for (let lookahead = position + 1; lookahead < tokens.length; lookahead++) {
            if (tokens[lookahead] !== " ") { upcoming = tokens[lookahead]; break; }
        }
        const quoted = (token: string | undefined) => token !== undefined && /^['"`]/.test(token);
        if ((isWord(previous) || quoted(previous)) && (isWord(upcoming) || quoted(upcoming)) && out[out.length - 1] !== " ") out.push(" ");
    }
    return out.join("");
}

/** Next unused `chk_<table>_<n>` name for a table. */
export function nextCheckName(tableName: string, existing: { name: string }[]): string {
    const taken = new Set(existing.map((check) => check.name.toLowerCase()));
    const base = `chk_${tableName.replace(/[^A-Za-z0-9_$]/g, "_")}`;
    for (let counter = existing.length + 1; ; counter++) {
        const candidate = `${base}_${counter}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
}

/**
 * Full validation for a check about to be persisted: name rules, expression rules, and
 * name uniqueness among the table's other checks (constraint names must be unique in
 * most dialects). Returns an error message or undefined.
 */
export function validateCheck(
    check: { id?: string; name: string | null | undefined; expression: string | null | undefined },
    siblings: { id: string; name: string }[],
): string | undefined {
    const nameProblem = validateCheckName(check.name);
    if (nameProblem) return nameProblem;
    const expressionProblem = validateCheckExpression(check.expression);
    if (expressionProblem) return expressionProblem;
    const duplicate = siblings.some((sibling) => sibling.id !== check.id && sibling.name.toLowerCase() === (check.name as string).trim().toLowerCase());
    if (duplicate) return `A check named "${(check.name as string).trim()}" already exists on this table.`;
    return undefined;
}
