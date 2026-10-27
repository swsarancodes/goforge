import { differingRows } from "@/features/query-check/differences";
import type { PreviewResponse, PreviewResult } from "@/lib/modernizer-api";
import { compareResultRows, type OutputComparison } from "./compare-output";

/**
 * "Run both": the original query on the Oracle database it was written for and the conversion on PostgreSQL, started together, so the two
 * outputs can be read next to each other. Each side is a bounded, read-only preview (the first 100 rows); neither can change data.
 */

export type Side = { ok: true; result: PreviewResult; elapsedMs: number } | { ok: false; message: string; code?: string; elapsedMs?: number };

export type BothState = { status: "idle" } | { status: "running" } | { status: "done"; oracle: Side; postgres: Side };

const sideOf = async (run: () => Promise<PreviewResponse>): Promise<Side> => {
    const startedAt = performance.now();
    try {
        const response = await run();
        return response.ok ? { ok: true, result: response.result, elapsedMs: response.elapsedMs } : { ok: false, message: response.error.message, code: response.error.code, elapsedMs: response.elapsedMs };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error), elapsedMs: Math.round(performance.now() - startedAt) };
    }
};

/** Starts both queries at once and waits for both. A side that fails (the database says no, or cannot be reached) is a result, not an exception: the other side is still shown. */
export async function runBoth(oracle: () => Promise<PreviewResponse>, postgres: () => Promise<PreviewResponse>): Promise<{ oracle: Side; postgres: Side }> {
    const [first, second] = await Promise.all([sideOf(oracle), sideOf(postgres)]);
    return { oracle: first, postgres: second };
}

/** How the two outputs compare, and which rows of each have no equal on the other side. Nothing when either side did not return rows. */
export function compareSides(oracle: Side, postgres: Side, ignoreOrder: boolean): { comparison: OutputComparison; marked: { left: Set<number>; right: Set<number> } } | undefined {
    if (!oracle.ok || !postgres.ok) return undefined;
    return {
        comparison: compareResultRows(oracle.result, postgres.result, { ignoreOrder }),
        marked: differingRows(oracle.result.rows, postgres.result.rows, ignoreOrder),
    };
}

/** With no ORDER BY the databases promise no order, so rows are compared as a set; with one, row by row. */
export const defaultIgnoreOrder = (originalSql: string): boolean => !/\border\s+by\b/i.test(originalSql);

/** One side in a sentence: "Oracle returned 7 rows in 32 ms", or "Oracle failed in 16 ms" when it returned none. */
export const sideSummary = (name: string, side: Side): string => {
    const time = side.elapsedMs === undefined ? "" : ` in ${side.elapsedMs} ms`;
    if (!side.ok) return `${name} failed${time}`;
    const count = side.result.rows.length;
    return `${name} returned ${count}${side.result.truncated ? "+" : ""} row${count === 1 && !side.result.truncated ? "" : "s"}${time}`;
};

/** The original takes "the first N rows" (ROWNUM, FETCH FIRST, LIMIT) without an ORDER BY, so which N rows come back is up to each database. */
export const takesUnorderedFirstRows = (originalSql: string): boolean => /\b(rownum|fetch\s+first|limit)\b/i.test(originalSql) && !/\border\s+by\b/i.test(originalSql);

/** PostgreSQL's "relation does not exist" after tables were renamed in a migration: the conversion still uses the old names. */
export const postgresHint = (side: Side): string | undefined =>
    !side.ok && side.code === "42P01" ? "If you renamed tables when you migrated, the converted query needs their new names. Run the Oracle query on the Query check page, which applies the names the migration changed." : undefined;

/** The original is a SELECT (or WITH): the only thing "run both" runs, because it only ever reads. The server checks again; this is so the button can say why it is off. */
export const isSelectQuery = (sql: string): boolean => /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(select|with)\b/i.test(sql);

/** Why "run both" cannot start yet, in a sentence; undefined when it can. `previewBlocker` is the reason the PostgreSQL side cannot run, if there is one. */
export function runBothBlocker(input: { dialect: string; oracleDatabases: number; oracleChosen: boolean; originalIsSelect: boolean; bindsInOriginal: boolean; previewBlocker: string | undefined }): string | undefined {
    if (input.dialect !== "oracle") return "Running the original needs a query written for Oracle.";
    if (input.oracleDatabases === 0) return "Create an Oracle database in GoForge to run the original on.";
    if (!input.oracleChosen) return "Choose the Oracle database to run the original on.";
    if (!input.originalIsSelect) return "Run both only runs a SELECT, because it reads and changes nothing. Use the SQL Editor for anything else.";
    if (input.bindsInOriginal) return "The original has bind variables (:name). Replace them with values first.";
    return input.previewBlocker;
}
