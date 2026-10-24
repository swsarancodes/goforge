import { STATEMENT_TIMEOUT_MS, runReadOnly, type Queryable } from "./pg-read.js";
import { mapError, mapResult, unknownTypeOids, type PgResultLike, type RunError, type StatementResult } from "./sql-run.js";
import { splitSqlStatements } from "./sql-tokens.js";

/**
 * Asks PostgreSQL whether it accepts a query, without running it. EXPLAIN parses, resolves every table, column and
 * function name against the real catalog, type-checks, and plans the statement - and does nothing else, even for
 * INSERT / UPDATE / DELETE / MERGE. It runs inside a READ ONLY transaction that is always rolled back.
 */

export type CheckStatus = "accepted" | "rejected" | "skipped";

export interface StatementCheck {
    index: number;
    /** The start of the statement, for the list in the UI. */
    sql: string;
    status: CheckStatus;
    error?: RunError;
    /** The few words of the statement around the error position. */
    excerpt?: string;
    /** Why a statement wasn't checked. */
    reason?: string;
}

export interface ValidationResult {
    /** rejected if any statement was; accepted if at least one was checked and none rejected; skipped if nothing could be checked. */
    status: CheckStatus;
    statements: StatementCheck[];
    elapsedMs: number;
}

/** `…ELECT nope FROM t…` for position 8: what the error points at, on one line. */
export function excerptAround(text: string, position: number): string {
    const at = Math.max(0, position - 1);
    const from = Math.max(0, at - 24);
    const to = Math.min(text.length, at + 40);
    const cut = text.slice(from, to).replace(/\s+/g, " ");
    return `${from > 0 ? "…" : ""}${cut}${to < text.length ? "…" : ""}`;
}

/** Statement kinds EXPLAIN understands. DDL and session commands can't be checked without running them. */
const EXPLAINABLE = /^(select|insert|update|delete|merge|values|with|table)\b/i;

export const MAX_STATEMENTS = 50;

const EXPLAIN_PREFIX = `BEGIN READ ONLY; SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}; EXPLAIN `;

/** True for errors that are the SQL's fault (they carry a SQLSTATE); anything else is the connection and must not be reported as "rejected". */
export function isSqlError(error: unknown): error is Error & { code: string } {
    const code = (error as { code?: unknown } | undefined)?.code;
    return error instanceof Error && typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && !/^(57P0[123])$/.test(code);
}

/**
 * `run` executes the work on one connection. For a database that rejects a statement, the connection is left in an
 * aborted transaction, so every statement gets its own run (the pool discards the failed client).
 */
export async function validateSql(sql: string, run: <T>(fn: (client: Queryable) => Promise<T>) => Promise<T>): Promise<ValidationResult> {
    const startedAt = performance.now();
    const statements = splitSqlStatements(sql).slice(0, MAX_STATEMENTS);
    const checks: StatementCheck[] = [];

    for (const [index, statement] of statements.entries()) {
        const preview = statement.text.length > 160 ? `${statement.text.slice(0, 157)}...` : statement.text;
        if (!EXPLAINABLE.test(statement.text.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, ""))) {
            checks.push({ index, sql: preview, status: "skipped", reason: "This kind of statement can't be checked without running it." });
            continue;
        }
        try {
            await run((client) => runReadOnly(client, [`EXPLAIN ${statement.text}`]));
            checks.push({ index, sql: preview, status: "accepted" });
        } catch (error) {
            if (!isSqlError(error)) throw error;
            const mapped = mapError(error, EXPLAIN_PREFIX.length, statement.text.length);
            checks.push({ index, sql: preview, status: "rejected", error: mapped, ...(mapped.position ? { excerpt: excerptAround(statement.text, mapped.position) } : {}) });
        }
    }

    const status: CheckStatus = checks.some((check) => check.status === "rejected") ? "rejected" : checks.some((check) => check.status === "accepted") ? "accepted" : "skipped";
    return { status, statements: checks, elapsedMs: Math.round(performance.now() - startedAt) };
}

// ---- a bounded read of what a query returns ---------------------------------------------------------------------------------

export const PREVIEW_ROWS = 100;
export const PREVIEW_TIMEOUT_MS = 15_000;
const CURSOR = "goforge_preview";

/** Every value comes back as the text PostgreSQL printed, whatever its type (no JS dates or numbers to misformat). */
const AS_TEXT = { getTypeParser: () => (value: string) => value };

export type PreviewResult = { ok: true; result: StatementResult; elapsedMs: number } | { ok: false; error: RunError; elapsedMs: number };

/** The first PREVIEW_ROWS rows of a single read query, through a cursor, in a read-only transaction that is rolled back. */
export async function previewQuery(sql: string, run: <T>(fn: (client: Queryable) => Promise<T>) => Promise<T>): Promise<PreviewResult> {
    const startedAt = performance.now();
    const head = `BEGIN READ ONLY; SET LOCAL statement_timeout = ${PREVIEW_TIMEOUT_MS}; DECLARE ${CURSOR} NO SCROLL CURSOR FOR `;
    const text = `${head}${sql}\n; FETCH FORWARD ${PREVIEW_ROWS + 1} FROM ${CURSOR}; CLOSE ${CURSOR}; ROLLBACK`;

    try {
        return await run(async (client) => {
            const raw = (await client.query({ text, rowMode: "array", types: AS_TEXT } as never)) as PgResultLike | PgResultLike[];
            const all = Array.isArray(raw) ? raw : [raw];
            // [BEGIN, SET, DECLARE, FETCH, CLOSE, ROLLBACK]
            const fetched = all[3];
            const typeNames = new Map<number, string>();
            const unknown = fetched ? unknownTypeOids([fetched], typeNames) : [];
            if (unknown.length > 0) {
                const found = (await client.query({ text: "SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])", values: [unknown], rowMode: "array" } as never)) as { rows: [number, string][] };
                for (const [oid, name] of found.rows) typeNames.set(Number(oid), name);
            }
            const mapped = mapResult(fetched ?? { command: "SELECT", rowCount: 0, fields: [], rows: [] }, typeNames);
            const truncated = mapped.rows.length > PREVIEW_ROWS || mapped.truncated;
            return { ok: true as const, result: { ...mapped, rows: mapped.rows.slice(0, PREVIEW_ROWS), truncated }, elapsedMs: Math.round(performance.now() - startedAt) };
        });
    } catch (error) {
        if (!isSqlError(error)) throw error;
        return { ok: false, error: mapError(error, head.length, sql.length), elapsedMs: Math.round(performance.now() - startedAt) };
    }
}

