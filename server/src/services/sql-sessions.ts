import { Client } from "pg";
import type { ConnectionRow } from "../db/store.js";
import { sslOption, toConnectionConfig, withPgClient } from "./pg-client.js";
import { isConnectionLost } from "./pg-pool.js";
import {
    ROW_CAP,
    SAVEPOINT,
    buildRunBatch,
    changesData,
    extractResults,
    mapError,
    mapResult,
    unknownTypeOids,
    type PgResultLike,
    type RunError,
    type StatementResult,
} from "./sql-run.js";
import { findTransactionControl, isSingleReadQuery, splitSqlStatements } from "./sql-tokens.js";

export const SESSION_IDLE_MS = 5 * 60_000;
export const MAX_SESSIONS = 5;
/** After asking Postgres to cancel, how long a statement may keep running before the connection is dropped instead. */
export const CANCEL_GRACE_MS = 3_000;

export class SqlSessionError extends Error {
    constructor(
        message: string,
        public status: number,
        public code?: string,
    ) {
        super(message);
        this.name = "SqlSessionError";
    }
}

/** The slice of a pg client a session needs (so it can be tested with a fake). */
export interface SessionClient {
    query(config: string | { text: string; values?: unknown[]; rowMode?: "array" }): Promise<unknown>;
    end(): Promise<void>;
    /** Drops the socket without waiting for the running statement. */
    destroy(): void;
    onError(listener: (error: Error) => void): void;
}

export interface TransactionState {
    open: boolean;
    hasChanges: boolean;
    startedAt: number | null;
}

export type RunOutcome =
    | { ok: true; results: StatementResult[]; elapsedMs: number; transaction: TransactionState }
    | { ok: false; error: RunError; results: StatementResult[]; elapsedMs: number; transaction: TransactionState; transactionLost?: boolean };

export interface SqlSessionDeps {
    connect: (row: ConnectionRow) => Promise<SessionClient>;
    /** Asks the server to cancel what a backend is running (best effort). */
    cancelBackend?: (row: ConnectionRow, pid: number) => Promise<void>;
    now?: () => number;
    idleMs?: number;
    maxSessions?: number;
    cancelGraceMs?: number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

interface Session {
    id: string;
    connectionId: string;
    client: SessionClient;
    inTransaction: boolean;
    hasChanges: boolean;
    startedAt: number | null;
    busy: boolean;
    closed: boolean;
    backendPid?: number;
    typeNames: Map<number, string>;
    idleTimer?: unknown;
    lastUsed: number;
}

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
// Cursor could not be used for this statement: run it as written instead.
const CURSOR_FALLBACK_CODES = new Set(["0A000", "42601", "42P11"]);

/**
 * Dedicated database connections for the SQL editor, one per editor session. A run happens inside a transaction that
 * stays open between requests until the user commits or rolls back; idle sessions are rolled back and closed.
 */
export class SqlSessions {
    private readonly sessions = new Map<string, Session>();
    private readonly now: () => number;
    private readonly idleMs: number;
    private readonly maxSessions: number;
    private readonly cancelGraceMs: number;
    private readonly setTimer: (callback: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;

    constructor(private readonly deps: SqlSessionDeps) {
        this.now = deps.now ?? Date.now;
        this.idleMs = deps.idleMs ?? SESSION_IDLE_MS;
        this.maxSessions = deps.maxSessions ?? MAX_SESSIONS;
        this.cancelGraceMs = deps.cancelGraceMs ?? CANCEL_GRACE_MS;
        this.setTimer =
            deps.setTimer ??
            ((callback, ms) => {
                const handle = setTimeout(callback, ms);
                handle.unref?.();
                return handle;
            });
        this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    }

    get size(): number {
        return this.sessions.size;
    }

    private snapshot(session: Session): TransactionState {
        return { open: session.inTransaction, hasChanges: session.hasChanges, startedAt: session.startedAt };
    }

    private touch(session: Session): void {
        session.lastUsed = this.now();
        if (session.idleTimer !== undefined) this.clearTimer(session.idleTimer);
        session.idleTimer = this.setTimer(() => void this.expire(session), this.idleMs);
    }

    private async expire(session: Session): Promise<void> {
        if (session.closed) return;
        if (session.busy) return this.touch(session); // still running something: look again later
        await this.dispose(session);
    }

    /** Rolls back whatever is open, closes the connection and forgets the session. */
    private async dispose(session: Session): Promise<void> {
        if (session.closed) return;
        session.closed = true;
        if (session.idleTimer !== undefined) this.clearTimer(session.idleTimer);
        if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
        try {
            if (session.inTransaction) await session.client.query("ROLLBACK");
        } catch {
            // The connection is going away anyway; the server rolls the transaction back when it closes.
        }
        session.inTransaction = false;
        await session.client.end().catch(() => undefined);
    }

    private lost(session: Session): void {
        if (session.closed) return;
        session.closed = true;
        session.inTransaction = false;
        if (session.idleTimer !== undefined) this.clearTimer(session.idleTimer);
        if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
        session.client.destroy();
    }

    private async open(row: ConnectionRow, sessionId: string): Promise<Session> {
        if (this.sessions.size >= this.maxSessions) {
            const evictable = Array.from(this.sessions.values())
                .filter((candidate) => !candidate.busy && !candidate.inTransaction)
                .sort((a, b) => a.lastUsed - b.lastUsed)[0];
            if (!evictable) throw new SqlSessionError("Too many SQL editor sessions are open with uncommitted work. Commit or roll back one first.", 429, "too_many_sessions");
            await this.dispose(evictable);
        }

        const client = await this.deps.connect(row);
        const session: Session = {
            id: sessionId,
            connectionId: row.id,
            client,
            inTransaction: false,
            hasChanges: false,
            startedAt: null,
            busy: false,
            closed: false,
            typeNames: new Map(),
            lastUsed: this.now(),
        };
        client.onError(() => this.lost(session));
        this.sessions.set(sessionId, session);

        try {
            const pid = (await client.query({ text: "SELECT pg_backend_pid() AS pid", rowMode: "array" })) as { rows: unknown[][] };
            session.backendPid = Number(pid.rows[0]?.[0]) || undefined;
        } catch {
            // Only used for the Stop button; without it Stop falls back to dropping the connection.
        }
        return session;
    }

    private existing(connectionId: string, sessionId: string): Session | undefined {
        const session = this.sessions.get(sessionId);
        if (!session || session.closed) return undefined;
        if (session.connectionId !== connectionId) throw new SqlSessionError("That session belongs to a different connection.", 409, "wrong_connection");
        return session;
    }

    status(connectionId: string, sessionId: string): TransactionState | undefined {
        const session = this.existing(connectionId, sessionId);
        return session ? this.snapshot(session) : undefined;
    }

    private async resolveTypes(session: Session, results: PgResultLike[]): Promise<void> {
        const unknown = unknownTypeOids(results, session.typeNames);
        if (unknown.length === 0) return;
        try {
            const found = (await session.client.query({
                text: "SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])",
                values: [unknown],
                rowMode: "array",
            })) as { rows: [string, string][] };
            for (const [oid, name] of found.rows) session.typeNames.set(Number(oid), name);
        } catch {
            // Columns just show as "unknown".
        }
    }

    async run(
        row: ConnectionRow,
        sessionId: string,
        sql: string,
        options: { transactional?: boolean; expectOpenTransaction?: boolean } = {},
    ): Promise<RunOutcome & { sessionId: string }> {
        if (!SESSION_ID.test(sessionId)) throw new SqlSessionError("Invalid session id.", 400);

        const control = findTransactionControl(sql);
        if (control) throw new SqlSessionError(`${control} isn't needed here: use the Commit and Roll back buttons.`, 400, "transaction_control");
        if (splitSqlStatements(sql).length === 0) throw new SqlSessionError("There is nothing to run.", 400);

        let session = this.existing(row.id, sessionId);
        if (options.expectOpenTransaction && !session?.inTransaction) {
            throw new SqlSessionError("Your open transaction expired and was rolled back, so the earlier changes are gone. Run again to start a new one.", 409, "session_expired");
        }
        if (!session) session = await this.open(row, sessionId);
        if (session.busy) throw new SqlSessionError("A query is already running in this session.", 409, "busy");

        session.busy = true;
        if (session.idleTimer !== undefined) this.clearTimer(session.idleTimer);
        const startedAt = this.now();
        try {
            const outcome = options.transactional === false ? await this.runAutocommit(session, sql) : await this.runInTransaction(session, sql);
            return { ...outcome, elapsedMs: this.now() - startedAt, sessionId };
        } finally {
            session.busy = false;
            if (!session.closed) this.touch(session);
        }
    }

    private async runInTransaction(session: Session, sql: string): Promise<RunOutcome> {
        const readQuery = isSingleReadQuery(sql);
        const mode = !session.inTransaction && readQuery ? "one-shot-read" : "in-transaction";

        let outcome = await this.runBatch(session, sql, mode, readQuery);
        if (!outcome.ok && readQuery && outcome.error.code && CURSOR_FALLBACK_CODES.has(outcome.error.code) && !session.closed) {
            outcome = await this.runBatch(session, sql, mode, false);
        }
        return outcome;
    }

    private async runBatch(session: Session, sql: string, mode: "in-transaction" | "one-shot-read", cursor: boolean): Promise<RunOutcome> {
        const wasOpen = session.inTransaction;
        const batch = buildRunBatch(sql, { mode, transactionOpen: wasOpen, cursor });

        try {
            const raw = await session.client.query({ text: batch.text, rowMode: "array" });
            const pgResults = extractResults(raw, batch);
            await this.resolveTypes(session, pgResults);
            const results = pgResults.map((result) => mapResult(result, session.typeNames));

            if (cursor) {
                // The rows came through FETCH: present them as the SELECT they are, never claiming more rows than were returned.
                for (const result of results) {
                    result.command = "SELECT";
                    if (result.rowCount !== null) result.rowCount = Math.min(result.rowCount, ROW_CAP);
                }
            }

            if (mode === "in-transaction") {
                session.inTransaction = true;
                session.startedAt ??= this.now();
                session.hasChanges ||= changesData(results);
            }
            return { ok: true as const, results, elapsedMs: 0, transaction: this.snapshot(session) };
        } catch (error) {
            const mapped = mapError(error, batch.prefixLength, sql.length);
            const transactionLost = await this.recover(session, mode, wasOpen, error);
            return {
                ok: false as const,
                error: mapped,
                results: [] as StatementResult[],
                elapsedMs: 0,
                transaction: this.snapshot(session),
                ...(transactionLost ? { transactionLost: true } : {}),
            };
        }
    }

    /** Puts the session back into a usable state after a failed run. Returns true when earlier uncommitted work was lost. */
    private async recover(session: Session, mode: "in-transaction" | "one-shot-read", wasOpen: boolean, error: unknown): Promise<boolean> {
        if (isConnectionLost(error)) {
            const hadWork = wasOpen && session.hasChanges;
            this.lost(session);
            return hadWork;
        }

        try {
            if (mode === "in-transaction" && wasOpen) {
                // Undo just this run; everything committed to the transaction by earlier runs stays.
                await session.client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}; RELEASE SAVEPOINT ${SAVEPOINT}`);
                return false;
            }
            await session.client.query("ROLLBACK");
            session.inTransaction = false;
            session.hasChanges = false;
            session.startedAt = null;
            return false;
        } catch (cleanupError) {
            const hadWork = wasOpen && session.hasChanges;
            try {
                await session.client.query("ROLLBACK");
            } catch {
                this.lost(session);
                return hadWork;
            }
            session.inTransaction = false;
            session.hasChanges = false;
            session.startedAt = null;
            return hadWork;
        }
    }

    private async runAutocommit(session: Session, sql: string): Promise<RunOutcome> {
        if (session.inTransaction) {
            throw new SqlSessionError("Commit or roll back the open transaction before running without one.", 409, "transaction_open");
        }

        const results: StatementResult[] = [];
        for (const statement of splitSqlStatements(sql)) {
            try {
                const raw = (await session.client.query({ text: statement.text, rowMode: "array" })) as PgResultLike | PgResultLike[];
                const pgResults = (Array.isArray(raw) ? raw : [raw]).filter((result) => result.command || result.fields?.length);
                await this.resolveTypes(session, pgResults);
                results.push(...pgResults.map((result) => mapResult(result, session.typeNames)));
            } catch (error) {
                if (isConnectionLost(error)) this.lost(session);
                // Statements already run have committed; report them along with the error.
                return { ok: false as const, error: mapError(error, -statement.start, sql.length), results, elapsedMs: 0, transaction: this.snapshot(session) };
            }
        }
        return { ok: true as const, results, elapsedMs: 0, transaction: this.snapshot(session) };
    }

    private async finish(connectionId: string, sessionId: string, command: "COMMIT" | "ROLLBACK") {
        const session = this.existing(connectionId, sessionId);
        if (!session) throw new SqlSessionError("That session has expired. Uncommitted changes were rolled back.", 404, "session_expired");
        if (session.busy) throw new SqlSessionError("A query is still running. Stop it first.", 409, "busy");

        session.busy = true;
        let error: RunError | undefined;
        try {
            if (session.inTransaction) {
                try {
                    await session.client.query(command);
                } catch (err) {
                    error = mapError(err, 0, 0);
                    if (isConnectionLost(err)) this.lost(session);
                    else await session.client.query("ROLLBACK").catch(() => this.lost(session));
                }
            }
            session.inTransaction = false;
            session.hasChanges = false;
            session.startedAt = null;
            return { ok: !error, error, transaction: this.snapshot(session) };
        } finally {
            session.busy = false;
            if (!session.closed) this.touch(session);
        }
    }

    commit(connectionId: string, sessionId: string) {
        return this.finish(connectionId, sessionId, "COMMIT");
    }

    rollback(connectionId: string, sessionId: string) {
        return this.finish(connectionId, sessionId, "ROLLBACK");
    }

    /** Stop button: ask Postgres to cancel the running statement; if it doesn't stop in time, drop the connection (which rolls back). */
    async cancel(row: ConnectionRow, sessionId: string): Promise<{ cancelling: boolean }> {
        const session = this.existing(row.id, sessionId);
        if (!session || !session.busy) return { cancelling: false };

        if (session.backendPid !== undefined && this.deps.cancelBackend) {
            await this.deps.cancelBackend(row, session.backendPid).catch(() => undefined);
        }
        this.setTimer(() => {
            if (session.busy && !session.closed) this.lost(session);
        }, this.cancelGraceMs);
        return { cancelling: true };
    }

    async close(connectionId: string, sessionId: string): Promise<void> {
        const session = this.existing(connectionId, sessionId);
        if (session) await this.dispose(session);
    }

    async closeForConnection(connectionId: string): Promise<void> {
        await Promise.all(Array.from(this.sessions.values()).filter((session) => session.connectionId === connectionId).map((session) => this.dispose(session)));
    }

    async closeAll(): Promise<void> {
        await Promise.all(Array.from(this.sessions.values()).map((session) => this.dispose(session)));
    }
}

/** Every value comes back as text, so the data viewer's formatting applies unchanged and nothing loses precision. */
const TEXT_TYPES = { getTypeParser: () => (value: string) => value };

async function connectSessionClient(row: ConnectionRow): Promise<SessionClient> {
    const config = toConnectionConfig(row);
    const client = new Client({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        ssl: sslOption(config.sslMode),
        connectionTimeoutMillis: 10_000,
        keepAlive: true,
        application_name: "goforge-sql-editor",
        types: TEXT_TYPES as never,
    });
    await client.connect();

    return {
        query: (query) => client.query(query as never) as Promise<unknown>,
        end: () => client.end(),
        destroy: () => {
            (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
        },
        onError: (listener) => {
            client.on("error", listener);
        },
    };
}

async function cancelBackend(row: ConnectionRow, pid: number): Promise<void> {
    await withPgClient(toConnectionConfig(row), (client) => client.query("SELECT pg_cancel_backend($1)", [pid]));
}

export const sqlSessions = new SqlSessions({ connect: connectSessionClient, cancelBackend });
