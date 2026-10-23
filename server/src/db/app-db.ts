import { Pool } from "pg";

/**
 * The application's own database (accounts, saved connections, diagrams, AI settings, the audit log): one small interface over
 * PostgreSQL, so the stores are written once and run against a real server (`pg`) in production and an in-process Postgres in tests.
 * This is not the databases people connect to; those are reached through `services/pg-client.ts`.
 */

export interface QueryResult<R> {
    rows: R[];
    rowCount: number;
}

export interface Queryable {
    query<R = Record<string, any>>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export interface AppDb extends Queryable {
    /** Runs `fn` in one transaction on one connection; rolls back if it throws. */
    transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}

/**
 * What the server was told about its database. `url` is the direct connection (used for migrations and for creating databases, which
 * need a session of their own); `poolUrl` is an optional pooled one (Neon's `-pooler` host) used for everyday queries.
 */
export interface AppDbConfig {
    url: string;
    poolUrl?: string;
}

export function appDbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppDbConfig | undefined {
    const url = env.DATABASE_URL?.trim();
    if (!url) return undefined;
    return { url, poolUrl: env.DATABASE_URL_POOLED?.trim() || undefined };
}

/** Where the application database lives, for log lines and error messages. Never includes the user or password. */
export function describeDatabaseUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
    } catch {
        return "the configured database";
    }
}

/**
 * `sslmode=require` (what Neon hands out) already means "verify the server's certificate" in this version of pg, and pg 9 will weaken it to
 * "encrypt only". The connection is made the way it is today, and said so: any of the look-alike modes becomes `verify-full`.
 */
export function explicitTls(connectionString: string): string {
    try {
        const url = new URL(connectionString);
        const mode = url.searchParams.get("sslmode");
        if (mode && ["prefer", "require", "verify-ca"].includes(mode)) {
            url.searchParams.set("sslmode", "verify-full");
            return url.toString();
        }
    } catch {
        // not a URL: pg will say what is wrong with it
    }
    return connectionString;
}

export function createPgAppDb(connectionString: string, options: { max?: number } = {}): AppDb {
    const pool = new Pool({ connectionString: explicitTls(connectionString), max: options.max ?? 10, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 30_000 });
    // An idle client that dies (a serverless database going to sleep, a restart) must not take the process down with it.
    pool.on("error", (error) => console.error("application database: idle connection error:", error.message));

    return {
        async query(text, values) {
            const result = await pool.query(text, values as any[]);
            return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
        async transaction(fn) {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const tx: Queryable = {
                    query: async (text, values) => {
                        const result = await client.query(text, values as any[]);
                        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
                    },
                };
                const value = await fn(tx);
                await client.query("COMMIT");
                return value;
            } catch (error) {
                await client.query("ROLLBACK").catch(() => undefined);
                throw error;
            } finally {
                client.release();
            }
        },
        close: () => pool.end(),
    };
}
