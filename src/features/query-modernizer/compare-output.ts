/**
 * Checks what the converted query returns on PostgreSQL against what the original returned on the old database, which the person pastes
 * in (the app has no connection to Oracle, SQL Server or DB2). It compares values, not formatting: the same number written 100 and
 * 100.00, the same date written 15-JAN-24 and 2024-01-15 00:00:00, and NULL written NULL, (null) or nothing at all are the same cell.
 */

export interface ExpectedOutput {
    columns: string[];
    rows: string[][];
}

const NULL_WORDS = new Set(["", "null", "(null)", "[null]", "<null>"]);

/** Split one CSV record, honouring quotes ("" inside quotes is a quote). */
function splitCsv(line: string): string[] {
    const cells: string[] = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
        const character = line[index];
        if (quoted) {
            if (character === '"') {
                if (line[index + 1] === '"') {
                    current += '"';
                    index++;
                } else quoted = false;
            } else current += character;
        } else if (character === '"') quoted = true;
        else if (character === ",") {
            cells.push(current);
            current = "";
        } else current += character;
    }
    cells.push(current);
    return cells;
}

/** Footers and rulers the old tools print around the rows: `12 rows selected.`, `(12 rows)`, `-----+-----`, `+----+----+`. */
const isNoise = (line: string): boolean => /^\s*\(?\d+ rows?( selected)?\)?\.?\s*$/i.test(line) || /^[\s\-+=|]*[-=][\s\-+=|]*$/.test(line) || /^\s*no rows selected\.?\s*$/i.test(line);
const isBlank = (line: string): boolean => /^\s*$/.test(line);

/**
 * Reads pasted rows: tab separated (copied from a grid), pipe separated (SQL*Plus, psql), or comma separated (CSV export). The first
 * line names the columns. A blank line in the middle is a row only when there is one column (an empty or NULL value prints as nothing).
 */
export function parseExpectedOutput(text: string): ExpectedOutput | { error: string } {
    const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => !isNoise(line));
    while (lines.length > 0 && isBlank(lines[0])) lines.shift();
    while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
    if (lines.length === 0) return { error: "Paste the rows the original query returned, with the column names on the first line." };

    const content = lines.filter((line) => !isBlank(line));
    const delimiter = content.some((line) => line.includes("\t")) ? "tab" : content.filter((line) => line.includes("|")).length >= Math.max(1, content.length - 1) ? "pipe" : "comma";
    const split = (line: string): string[] =>
        delimiter === "tab" ? line.split("\t").map((cell) => cell.trim()) : delimiter === "pipe" ? line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim()) : splitCsv(line).map((cell) => cell.trim());

    const header = split(lines[0]);
    if (header.length === 0 || header.every((name) => name === "")) return { error: "The first line should be the column names." };
    const body = lines.slice(1).flatMap((line) => (isBlank(line) ? (header.length === 1 ? [[""]] : []) : [split(line)]));
    const wrong = body.findIndex((row) => row.length !== header.length);
    if (wrong >= 0) return { error: `Row ${wrong + 1} has ${body[wrong].length} values but there are ${header.length} columns. Check the separator.` };
    return { columns: header, rows: body };
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const pad = (value: number | string, width = 2) => String(value).padStart(width, "0");

/** One comparable form of a cell, or `null` for NULL. */
export function normalizeCell(raw: string | null | undefined): string | null {
    const text = (raw ?? "").trim();
    if (NULL_WORDS.has(text.toLowerCase())) return null;

    // numbers by value, to nine significant digits
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
        const value = Number(text);
        if (Number.isFinite(value)) return `n:${Number(value.toPrecision(9))}`;
    }

    // 2024-01-15, 2024-01-15 10:30:00, 2024-01-15T10:30:00.000Z, with or without a zone: a date is midnight, fractions of a second of zero are nothing
    let match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i);
    if (match) {
        const fraction = match[7] && /[1-9]/.test(match[7]) ? `.${match[7].replace(/0+$/, "")}` : "";
        return `d:${match[1]}-${match[2]}-${match[3]} ${match[4] ?? "00"}:${match[5] ?? "00"}:${match[6] ?? "00"}${fraction}`;
    }
    // Oracle's default: 15-JAN-24 or 15-JAN-2024, optionally with a time
    match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
    if (match) {
        const month = MONTHS.indexOf(match[2].toUpperCase());
        if (month >= 0) {
            const year = match[3].length === 2 ? (Number(match[3]) >= 50 ? 1900 : 2000) + Number(match[3]) : Number(match[3]);
            return `d:${year}-${pad(month + 1)}-${pad(match[1])} ${match[4] ?? "00"}:${match[5] ?? "00"}:${match[6] ?? "00"}`;
        }
    }
    return `s:${text}`;
}

export interface CellDifference {
    /** 1-based row of the expected output. */
    row: number;
    column: string;
    expected: string;
    actual: string;
}

export interface OutputComparison {
    matches: boolean;
    /** Column names or count that differ, in words. */
    columnProblem?: string;
    expectedRows: number;
    actualRows: number;
    /** Rows in one output with no counterpart in the other (when order is ignored). */
    missing: string[][];
    extra: string[][];
    /** Cells that differ in rows that line up (when order matters). */
    differences: CellDifference[];
    /** Only the first rows of the PostgreSQL result were read, so only that many were checked. */
    partial: boolean;
}

export interface ActualOutput {
    columns: string[];
    rows: (string | null)[][];
    /** There were more rows than were read. */
    truncated: boolean;
}

export const MAX_REPORTED = 20;

const rowKey = (row: (string | null)[]) => JSON.stringify(row.map(normalizeCell));

export function compareOutput(expected: ExpectedOutput, actual: ActualOutput, options: { ignoreOrder: boolean }): OutputComparison {
    const result: OutputComparison = { matches: false, expectedRows: expected.rows.length, actualRows: actual.rows.length, missing: [], extra: [], differences: [], partial: false };

    const names = (columns: string[]) => columns.map((name) => name.trim().toLowerCase());
    if (expected.columns.length !== actual.columns.length) {
        result.columnProblem = `The original returned ${expected.columns.length} column${expected.columns.length === 1 ? "" : "s"} (${expected.columns.join(", ")}) and PostgreSQL ${actual.columns.length} (${actual.columns.map((column) => column.trim()).join(", ")}).`;
    } else if (names(expected.columns).join("\u0000") !== names(actual.columns).join("\u0000")) {
        const differing = expected.columns.map((name, index) => [name, actual.columns[index]] as const).filter(([a, b]) => a.trim().toLowerCase() !== b.trim().toLowerCase());
        result.columnProblem = `Column names differ (compared without regard to case): ${differing.map(([a, b]) => `${a} / ${b}`).join(", ")}. The values below are matched by position.`;
    }
    if (expected.columns.length !== actual.columns.length) return result;

    // With more rows on the database than were read, only those can be checked, and only in order.
    const ordered = !options.ignoreOrder || actual.truncated;
    if (actual.truncated) result.partial = true;
    const wanted = actual.truncated ? expected.rows.slice(0, actual.rows.length) : expected.rows;

    if (ordered) {
        const rows = Math.max(wanted.length, actual.rows.length);
        for (let index = 0; index < rows; index++) {
            const left = wanted[index];
            const right = actual.rows[index];
            if (!left) {
                result.extra.push((right ?? []).map((cell) => cell ?? "NULL"));
                continue;
            }
            if (!right) {
                result.missing.push(left);
                continue;
            }
            left.forEach((cell, column) => {
                if (normalizeCell(cell) !== normalizeCell(right[column]) && result.differences.length < MAX_REPORTED * 5) {
                    result.differences.push({ row: index + 1, column: expected.columns[column], expected: cell === "" ? "(empty)" : cell, actual: right[column] === null ? "NULL" : right[column] === "" ? "(empty)" : right[column]! });
                }
            });
        }
    } else {
        const counts = new Map<string, { count: number; row: string[] }>();
        for (const row of expected.rows) {
            const key = rowKey(row);
            counts.set(key, { count: (counts.get(key)?.count ?? 0) + 1, row });
        }
        for (const row of actual.rows) {
            const key = rowKey(row);
            const entry = counts.get(key);
            if (entry && entry.count > 0) entry.count--;
            else result.extra.push(row.map((cell) => cell ?? "NULL"));
        }
        for (const { count, row } of counts.values()) for (let copy = 0; copy < count; copy++) result.missing.push(row);
    }

    const rowsDiffer = result.missing.length > 0 || result.extra.length > 0 || result.differences.length > 0;
    result.matches = !rowsDiffer && (actual.truncated ? true : expected.rows.length === actual.rows.length);
    return result;
}
