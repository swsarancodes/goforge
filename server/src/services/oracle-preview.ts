import { fetchTypeHandler, mapOracleError, shapeResult } from "./oracle-sql.js";
import { splitOracleScript } from "./oracle-script.js";
import { PREVIEW_ROWS, PREVIEW_TIMEOUT_MS, type PreviewResult } from "./pg-validate.js";

/**
 * A bounded read of what an Oracle query returns, the counterpart of `previewQuery` for PostgreSQL: one SELECT, the first PREVIEW_ROWS rows,
 * a time limit, and nothing changed. It exists so the Query Modernizer can run the ORIGINAL query next to the converted one without going
 * through the SQL page's runner, which commits every statement it runs.
 *
 * Three layers, so that no one of them has to be perfect: the text must be a single SELECT or WITH statement; it runs in a READ ONLY
 * transaction, in which Oracle itself refuses a write (ORA-01456) whatever the text says; and the transaction is always rolled back.
 */

export { PREVIEW_ROWS, PREVIEW_TIMEOUT_MS };

/** The part of an Oracle connection the preview uses, so it can be tried against a stand-in. */
export interface OracleReader {
    execute(sql: string, binds?: unknown[], options?: Record<string, unknown>): Promise<{ metaData?: unknown[]; rows?: unknown[]; rowsAffected?: number }>;
    rollback(): Promise<void>;
}

const LEADING_COMMENTS = /^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/;

/** One statement, and it starts with SELECT or WITH. */
export function isOracleReadQuery(sql: string): boolean {
    const statements = splitOracleScript(sql);
    return statements.length === 1 && /^(select|with)\b/i.test(statements[0].text.replace(LEADING_COMMENTS, ""));
}

/** Errors that are the connection's, not the query's (the listener, the login, a dropped session): they are thrown, not shown as the query's result. */
const CONNECTION_FAULT = /^ORA-(03113|03114|03135|01033|01034|12\d{3}|28\d{3})\b/;

const timedOut = (error: unknown): boolean => /NJS-123|DPI-1067/.test(error instanceof Error ? error.message : String(error));

/**
 * Oracle refuses (ORA-01466, "table definition has changed") to read a table in a read-only transaction when the table was created or altered
 * in the last moment, because its clock for such changes is coarse. It clears by itself within a couple of seconds, so a query run right after a
 * database was created is tried again instead of being reported as broken.
 */
const TABLE_TOO_NEW = "ORA-01466";
export const SETTLE_ATTEMPTS = 3;
export const SETTLE_MS = 2_000;

export async function previewOracleQuery(sql: string, run: <T>(fn: (connection: OracleReader) => Promise<T>) => Promise<T>, options: { settleMs?: number } = {}): Promise<PreviewResult> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    const settleMs = options.settleMs ?? SETTLE_MS;
    const statements = splitOracleScript(sql);
    if (statements.length !== 1) throw new Error("The preview runs one SELECT at a time.");
    const [statement] = statements;

    return run(async (connection) => {
        for (let attempt = 1; ; attempt++) {
            await connection.execute("SET TRANSACTION READ ONLY");
            try {
                const result = await connection.execute(statement.text, [], { maxRows: PREVIEW_ROWS + 1, fetchTypeHandler });
                return { ok: true as const, result: shapeResult(result, statement.text, PREVIEW_ROWS), elapsedMs: elapsed() };
            } catch (error) {
                if (timedOut(error)) return { ok: false as const, error: { message: `Stopped: it ran longer than ${Math.round(PREVIEW_TIMEOUT_MS / 1000)} s.`, code: "timeout" }, elapsedMs: elapsed() };
                const mapped = mapOracleError(error, statement, sql.length);
                if (!mapped.code || CONNECTION_FAULT.test(mapped.code)) throw error;
                if (mapped.code === TABLE_TOO_NEW && attempt < SETTLE_ATTEMPTS) {
                    await connection.rollback().catch(() => undefined);
                    await new Promise((done) => setTimeout(done, settleMs));
                    continue;
                }
                return { ok: false as const, error: mapped, elapsedMs: elapsed() };
            } finally {
                await connection.rollback().catch(() => undefined);
            }
        }
    });
}
