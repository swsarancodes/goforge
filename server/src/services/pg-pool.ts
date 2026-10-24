import { Pool } from "pg";
import type { ConnectionRow } from "../db/store.js";
import { sslOption, toConnectionConfig } from "./pg-client.js";
import type { Queryable } from "./pg-read.js";

export const READ_POOL_IDLE_MS = 60_000;
export const READ_POOL_MAX = 3;

export interface PoolClientLike extends Queryable {
    release(error?: Error | boolean): void;
}

/** The slice of pg.Pool that ReadPools uses (so it can be tested with a fake). */
export interface PoolLike {
    connect(): Promise<PoolClientLike>;
    end(): Promise<void>;
    on(event: "error" | "remove", listener: (...args: unknown[]) => void): unknown;
    readonly totalCount: number;
}

export interface PoolTimings {
    /** Time spent waiting for a client from the pool (a new connection when the pool was cold). */
    connectMs?: number;
}

function createDefaultPool(row: ConnectionRow): PoolLike {
    // Decrypted once here; the pool (and with it the password) is dropped as soon as it has no connections left.
    const config = toConnectionConfig(row);
    return new Pool({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        ssl: sslOption(config.sslMode),
        max: READ_POOL_MAX,
        idleTimeoutMillis: READ_POOL_IDLE_MS,
        connectionTimeoutMillis: 10_000,
        query_timeout: 30_000,
        keepAlive: true,
        allowExitOnIdle: true,
    }) as unknown as PoolLike;
}

const CONNECTION_LOST = /connection terminated|terminating connection|econnreset|epipe|connection error|socket hang up|read etimedout/i;
const CONNECTION_LOST_CODES = new Set(["ECONNRESET", "EPIPE", "57P01", "57P02", "57P03"]);

/** True when a query failed because the (possibly long idle) connection was dropped, not because of the SQL. */
export function isConnectionLost(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as { code?: unknown }).code;
    return (typeof code === "string" && CONNECTION_LOST_CODES.has(code)) || CONNECTION_LOST.test(error.message);
}

/**
 * A client must not go back to the pool after a database or socket error: the SQL left it inside an aborted
 * transaction, or the socket is dead. Errors raised by our own code (no SQLSTATE / errno code) leave it fine.
 */
function shouldDiscardClient(error: unknown): boolean {
    return isConnectionLost(error) || (error instanceof Error && typeof (error as { code?: unknown }).code === "string");
}

/**
 * One small pool of read-only connections per saved connection id, so browsing doesn't pay for a new TCP + TLS +
 * auth handshake on every click. Idle connections close after READ_POOL_IDLE_MS, and the pool - together with the
 * decrypted password it holds - is dropped once it has no connections left, when the saved connection is deleted,
 * or when it is edited. Writes (execute / preview / test) never use it.
 */
export class ReadPools {
    private readonly entries = new Map<string, { pool: PoolLike; version: string }>();

    constructor(private readonly createPool: (row: ConnectionRow) => PoolLike = createDefaultPool) {}

    get size(): number {
        return this.entries.size;
    }

    has(id: string): boolean {
        return this.entries.has(id);
    }

    private poolFor(row: ConnectionRow): PoolLike {
        const existing = this.entries.get(row.id);
        if (existing && existing.version === row.updated_at) return existing.pool;
        if (existing) void this.close(row.id); // the saved connection was edited: its old pool has stale credentials

        const pool = this.createPool(row);
        pool.on("error", () => {
            // An idle client errored; pg-pool already removes it. Nothing to do, but it must not crash the process.
        });
        pool.on("remove", () => {
            if (pool.totalCount === 0 && this.entries.get(row.id)?.pool === pool) {
                this.entries.delete(row.id);
                void pool.end().catch(() => undefined);
            }
        });
        this.entries.set(row.id, { pool, version: row.updated_at });
        return pool;
    }

    /**
     * Runs `fn` on a pooled client. A client whose connection turns out to be dead (idle too long, server restarted)
     * is discarded and the work retried once on a fresh one; after any other database error the client is discarded
     * too, so a failed transaction never reaches the next caller.
     */
    async withClient<T>(row: ConnectionRow, fn: (client: Queryable) => Promise<T>, timings?: PoolTimings): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            const startedAt = performance.now();
            const client = await this.poolFor(row).connect();
            if (timings) timings.connectMs = Math.round(performance.now() - startedAt);

            try {
                const result = await fn(client);
                client.release();
                return result;
            } catch (error) {
                client.release(shouldDiscardClient(error) ? (error as Error) : undefined);
                if (attempt === 0 && isConnectionLost(error)) continue;
                throw error;
            }
        }
    }

    /** Ends and forgets the pool for a saved connection (called when it is deleted or edited). */
    async close(id: string): Promise<void> {
        const entry = this.entries.get(id);
        if (!entry) return;
        this.entries.delete(id);
        await entry.pool.end().catch(() => undefined);
    }
}

export const readPools = new ReadPools();

export function withReadClient<T>(row: ConnectionRow, fn: (client: Queryable) => Promise<T>, timings?: PoolTimings): Promise<T> {
    return readPools.withClient(row, fn, timings);
}

export function closeReadPool(id: string): Promise<void> {
    return readPools.close(id);
}
