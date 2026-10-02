/**
 * Reads CHECK constraints straight out of CREATE TABLE / ALTER TABLE text.
 *
 * The SQL parsers hand back an expression tree, but a stored check has to round-trip
 * as the text the user wrote - re-serializing a tree would normalize `price>0` into
 * `price > 0` and make every "apply unchanged SQL" look like an edit. So the expression
 * is sliced out of the source by walking parentheses, skipping quotes and comments.
 */

export interface ExtractedCheck {
    /** Constraint name, when the SQL gave one. */
    name?: string;
    expression: string;
}

export interface ExtractedAlterCheck extends ExtractedCheck {
    /** Table identifier as written, with quoting removed (may be schema-qualified). */
    tableName: string;
}

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|\`(?:[^\`]|\`\`)+\`|\[[^\]]+\]|[A-Za-z_][\w$]*)`;

const stripQuotes = (identifier: string): string => {
    const first = identifier[0];
    if (first === '"') return identifier.slice(1, -1).replace(/""/g, '"');
    if (first === "`") return identifier.slice(1, -1).replace(/``/g, "`");
    if (first === "[") return identifier.slice(1, -1);
    return identifier;
};

/**
 * Replaces the contents of string literals, quoted identifiers and comments with
 * filler characters of the same length, so structural scanning (parentheses, commas,
 * keywords) can run on the mask while slices are still taken from the original.
 */
const maskQuoted = (sql: string): string => {
    const out = sql.split("");
    let index = 0;
    const blank = (from: number, to: number) => {
        for (let position = from; position < to && position < out.length; position++) {
            if (out[position] !== "\n") out[position] = "_";
        }
    };
    while (index < sql.length) {
        const character = sql[index];
        const next = sql[index + 1];
        if (character === "'" || character === '"' || character === "`") {
            let cursor = index + 1;
            while (cursor < sql.length) {
                if (sql[cursor] === character) {
                    if (sql[cursor + 1] === character) { cursor += 2; continue; }
                    break;
                }
                cursor += 1;
            }
            blank(index + 1, cursor);
            index = cursor + 1;
        } else if (character === "[") {
            const end = sql.indexOf("]", index + 1);
            if (end === -1) break;
            blank(index + 1, end);
            index = end + 1;
        } else if (character === "-" && next === "-") {
            const end = sql.indexOf("\n", index);
            blank(index, end === -1 ? sql.length : end);
            index = end === -1 ? sql.length : end;
        } else if (character === "/" && next === "*") {
            const end = sql.indexOf("*/", index + 2);
            blank(index, end === -1 ? sql.length : end + 2);
            index = end === -1 ? sql.length : end + 2;
        } else {
            index += 1;
        }
    }
    return out.join("");
};

/** Index of the `)` matching the `(` at `open`, scanning the masked text. */
const matchingParen = (masked: string, open: number): number => {
    let depth = 0;
    for (let index = open; index < masked.length; index++) {
        if (masked[index] === "(") depth += 1;
        else if (masked[index] === ")") {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
};

/** Splits on commas that sit at parenthesis depth 0 (offsets into `masked`). */
const splitTopLevel = (masked: string, from: number, to: number): { start: number; end: number }[] => {
    const parts: { start: number; end: number }[] = [];
    let depth = 0;
    let start = from;
    for (let index = from; index < to; index++) {
        const character = masked[index];
        if (character === "(") depth += 1;
        else if (character === ")") depth -= 1;
        else if (character === "," && depth === 0) {
            parts.push({ start, end: index });
            start = index + 1;
        }
    }
    parts.push({ start, end: to });
    return parts;
};

const CHECK_KEYWORD = new RegExp(String.raw`(?:\bCONSTRAINT\s+(${IDENTIFIER})\s+)?\bCHECK\s*\(`, "gi");

/**
 * CHECK constraints of one column/constraint definition: handles
 * `CONSTRAINT n CHECK (...)`, bare `CHECK (...)`, and checks trailing a column
 * definition (`price INT NOT NULL CHECK (price > 0)`).
 */
const checksInDefinition = (original: string, masked: string): ExtractedCheck[] => {
    const found: ExtractedCheck[] = [];
    CHECK_KEYWORD.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CHECK_KEYWORD.exec(masked)) !== null) {
        const open = match.index + match[0].length - 1;
        const close = matchingParen(masked, open);
        if (close === -1) break;
        const rawName = match[1] ? original.slice(match.index, match.index + match[0].length).match(new RegExp(String.raw`CONSTRAINT\s+(${IDENTIFIER})`, "i"))?.[1] : undefined;
        found.push({
            name: rawName ? stripQuotes(rawName) : undefined,
            expression: original.slice(open + 1, close).trim(),
        });
        CHECK_KEYWORD.lastIndex = close + 1;
    }
    return found;
};

/** All CHECK constraints (table- and column-level) declared in a CREATE TABLE statement. */
export function extractChecksFromCreateTable(statement: string): ExtractedCheck[] {
    const masked = maskQuoted(statement);
    const open = masked.indexOf("(");
    if (open === -1) return [];
    const close = matchingParen(masked, open);
    if (close === -1) return [];

    const checks: ExtractedCheck[] = [];
    for (const { start, end } of splitTopLevel(masked, open + 1, close)) {
        const original = statement.slice(start, end);
        const maskedPart = masked.slice(start, end);
        // Nested parentheses only matter inside the CHECK itself, which the regex
        // walk handles; a definition like `a INT DEFAULT (1) CHECK (a > 0)` still works
        // because matching starts at the CHECK keyword.
        checks.push(...checksInDefinition(original, maskedPart));
    }
    return checks;
}

const ALTER_ADD_CHECK = new RegExp(
    String.raw`^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?((?:${IDENTIFIER}\s*\.\s*)*${IDENTIFIER})\s+ADD\s+(?:CONSTRAINT\s+(${IDENTIFIER})\s+)?CHECK\s*\(`,
    "i",
);

/** `ALTER TABLE t ADD [CONSTRAINT n] CHECK (...)`, or undefined for any other statement. */
export function extractCheckFromAlterTable(statement: string): ExtractedAlterCheck | undefined {
    const masked = maskQuoted(statement);
    const match = masked.match(ALTER_ADD_CHECK);
    if (!match) return undefined;
    // Re-run on the original so the identifier text keeps its real characters.
    const original = statement.match(ALTER_ADD_CHECK);
    if (!original) return undefined;
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingParen(masked, open);
    if (close === -1) return undefined;
    const tableParts = original[1].split(/\s*\.\s*/).map(stripQuotes);
    return {
        tableName: tableParts.join("."),
        name: original[2] ? stripQuotes(original[2]) : undefined,
        expression: statement.slice(open + 1, close).trim(),
    };
}
