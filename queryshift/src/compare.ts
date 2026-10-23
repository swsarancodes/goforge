/**
 * Deterministic comparison of what the legacy query is known to return against what the converted query returns on PostgreSQL.
 * The defaults are the QueryShift challenge's (challenge_requirements.json, comparison_defaults):
 *   - row order is ignored (a case can ask for it: orderSensitive),
 *   - duplicates are kept: rows are compared as a multiset,
 *   - NULL equals NULL and nothing else (an empty string is not NULL),
 *   - numbers are compared rounded to 6 decimal places.
 * Where this is stricter than the starter pack's validator.py: a timestamp keeps its time of day (validator.py cuts it to the date, which
 * would hide exactly the Oracle DATE-with-time mistakes this challenge is about), and each value is compared as the type PostgreSQL says
 * the column has, so a text '007' never equals the number 7.
 */

export type Category = "number" | "date" | "timestamp" | "boolean" | "text";

export interface ExpectedTable {
    columns: string[];
    /** Cells as written in the reference file; an empty cell is NULL. */
    rows: (string | null)[][];
}

export interface ActualTable {
    columns: { name: string; category: Category; /** PostgreSQL's type id, when known. */ typeOid?: number }[];
    /** Every value as PostgreSQL printed it (text), or null. */
    rows: (string | null)[][];
    /** More rows exist than were read: nothing can be proved from a part of a result. */
    truncated: boolean;
}

export interface Comparison {
    passed: boolean;
    expectedRows: number;
    actualRows: number;
    /** Expected rows with no counterpart in the actual result (first 20), as written. */
    missing: (string | null)[][];
    /** Actual rows with no counterpart in the expected result (first 20). */
    additional: (string | null)[][];
    missingCount: number;
    additionalCount: number;
    /** Same rows, different order, in a case where the order matters. */
    orderProblem?: string;
    /** Column names or count differ. */
    columnProblem?: string;
    message: string;
}

const REPORTED = 20;

/** The OIDs PostgreSQL gives its numeric types, dates and timestamps. Everything else is compared as text. */
export function categoryOf(oid: number): Category {
    if ([20, 21, 23, 700, 701, 1700].includes(oid)) return "number";
    if (oid === 1082) return "date";
    if (oid === 1114 || oid === 1184) return "timestamp";
    if (oid === 16) return "boolean";
    return "text";
}

const UNPARSEABLE = (cell: string) => `\u0000unparseable:${cell}`;

/** A comparable form of one cell, or null for NULL. A cell that cannot be read as its column's type becomes a value nothing else equals. */
export function normalizeCell(cell: string | null | undefined, category: Category): string | null {
    if (cell === null || cell === undefined) return null;
    const text = String(cell);
    switch (category) {
        case "number": {
            const value = Number(text.trim());
            if (text.trim() === "" || !Number.isFinite(value)) return UNPARSEABLE(text);
            const rounded = Number(value.toFixed(6));
            return `n:${Object.is(rounded, -0) ? 0 : rounded}`;
        }
        case "date": {
            const match = text.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T]00:00:00(?:\.0+)?)?$/);
            return match ? `d:${match[1]}` : UNPARSEABLE(text);
        }
        case "timestamp": {
            const match = text.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?)?\s*(?:Z|[+-]00(?::?00)?)?$/i);
            if (!match) return UNPARSEABLE(text);
            const fraction = match[3] && /[1-9]/.test(match[3]) ? `.${match[3].replace(/0+$/, "")}` : "";
            return `t:${match[1]} ${match[2] ?? "00:00:00"}${fraction}`;
        }
        case "boolean": {
            const word = text.trim().toLowerCase();
            if (["t", "true", "1"].includes(word)) return "b:true";
            if (["f", "false", "0"].includes(word)) return "b:false";
            return UNPARSEABLE(text);
        }
        default:
            return `s:${text}`;
    }
}

const key = (row: (string | null)[], categories: Category[]) => JSON.stringify(row.map((cell, index) => normalizeCell(cell, categories[index])));

export function compareResults(expected: ExpectedTable, actual: ActualTable, options: { orderSensitive?: boolean } = {}): Comparison {
    const base = { expectedRows: expected.rows.length, actualRows: actual.rows.length, missing: [], additional: [], missingCount: 0, additionalCount: 0 };
    const fail = (message: string, extra: Partial<Comparison> = {}): Comparison => ({ ...base, passed: false, message, ...extra });

    const expectedNames = expected.columns.map((name) => name.trim().toLowerCase());
    const actualNames = actual.columns.map((column) => column.name.trim().toLowerCase());
    if (expectedNames.join("\u0000") !== actualNames.join("\u0000")) {
        const problem = `Column mismatch. Expected [${expectedNames.join(", ")}]; got [${actualNames.join(", ")}].`;
        return fail(problem, { columnProblem: problem });
    }
    if (actual.truncated) return fail("The result was cut off at the row limit, so equivalence cannot be proved.");

    const categories = actual.columns.map((column) => column.category);
    const counts = new Map<string, { count: number; row: (string | null)[] }>();
    for (const row of expected.rows) {
        const k = key(row, categories);
        counts.set(k, { count: (counts.get(k)?.count ?? 0) + 1, row });
    }
    const additional: (string | null)[][] = [];
    for (const row of actual.rows) {
        const entry = counts.get(key(row, categories));
        if (entry && entry.count > 0) entry.count--;
        else additional.push(row);
    }
    const missing: (string | null)[][] = [];
    for (const { count, row } of counts.values()) for (let copy = 0; copy < count; copy++) missing.push(row);

    if (missing.length > 0 || additional.length > 0) {
        return {
            ...base,
            passed: false,
            missing: missing.slice(0, REPORTED),
            additional: additional.slice(0, REPORTED),
            missingCount: missing.length,
            additionalCount: additional.length,
            message: `${missing.length} expected row(s) missing, ${additional.length} unexpected row(s) returned.`,
        };
    }

    if (options.orderSensitive) {
        for (let index = 0; index < expected.rows.length; index++) {
            if (key(expected.rows[index], categories) !== key(actual.rows[index], categories)) {
                const problem = `Same rows, but the order differs from row ${index + 1}: expected ${JSON.stringify(expected.rows[index])}, got ${JSON.stringify(actual.rows[index])}.`;
                return fail(problem, { orderProblem: problem });
            }
        }
    }
    return { ...base, passed: true, message: "Results are equivalent." };
}

/** RFC 4180 reader: quoted fields, doubled quotes, commas and line breaks inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (quoted) {
            if (character === '"') {
                if (text[index + 1] === '"') {
                    cell += '"';
                    index++;
                } else quoted = false;
            } else cell += character;
        } else if (character === '"') quoted = true;
        else if (character === ",") {
            row.push(cell);
            cell = "";
        } else if (character === "\n" || character === "\r") {
            if (character === "\r" && text[index + 1] === "\n") index++;
            row.push(cell);
            cell = "";
            rows.push(row);
            row = [];
        } else cell += character;
    }
    if (cell !== "" || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function parseExpected(csv: string): ExpectedTable {
    const [header, ...body] = parseCsv(csv);
    if (!header) throw new Error("The expected-result file is empty: the first line must name the columns.");
    for (const [index, row] of body.entries()) {
        if (row.length !== header.length) throw new Error(`Expected-result row ${index + 1} has ${row.length} values but there are ${header.length} columns.`);
    }
    return { columns: header, rows: body.map((row) => row.map((cell) => (cell === "" ? null : cell))) };
}
