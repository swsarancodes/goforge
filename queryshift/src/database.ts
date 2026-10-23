import { Worker } from "node:worker_threads";
import { categoryOf, type ActualTable } from "./compare";
import { guardSelect } from "./sql-guard";

/**
 * The target database: PostgreSQL itself (PGlite, the server compiled to WebAssembly) in a worker thread, no Docker or server needed.
 * It lives in a worker because PGlite ignores `statement_timeout` (measured: a 27 s query ran past a 300 ms limit), so a limit on how long a
 * candidate may run has to come from outside: when it is exceeded the worker is terminated, the candidate is reported as stopped, and the
 * next call starts a fresh worker and replays the setup (schema, seed, anything else run through `exec`). Candidates are run one at a time.
 */

export const DEFAULT_MAX_ROWS = 10_000;
/** How long one candidate may run. The data is tiny on purpose: a query that needs seconds is a runaway, not a slow report. */
export const DEFAULT_TIMEOUT_MS = 10_000;
const SETUP_TIMEOUT_MS = 60_000;

export class CandidateRefused extends Error {}
export class CandidateTimeout extends Error {
    constructor(readonly timeoutMs: number) {
        super(`It ran longer than ${timeoutMs} ms and was stopped.`);
    }
}

export interface Field {
    name: string;
    dataTypeID: number;
}

export interface Database {
    /** Trusted SQL (schema, seed, views). Remembered and replayed if the worker has to be restarted. */
    exec(sql: string): Promise<void>;
    /** Trusted query, not read-only: used for the schema description and by tests. Values come back as text. */
    query<T = Record<string, string | null>>(sql: string): Promise<{ rows: T[]; fields: Field[] }>;
    /** One statement in a READ ONLY transaction that is always rolled back, with a wall-clock limit. */
    readOnly(sql: string, options?: { maxRows?: number; timeoutMs?: number }): Promise<{ rows: (string | null)[][]; fields: Field[]; truncated: boolean }>;
    /** How many times the worker was stopped and replaced. */
    readonly restarts: number;
    close(): Promise<void>;
}

type Reply = { id: number; ok: true; value: any } | { id: number; ok: false; error: { message: string } };

class WorkerDatabase implements Database {
    restarts = 0;
    private worker: Worker | undefined;
    private setup: string[] = [];
    private nextId = 1;
    private queue: Promise<unknown> = Promise.resolve();

    private async spawn(): Promise<Worker> {
        const worker = new Worker(new URL("./db-worker.mjs", import.meta.url));
        await new Promise<void>((resolve, reject) => {
            worker.once("message", () => resolve());
            worker.once("error", reject);
        });
        return worker;
    }

    /** Sends one operation and waits for its reply, or stops the worker when the time is up. */
    private async call(op: "exec" | "query" | "readonly", sql: string, timeoutMs: number, maxRows = DEFAULT_MAX_ROWS): Promise<any> {
        const attempt = async () => {
            if (!this.worker) {
                this.worker = await this.spawn();
                for (const statement of this.setup) await this.send(this.worker, "exec", statement, SETUP_TIMEOUT_MS);
            }
            return this.send(this.worker, op, sql, timeoutMs, maxRows);
        };
        const result = this.queue.then(attempt, attempt);
        this.queue = result.catch(() => undefined);
        return result;
    }

    private send(worker: Worker, op: string, sql: string, timeoutMs: number, maxRows?: number): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const finish = () => {
                clearTimeout(timer);
                worker.off("message", onMessage);
                worker.off("error", onError);
            };
            const onMessage = (reply: Reply) => {
                if (reply.id !== id) return;
                finish();
                if (reply.ok) resolve(reply.value);
                else reject(new Error(reply.error.message));
            };
            const onError = (error: Error) => {
                finish();
                this.worker = undefined;
                reject(error);
            };
            const timer = setTimeout(() => {
                finish();
                this.worker = undefined;
                this.restarts++;
                void worker.terminate();
                reject(new CandidateTimeout(timeoutMs));
            }, timeoutMs);
            worker.on("message", onMessage);
            worker.on("error", onError);
            worker.postMessage({ id, op, sql, maxRows });
        });
    }

    async exec(sql: string) {
        await this.call("exec", sql, SETUP_TIMEOUT_MS);
        this.setup.push(sql);
    }
    query<T>(sql: string) {
        return this.call("query", sql, SETUP_TIMEOUT_MS) as Promise<{ rows: T[]; fields: Field[] }>;
    }
    readOnly(sql: string, options: { maxRows?: number; timeoutMs?: number } = {}) {
        return this.call("readonly", sql, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.maxRows ?? DEFAULT_MAX_ROWS);
    }
    async close() {
        await this.queue;
        const worker = this.worker;
        this.worker = undefined;
        await worker?.terminate();
    }
}

export async function createDatabase(schemaSql: string, seedSql?: string): Promise<Database> {
    const db = new WorkerDatabase();
    await db.exec(schemaSql);
    if (seedSql) await db.exec(seedSql);
    return db;
}

/**
 * Runs one statement read-only (guard first, then a READ ONLY transaction that is always rolled back, inside a worker that is stopped if it
 * takes longer than `timeoutMs`) and returns every value as text with its column's category.
 */
export async function executeCandidate(db: Database, sql: string, options: { maxRows?: number; timeoutMs?: number } = {}): Promise<ActualTable> {
    const guard = guardSelect(sql);
    if (!guard.ok) throw new CandidateRefused(guard.reason);
    const result = await db.readOnly(sql.replace(/[\s;]+$/, ""), options);
    return {
        columns: result.fields.map((field) => ({ name: field.name, category: categoryOf(field.dataTypeID), typeOid: field.dataTypeID })),
        rows: result.rows,
        truncated: result.truncated,
    };
}

/** A trusted one-value query written by the case author (an invariant's reference). Still read-only, still time-limited. */
export async function scalar(db: Database, sql: string, options: { timeoutMs?: number } = {}): Promise<number> {
    const result = await db.readOnly(sql, { maxRows: 1, timeoutMs: options.timeoutMs });
    const value = result.rows[0]?.[0];
    const number = Number(value);
    if (value === null || value === undefined || !Number.isFinite(number)) throw new Error(`Invariant query returned ${String(value)}, not a number: ${sql}`);
    return number;
}

export interface SchemaTable {
    name: string;
    columns: { name: string; type: string; nullable: boolean }[];
}

/** Table and column names, types and nullability of the target database: the only thing about it a model is ever told besides evidence. */
export async function describeSchema(db: Database): Promise<SchemaTable[]> {
    const result = await db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
        "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
    );
    const tables = new Map<string, SchemaTable>();
    for (const row of result.rows) {
        const table = tables.get(row.table_name) ?? { name: row.table_name, columns: [] };
        table.columns.push({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === "YES" });
        tables.set(row.table_name, table);
    }
    return [...tables.values()];
}
