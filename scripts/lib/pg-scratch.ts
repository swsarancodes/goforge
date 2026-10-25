/**
 * Small helpers for the scripts that run the schema-change code against a real PostgreSQL 16:
 *
 *   docker run -d --name goforge-schema -e POSTGRES_PASSWORD=schema -e POSTGRES_DB=schema -p 54330:5432 postgres:16 -c max_locks_per_transaction=1024
 *
 * Every run works in a database of its own that is dropped afterwards, so nothing here touches anything you own.
 */
import { createRequire } from "node:module";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const { Client } = require("pg") as typeof import("pg");

export type PgClient = InstanceType<typeof Client>;

const ADMIN_URL = process.env.SCHEMA_CHANGE_DATABASE_URL ?? "postgres://postgres:schema@127.0.0.1:54330/schema";

const withDatabaseName = (url: string, name: string): string => {
    const parsed = new URL(url);
    parsed.pathname = `/${name}`;
    return parsed.toString();
};

/** DROP DATABASE ... WITH (FORCE) only exists from PostgreSQL 13: elsewhere the sessions are ended first. */
async function dropForce(admin: PgClient, name: string): Promise<void> {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [name]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
}

export async function connect(database?: string): Promise<PgClient> {
    const client = new Client({ connectionString: database ? withDatabaseName(ADMIN_URL, database) : ADMIN_URL });
    await client.connect();
    return client;
}

let counter = 0;

/** A fresh, empty database for the duration of `fn`; `template` clones an existing one (which must have no open connections). */
export async function withDatabase<T>(fn: (client: PgClient, name: string) => Promise<T>, options: { template?: string; prefix?: string } = {}): Promise<T> {
    const admin = await connect();
    const name = `${options.prefix ?? "sc"}_${process.pid}_${Date.now().toString(36)}_${counter++}`;
    try {
        // A template must have no sessions; anything still connected to this scratch copy (an app that was pointed at it) is disconnected.
        if (options.template) await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [options.template]);
        await admin.query(`CREATE DATABASE ${name}${options.template ? ` TEMPLATE ${options.template}` : ""}`);
        const client = await connect(name);
        try {
            return await fn(client, name);
        } finally {
            await client.end().catch(() => undefined);
        }
    } finally {
        await dropForce(admin, name).catch(() => undefined);
        await admin.end().catch(() => undefined);
    }
}

/** A database that stays after the call (the caller drops it): used for the large generated schemas the evaluation clones. */
export async function createDatabase(name: string, build: (client: PgClient) => Promise<void>): Promise<void> {
    const admin = await connect();
    try {
        await dropForce(admin, name);
        await admin.query(`CREATE DATABASE ${name}`);
    } finally {
        await admin.end();
    }
    const client = await connect(name);
    try {
        await build(client);
    } finally {
        await client.end();
    }
}

export async function dropDatabase(name: string): Promise<void> {
    const admin = await connect();
    try {
        await dropForce(admin, name);
    } finally {
        await admin.end();
    }
}

/** Tiny assertion collector: every check is counted and listed, and the process exits 1 if any failed. */
export class Checks {
    private passed = 0;
    private readonly failures: string[] = [];

    constructor(private readonly title: string) {}

    ok(condition: unknown, label: string, detail?: unknown): void {
        if (condition) {
            this.passed++;
            return;
        }
        this.failures.push(detail === undefined ? label : `${label}\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    }

    match(actual: string | undefined, pattern: RegExp, label: string): void {
        this.ok(actual !== undefined && pattern.test(actual), label, `got ${JSON.stringify(actual)}`);
    }

    equal(actual: unknown, expected: unknown, label: string): void {
        this.ok(JSON.stringify(actual) === JSON.stringify(expected), label, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }

    report(): boolean {
        console.log(`${this.title}: ${this.passed} passed, ${this.failures.length} failed`);
        for (const failure of this.failures) console.log(`  FAIL ${failure}`);
        return this.failures.length === 0;
    }
}
