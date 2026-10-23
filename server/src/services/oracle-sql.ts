import type { ConnectionRow, TransactionState } from "./oracle-types.js";
import { oracledb, oracleConfigOf, withOracle, CALL_TIMEOUT_MS } from "./oracle-client.js";
import { getOracleServer, killOracleSession } from "./oracle-schemas.js";
import { splitOracleScript, type OracleStatement } from "./oracle-script.js";
import type { ConnectionConfig } from "./pg-client.js";
import { truncateCell } from "./pg-data.js";
import { ROW_CAP, type ResultColumn, type RunError, type StatementResult } from "./sql-run.js";

/**
 * Runs SQL on an Oracle schema this app created, for the SQL page. Same result shape as the PostgreSQL runner, so the page shows it the
 * same way. Differences, on purpose: each statement commits as it goes (Oracle commits DDL by itself, and a sandbox schema belongs to its
 * one owner), so there is no open transaction to commit or roll back; and the statements are split here, because the driver runs one at a
 * time (see oracle-script.ts).
 */

const CLOSED: TransactionState = { open: false, hasChanges: false, startedAt: null };

export type OracleRunOutcome =
    | { ok: true; results: StatementResult[]; elapsedMs: number; transaction: TransactionState }
    | { ok: false; error: RunError; results: StatementResult[]; elapsedMs: number; transaction: TransactionState };

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** A DATE or TIMESTAMP as its wall-clock text. The driver hands these over as JS dates in the server's time zone; local getters give back exactly what was stored. */
export function dateText(value: Date): string {
    const base = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    return value.getMilliseconds() ? `${base}.${pad(value.getMilliseconds(), 3).replace(/0+$/, "")}` : base;
}

/** Oracle writes 0.5 as .5 and -0.5 as -.5; write the zero. */
export const numberText = (value: string): string => value.replace(/^(-?)\./, "$10.");

type FetchTypeHandler = NonNullable<oracledb.ExecuteOptions["fetchTypeHandler"]>;

const fetchTypeHandler: FetchTypeHandler = (metaData) => {
    switch (metaData.dbType) {
        // numbers as Oracle prints them, so nothing is lost to a JavaScript double
        case oracledb.DB_TYPE_NUMBER:
        case oracledb.DB_TYPE_BINARY_DOUBLE:
        case oracledb.DB_TYPE_BINARY_FLOAT:
            return { type: oracledb.DB_TYPE_VARCHAR, converter: (value: unknown) => (typeof value === "string" ? numberText(value) : value) };
        case oracledb.DB_TYPE_TIMESTAMP_TZ:
        case oracledb.DB_TYPE_TIMESTAMP_LTZ:
        case oracledb.DB_TYPE_INTERVAL_DS:
        case oracledb.DB_TYPE_INTERVAL_YM:
            return { type: oracledb.DB_TYPE_VARCHAR };
        case oracledb.DB_TYPE_DATE:
        case oracledb.DB_TYPE_TIMESTAMP:
            return { converter: (value: unknown) => (value instanceof Date ? dateText(value) : value) };
        case oracledb.DB_TYPE_CLOB:
        case oracledb.DB_TYPE_NCLOB:
            return { type: oracledb.DB_TYPE_VARCHAR };
        case oracledb.DB_TYPE_BLOB:
        case oracledb.DB_TYPE_RAW:
        case oracledb.DB_TYPE_LONG_RAW:
            return { type: oracledb.DB_TYPE_RAW, converter: (value: unknown) => (Buffer.isBuffer(value) ? `0x${value.subarray(0, 256).toString("hex")}${value.length > 256 ? "…" : ""}` : value) };
        default:
            return undefined;
    }
};

const commandOf = (sql: string): string => {
    const stripped = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "");
    const word = stripped.match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? "";
    return word === "WITH" ? "SELECT" : word;
};

/** The ORA- code and where in the script the error is, for the editor to mark. */
export function mapOracleError(error: unknown, statement: OracleStatement, scriptLength: number): RunError {
    const source = (error ?? {}) as { message?: unknown; errorNum?: unknown; offset?: unknown };
    const message = (typeof source.message === "string" && source.message ? source.message : String(error)).split("\nHelp:")[0].trim();
    const code = typeof source.errorNum === "number" && source.errorNum > 0 ? `ORA-${pad(source.errorNum, 5)}` : /^(ORA|DPI|DPY|NJS)-\d+/.exec(message)?.[0];
    const offset = typeof source.offset === "number" && source.offset >= 0 ? statement.offset + source.offset + 1 : undefined;
    return { message, ...(code ? { code } : {}), ...(offset !== undefined && offset <= scriptLength + 1 ? { position: offset } : {}) };
}

/** A run in progress: how to interrupt it, and why it was stopped if it was. */
interface Running {
    connection: oracledb.Connection;
    stop: () => Promise<void>;
    stoppedBy?: "timeout" | "cancel";
}
const running = new Map<string, Running>();

/** After the driver's own timeout, how long a session may keep running before the admin login ends it. */
export const KILL_GRACE_MS = 3_000;

export const oracleSql = {
    async run(row: ConnectionRow, sessionId: string, script: string, options: { callTimeoutMs?: number; admin?: ConnectionConfig } = {}): Promise<OracleRunOutcome> {
        const startedAt = performance.now();
        const results: StatementResult[] = [];
        const statements = splitOracleScript(script);
        if (statements.length === 0) return { ok: true, results, elapsedMs: 0, transaction: CLOSED };

        const timeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
        const admin = options.admin ?? getOracleServer()?.admin;
        return withOracle(oracleConfigOf(row), async (connection) => {
            const sid = Number(((await connection.execute("SELECT SYS_CONTEXT('USERENV', 'SID') FROM dual")).rows as unknown[][])[0][0]);
            const entry: Running = {
                connection,
                stop: async () => {
                    await connection.break().catch(() => undefined);
                    // break() does not reach everything (a PL/SQL sleep), so after a moment the admin login ends the session
                    await new Promise((done) => setTimeout(done, 1500));
                    if (admin && running.get(`${row.id}:${sessionId}`) === entry) await killOracleSession(admin, row.username, sid).catch(() => undefined);
                },
            };
            running.set(`${row.id}:${sessionId}`, entry);
            const watchdog = setTimeout(() => {
                entry.stoppedBy ??= "timeout";
                if (admin) void killOracleSession(admin, row.username, sid).catch(() => undefined);
            }, timeoutMs + KILL_GRACE_MS);
            let current: OracleStatement = statements[0];
            try {
                for (const statement of statements) {
                    current = statement;
                    const result = await connection.execute(statement.text, [], { autoCommit: true, maxRows: ROW_CAP + 1, fetchTypeHandler });
                    const columns: ResultColumn[] = (result.metaData ?? []).map((column: { name: string; dbTypeName?: string }) => ({ name: column.name, dataType: column.dbTypeName ?? "unknown" }));
                    const raw = (result.rows ?? []) as unknown[][];
                    const truncatedCells: [number, number][] = [];
                    const rows = raw.slice(0, ROW_CAP).map((cells, rowIndex) =>
                        cells.map((cell, columnIndex) => {
                            if (cell === null || cell === undefined) return null;
                            const { value, truncated } = truncateCell(String(cell));
                            if (truncated) truncatedCells.push([rowIndex, columnIndex]);
                            return value;
                        }),
                    );
                    results.push({
                        command: commandOf(statement.text),
                        rowCount: columns.length > 0 ? Math.min(raw.length, ROW_CAP) : (result.rowsAffected ?? null),
                        columns,
                        rows,
                        truncated: raw.length > ROW_CAP,
                        truncatedCells,
                    });
                }
                return { ok: true as const, results, elapsedMs: Math.round(performance.now() - startedAt), transaction: CLOSED };
            } catch (error) {
                const mapped = mapOracleError(error, current, script.length);
                const error_: RunError = entry.stoppedBy === "cancel" ? { message: "Cancelled.", code: "cancelled" } : entry.stoppedBy === "timeout" || /NJS-123/.test(mapped.message) ? { message: `Stopped: it ran longer than ${Math.round(timeoutMs / 1000)} s.`, code: "timeout" } : mapped;
                return { ok: false as const, error: error_, results, elapsedMs: Math.round(performance.now() - startedAt), transaction: CLOSED };
            } finally {
                clearTimeout(watchdog);
                running.delete(`${row.id}:${sessionId}`);
            }
        }, { callTimeoutMs: timeoutMs });
    },

    /** Interrupts what a session is running, if anything. */
    async cancel(rowId: string, sessionId: string): Promise<{ cancelled: boolean }> {
        const entry = running.get(`${rowId}:${sessionId}`);
        if (!entry) return { cancelled: false };
        entry.stoppedBy = "cancel";
        void entry.stop();
        return { cancelled: true };
    },
};
