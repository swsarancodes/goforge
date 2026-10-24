/**
 * Runs the Modernizer's golden corpus against a real PostgreSQL.
 *
 *   docker run -d --name goforge-corpus -e POSTGRES_PASSWORD=corpus -e POSTGRES_DB=corpus -p 54329:5432 postgres:16
 *   npm run test:corpus
 *
 * For every case the legacy SQL is converted, the converted SQL is executed, and its rows are compared with a
 * hand-written PostgreSQL reference that encodes what the legacy database returns on the fixture data.
 * Exit code 1 means a result was silently wrong, or a family is below the pass-rate gate.
 */
import { createRequire } from "node:module";
import { convertQuery } from "../src/features/query-modernizer/engine/convert";
import { CASES, type CorpusCase } from "../src/features/query-modernizer/engine/corpus/cases";
import { FIXTURE_SCHEMA, FIXTURE_SQL } from "../src/features/query-modernizer/engine/corpus/fixture";
import type { SchemaContext } from "../src/features/query-modernizer/types";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const { Client } = require("pg") as typeof import("pg");

const URL_ = process.env.CORPUS_DATABASE_URL ?? "postgres://postgres:corpus@127.0.0.1:54329/corpus";
const GATE = Number(process.env.CORPUS_GATE ?? "0.9");
const only = process.argv[2];

type Row = (string | null)[];
const stringTypes = { getTypeParser: () => (value: string) => value };

async function main() {
    const client = new Client({ connectionString: URL_ });
    await client.connect();
    await client.query("SET TIME ZONE 'UTC'");
    await client.query(FIXTURE_SQL);

    const schema = await loadSchema(client);
    const shape = (context: SchemaContext) => JSON.stringify(context.tables.map((t) => [t.name, t.columns.map((c) => `${c.name}:${c.type}`)]).sort());
    if (shape(schema) !== shape(FIXTURE_SCHEMA)) throw new Error("FIXTURE_SCHEMA in corpus/fixture.ts no longer matches the fixture SQL.");

    const results: { c: CorpusCase; ok: boolean; silent: boolean; reason?: string; sql?: string }[] = [];

    for (const c of CASES) {
        if (only && !c.id.includes(only)) continue;
        results.push(await runCase(client, c, schema));
    }
    await client.end();

    // report
    const families = new Map<string, { total: number; ok: number }>();
    for (const result of results) {
        const entry = families.get(result.c.family) ?? { total: 0, ok: 0 };
        entry.total++;
        if (result.ok) entry.ok++;
        families.set(result.c.family, entry);
    }
    console.log("\nFamily".padEnd(26) + "passed".padStart(8) + "total".padStart(8) + "rate".padStart(8));
    let below = false;
    for (const [family, entry] of [...families.entries()].sort()) {
        const rate = entry.ok / entry.total;
        if (rate < GATE) below = true;
        console.log(family.padEnd(26) + String(entry.ok).padStart(8) + String(entry.total).padStart(8) + `${(rate * 100).toFixed(0)}%`.padStart(8) + (rate < GATE ? "  <-- below gate" : ""));
    }
    const ok = results.filter((r) => r.ok).length;
    console.log("TOTAL".padEnd(26) + String(ok).padStart(8) + String(results.length).padStart(8) + `${((ok / results.length) * 100).toFixed(1)}%`.padStart(8));

    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
        console.log(`\n${failures.length} failing:`);
        for (const f of failures) console.log(`  ${f.silent ? "SILENT " : "       "}${f.c.id}\n      ${f.c.sql.replace(/\s+/g, " ")}\n      ${f.sql ? `=> ${f.sql.replace(/\s+/g, " ")}\n      ` : ""}${f.reason}`);
    }
    const silent = failures.filter((f) => f.silent);
    console.log(`\nsilent wrong results: ${silent.length}`);
    if (silent.length > 0 || (!only && below)) process.exit(1);
}

async function loadSchema(client: InstanceType<typeof Client>): Promise<SchemaContext> {
    const columns = await client.query(
        `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.ordinal_position,
                EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_name = tc.table_name
                        WHERE tc.table_name = c.table_name AND tc.constraint_type = 'PRIMARY KEY' AND k.column_name = c.column_name) AS is_primary
         FROM information_schema.columns c WHERE c.table_schema = 'public' ORDER BY c.table_name, c.ordinal_position`,
    );
    const tables = new Map<string, SchemaContext["tables"][number]>();
    for (const row of columns.rows) {
        const table = tables.get(row.table_name) ?? { name: row.table_name, columns: [] };
        table.columns.push({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === "YES", isPrimary: row.is_primary });
        tables.set(row.table_name, table);
    }
    return { tables: [...tables.values()] };
}

/** Runs statements in a transaction that is rolled back; returns the rows of the last statement (or of `verify`). */
async function execute(client: InstanceType<typeof Client>, c: CorpusCase, sql: string): Promise<Row[]> {
    await client.query("BEGIN");
    try {
        for (const setup of c.setup ?? []) await client.query(setup);
        let result = (await client.query({ text: sql, rowMode: "array", types: stringTypes } as never)) as unknown;
        if (c.verify) result = await client.query({ text: c.verify, rowMode: "array", types: stringTypes } as never);
        const last = Array.isArray(result) ? result[result.length - 1] : result;
        return ((last as { rows?: Row[] }).rows ?? []).map((row) => row.map((value) => (value === null ? null : String(value))));
    } finally {
        await client.query("ROLLBACK");
    }
}

async function runCase(client: InstanceType<typeof Client>, c: CorpusCase, schema: SchemaContext): Promise<{ c: CorpusCase; ok: boolean; silent: boolean; reason?: string; sql?: string }> {
    let conversion;
    try {
        conversion = convertQuery({ sql: c.sql, dialect: c.from, schema: c.schema ? schema : undefined });
    } catch (error) {
        return { c, ok: false, silent: false, reason: `engine threw: ${error instanceof Error ? error.message : error}` };
    }
    const sql = conversion.sql;
    if (conversion.syntaxError) return { c, ok: false, silent: false, sql, reason: `syntax error: ${conversion.syntaxError}` };

    if (c.unconverted) {
        return conversion.unconverted.length > 0 ? { c, ok: true, silent: false } : { c, ok: false, silent: true, sql, reason: "was not converted but the engine did not say so" };
    }
    if (conversion.unconverted.length > 0) return { c, ok: false, silent: false, sql, reason: `engine reported not-converted: ${conversion.unconverted.map((u) => u.reason).join("; ")}` };

    const expectedTraps = [...(c.trap ? [c.trap] : []), ...(c.traps ?? [])];
    const missing = expectedTraps.filter((id) => !conversion.traps.some((t) => t.id === id));
    if (missing.length > 0) return { c, ok: false, silent: true, sql, reason: `trap not reported: ${missing.join(", ")}` };

    if (c.reference === undefined) return { c, ok: true, silent: false };

    let actual: Row[];
    try {
        actual = await execute(client, c, conversion.validationSql);
    } catch (error) {
        return { c, ok: false, silent: false, sql, reason: `PostgreSQL rejected the converted query: ${error instanceof Error ? error.message : error}` };
    }
    let expected: Row[];
    try {
        expected = await execute(client, c, c.reference);
    } catch (error) {
        return { c, ok: false, silent: false, sql, reason: `corpus bug, the reference failed: ${error instanceof Error ? error.message : error}` };
    }
    const ordered = c.ordered ?? /ORDER\s+BY/i.test(c.reference);
    const normalise = (rows: Row[]) => (ordered ? rows.map((r) => JSON.stringify(r)) : rows.map((r) => JSON.stringify(r)).sort());
    const a = normalise(actual);
    const e = normalise(expected);
    if (JSON.stringify(a) !== JSON.stringify(e)) return { c, ok: false, silent: true, sql, reason: `rows differ\n        got      ${JSON.stringify(a)}\n        expected ${JSON.stringify(e)}` };
    return { c, ok: true, silent: false };
}

main().catch((error) => {
    console.error(error);
    process.exit(2);
});
