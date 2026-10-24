import { PGlite } from "@electric-sql/pglite";
import type { AppDb, Queryable } from "../src/db/app-db.js";

/**
 * A real PostgreSQL running inside the test process (WebAssembly), shaped like the application database, so the stores and routes are
 * tested against Postgres itself without a server or Docker.
 */
type Runner = Pick<PGlite, "query" | "exec">;

async function run(runner: Runner, text: string, values?: unknown[]) {
    // Several statements in one string (a migration) only work without parameters, and then through exec.
    if (!values || values.length === 0) {
        const results = await runner.exec(text);
        const last = results[results.length - 1];
        return { rows: (last?.rows ?? []) as any[], rowCount: last?.affectedRows ? last.affectedRows : (last?.rows?.length ?? 0) };
    }
    const result = await runner.query(text, values as any[]);
    return { rows: result.rows as any[], rowCount: result.affectedRows ? result.affectedRows : result.rows.length };
}

export async function createTestAppDb(): Promise<AppDb & { raw: PGlite }> {
    const raw = new PGlite();
    await raw.waitReady;
    const wrap = (runner: Runner): Queryable => ({ query: (text, values) => run(runner, text, values) });
    return {
        raw,
        query: (text, values) => run(raw, text, values),
        transaction: (fn) => raw.transaction((tx) => fn(wrap(tx))),
        close: () => raw.close(),
    };
}
