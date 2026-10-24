import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The whole journey, through the real app over HTTP, against a real Oracle and a real PostgreSQL:
 *
 *   an account creates an Oracle database from Oracle DDL  ->  synthetic legacy data goes into it  ->  legacy Oracle queries run on it
 *   ->  the account migrates it to a new PostgreSQL database (a GoForge cloud database)  ->  the legacy queries are converted to
 *   PostgreSQL and run on the migrated database  ->  the two sets of results are compared.
 *
 * ORACLE_TEST_ADMIN_URL=oracle://system:pw@127.0.0.1:1521/FREEPDB1 and PG_TEST_ADMIN_URL=postgres://postgres:pw@127.0.0.1:54330/postgres
 * (a role that may create roles and databases: it stands in for the server behind GoForge cloud, Neon in production). Skipped without both.
 * Set FLOW_REPORT=/some/path.json to also write what happened to each query.
 */
const oracleUrl = process.env.ORACLE_TEST_ADMIN_URL;
const pgUrl = process.env.PG_TEST_ADMIN_URL;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goforge-flow-"));
process.env.SQLITE_PATH = path.join(dir, "unused.db");
process.env.MASTER_KEY = randomBytes(32).toString("base64");

const { createApp } = await import("../app.js");
const { createTestAppDb } = await import("../../test/pglite-app-db.js");
const { migrate } = await import("../db/migrations.js");
const { createPgStores } = await import("../db/pg-stores.js");
const { installCloud, installConnectionStore } = await import("../db/stores.js");
const { installAiStores } = await import("../ai/provider.js");
const { adminConfigFromUrl, dropCloudDatabase } = await import("../services/cloud-databases.js");
const { installOracleServer, oracleServerFromEnv, dropOracleSchema, getOracleServer } = await import("../services/oracle-schemas.js");
const { convertQuery } = await import("../../../src/features/query-modernizer/engine/convert");
const { createQueryCorrection } = await import("../ai/correct-query.js");
const { differingColumns } = await import("../../../queryshift/src/diagnose");
const { compareResults } = await import("../../../queryshift/src/compare");
type Category = import("../../../queryshift/src/compare").Category;

const domain = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../../../queryshift/domain", file), "utf8");

/** Legacy Oracle queries over the insurance schema, the kind a reporting job has accumulated. */
const LEGACY_QUERIES: { name: string; sql: string }[] = [
    { name: "customers and their active 2026 policies, with (+)", sql: fs.readFileSync(path.resolve(import.meta.dirname, "../../../queryshift/cases/case-01-outer-join-active-policies/legacy_query.sql"), "utf8") },
    { name: "claims summary per customer (NULL and division)", sql: fs.readFileSync(path.resolve(import.meta.dirname, "../../../queryshift/cases/case-02-null-and-aggregation-claims/legacy_query.sql"), "utf8") },
    { name: "five largest March claims (TRUNC, ROWNUM, ADD_MONTHS)", sql: fs.readFileSync(path.resolve(import.meta.dirname, "../../../queryshift/cases/case-03-date-time-claims-window/legacy_query.sql"), "utf8") },
    { name: "DECODE", sql: "SELECT segmt_cd, DECODE(segmt_cd, 'COM', 'Commercial', 'RET', 'Retail', 'Other') AS seg_name, COUNT(*) AS n FROM cust_mst GROUP BY segmt_cd ORDER BY 1" },
    { name: "SUBSTR, INSTR, UPPER, LENGTH", sql: "SELECT cust_id, UPPER(SUBSTR(cust_nm, 1, INSTR(cust_nm, ' ') - 1)) AS first_name, LENGTH(cust_nm) AS len FROM cust_mst WHERE cust_id <= 20 ORDER BY cust_id" },
    { name: "TO_CHAR of a date, grouped", sql: "SELECT TO_CHAR(eff_dt, 'YYYY-MM') AS ym, COUNT(*) AS n, SUM(NVL(annl_prem, 0)) AS prem FROM polcy_hdr GROUP BY TO_CHAR(eff_dt, 'YYYY-MM') ORDER BY 1" },
    { name: "top ten premiums with ROWNUM", sql: "SELECT * FROM (SELECT polcy_id, annl_prem FROM polcy_hdr WHERE annl_prem IS NOT NULL ORDER BY annl_prem DESC, polcy_id) WHERE ROWNUM <= 10" },
    { name: "claims per day with TRUNC", sql: "SELECT TRUNC(clm_dt) AS day, COUNT(*) AS n FROM clm_dtl GROUP BY TRUNC(clm_dt) ORDER BY 1" },
    { name: "customers with no policy, with MINUS", sql: "SELECT cust_id FROM cust_mst MINUS SELECT cust_id FROM polcy_hdr" },
    { name: "date arithmetic and MONTHS_BETWEEN", sql: "SELECT polcy_id, exp_dt - eff_dt AS days, MONTHS_BETWEEN(exp_dt, eff_dt) AS months FROM polcy_hdr WHERE polcy_id <= 20 ORDER BY polcy_id" },
    { name: "customers without an email", sql: "SELECT COUNT(*) AS n FROM cust_mst WHERE cust_email IS NULL" },
];

const NUMBER_TYPES = new Set(["int2", "int4", "int8", "numeric", "float4", "float8"]);
const categoryOfName = (dataType: string): Category => (NUMBER_TYPES.has(dataType) ? "number" : dataType === "date" ? "date" : dataType.startsWith("timestamp") ? "timestamp" : dataType === "bool" ? "boolean" : "text");

describe.skipIf(!oracleUrl || !pgUrl)("Oracle to PostgreSQL, the whole journey (real Oracle, real PostgreSQL)", () => {
    let db: Awaited<ReturnType<typeof createTestAppDb>>;
    let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
    let base = "";
    let cookie = "";
    let oracleSchema = "";
    let cloudDatabase = "";
    const pgAdmin = adminConfigFromUrl(pgUrl ?? "postgres://x:y@127.0.0.1/postgres");

    const api = async (method: string, url: string, body?: unknown) => {
        const response = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
        const set = response.headers.get("set-cookie");
        if (set) cookie = set.split(";")[0];
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined };
    };
    const run = async (id: string, sql: string, sessionId = "flow-session-0001") => (await api("POST", `/api/connections/${id}/sql/run`, { sessionId, sql, transactional: false })).body;

    let oracleId = "";
    let pgId = "";
    const report: unknown[] = [];

    beforeAll(async () => {
        db = await createTestAppDb();
        await migrate(db);
        const stores = await createPgStores(db);
        installConnectionStore(stores.connections);
        installAiStores({ settings: stores.settings, audit: stores.audit });
        installCloud({ users: stores.users, sessions: stores.sessions, projects: stores.projects, admin: pgAdmin, maxDatabasesPerUser: 3, allowSignup: false, secureCookies: false });
        installOracleServer(oracleServerFromEnv({ ORACLE_ADMIN_URL: oracleUrl, MAX_ORACLE_DATABASES_PER_USER: "3" } as NodeJS.ProcessEnv));
        server = createApp().listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        if (oracleSchema) await dropOracleSchema(getOracleServer()!.admin, oracleSchema).catch(() => undefined);
        if (cloudDatabase) await dropCloudDatabase(pgAdmin, cloudDatabase).catch(() => undefined);
        installCloud(undefined);
        installConnectionStore(undefined);
        installOracleServer(null);
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
        if (process.env.FLOW_REPORT) fs.writeFileSync(process.env.FLOW_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    });

    it("1. an account signs up and creates an Oracle database from Oracle DDL", async () => {
        expect((await api("POST", "/api/auth/signup", { email: "flow@example.com", password: "correct horse battery staple" })).status).toBe(201);
        const created = await api("POST", "/api/oracle-databases", { name: "insurance legacy", sql: domain("legacy_schema.sql") });
        expect(created.status).toBe(201);
        expect(created.body.statementsRun).toBe(3);
        oracleId = created.body.connection.id;
        oracleSchema = created.body.connection.username;
        expect(created.body.connection).toMatchObject({ engine: "oracle", kind: "cloud" });
    });

    it("2. synthetic legacy data goes into it, from the SQL page's own route", async () => {
        const outcome = await run(oracleId, domain("generate_synthetic_data_oracle.sql"));
        expect(outcome.ok, JSON.stringify(outcome.error)).toBe(true);
        expect(outcome.results[1].rows[0].slice(0, 1)).toEqual(["200"]);
        const counts = await run(oracleId, "SELECT (SELECT COUNT(*) FROM cust_mst), (SELECT COUNT(*) FROM polcy_hdr), (SELECT COUNT(*) FROM clm_dtl) FROM dual");
        const [customers, policies, claims] = counts.results[0].rows[0].map(Number);
        expect([customers, policies > 200, claims > 100]).toEqual([200, true, true]);
    });

    it("3. migrates the Oracle database to a new PostgreSQL cloud database, and every table arrives whole", async () => {
        const plan = await api("POST", "/api/migrations/oracle-to-postgres/plan", { sourceConnectionId: oracleId });
        expect(plan.status).toBe(200);
        expect(plan.body.problems).toEqual([]);
        expect(plan.body.tables.map((t: { pgName: string }) => t.pgName)).toEqual(["clm_dtl", "cust_mst", "polcy_hdr"]);

        const migrated = await api("POST", "/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, name: "insurance postgres", target: { kind: "cloud" } });
        expect(migrated.status, JSON.stringify(migrated.body)).toBe(201);
        pgId = migrated.body.connection.id;
        cloudDatabase = migrated.body.connection.database;
        expect(migrated.body.connection).toMatchObject({ kind: "cloud", name: "insurance postgres" });
        expect(migrated.body.connection.engine ?? "postgres").toBe("postgres");
        expect(migrated.body.tables.map((t: { name: string; rows: number }) => t.name)).toEqual(["clm_dtl", "cust_mst", "polcy_hdr"]);
        expect(migrated.body.verification.every((v: { mismatches: string[] }) => v.mismatches.length === 0)).toBe(true);

        // the new database is an ordinary PostgreSQL connection now: it is listed with the PostgreSQL ones and the Oracle one is not
        const listed = ((await api("GET", "/api/connections")).body as { id: string }[]).map((c) => c.id);
        expect(listed).toContain(pgId);
        expect(listed).not.toContain(oracleId);

        // and the rows are really there, from the app's own SQL route
        const sql = await run(pgId, "SELECT (SELECT count(*) FROM cust_mst), (SELECT count(*) FROM polcy_hdr), (SELECT count(*) FROM clm_dtl)", "flow-session-0002");
        expect(sql.ok).toBe(true);
        expect(sql.results[0].rows[0].map(Number)).toEqual(migrated.body.tables.slice().sort((a: { name: string }, b: { name: string }) => ["cust_mst", "polcy_hdr", "clm_dtl"].indexOf(a.name) - ["cust_mst", "polcy_hdr", "clm_dtl"].indexOf(b.name)).map((t: { rows: number }) => t.rows));
    }, 180_000);

    it("4. every legacy Oracle query runs on Oracle, is converted, runs on the migrated PostgreSQL, and the results are compared", async () => {
        for (const query of LEGACY_QUERIES) {
            const oracle = await run(oracleId, query.sql.trim().replace(/;\s*$/, ""));
            expect(oracle.ok, `${query.name} on Oracle: ${JSON.stringify(oracle.error)}`).toBe(true);
            const reference = oracle.results[0];

            const conversion = convertQuery({ sql: query.sql, dialect: "oracle" });
            const traps = conversion.traps.map((trap) => trap.title);
            const unconverted = conversion.unconverted.map((item) => item.construct);
            const postgres = await run(pgId, conversion.validationSql, "flow-session-0003");
            const ranOnPostgres = postgres.ok === true;

            let verdict: "equal" | "different" | "did not run on PostgreSQL" = "did not run on PostgreSQL";
            let detail = ranOnPostgres ? "" : String(postgres.error?.message ?? "").split("\n")[0];
            if (ranOnPostgres) {
                const actual = postgres.results[0];
                const comparison = compareResults(
                    { columns: reference.columns.map((c: { name: string }) => c.name), rows: reference.rows },
                    { columns: actual.columns.map((c: { name: string; dataType: string }) => ({ name: c.name, category: categoryOfName(c.dataType) })), rows: actual.rows, truncated: actual.truncated },
                    { orderSensitive: false },
                );
                verdict = comparison.passed ? "equal" : "different";
                detail = comparison.passed ? "" : comparison.message;
            }
            report.push({ query: query.name, oracleRows: reference.rows.length, converted: conversion.sql, traps, unconverted, verdict, detail });

            // The property that matters: when the converter says it converted everything and warned about nothing, the answer must be the same.
            if (traps.length === 0 && unconverted.length === 0) expect(verdict, `${query.name}: converted without a warning but the results ${verdict} (${detail})`).toBe("equal");
            // And a difference is never silent: either the converter flagged something, or the query is equal.
            if (verdict !== "equal") expect(traps.length + unconverted.length, `${query.name}: ${verdict}, with no warning at all`).toBeGreaterThan(0);
        }
        // the journey really did find the known traps: the plain conversion is not enough for every legacy query
        expect(report.filter((entry) => (entry as { verdict: string }).verdict !== "equal").length).toBeGreaterThan(0);
        expect(report.filter((entry) => (entry as { verdict: string }).verdict === "equal").length).toBeGreaterThan(0);
    }, 300_000);

    // Optional, because it calls a model: FLOW_AI=1 with OPENAI_API_KEY set. Each query that is not yet equal gets up to three corrections, and the
    // model is shown what was measured on this very data (missing and unexpected rows, or PostgreSQL's error), never asked if it is right.
    it.skipIf(process.env.FLOW_AI !== "1" || !process.env.OPENAI_API_KEY)("4b. the queries that are not equal are corrected, with the measured difference as the evidence, and checked again", async () => {
        const tables = (await run(pgId, "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position", "flow-session-0004")).results[0].rows as string[][];
        const schema = { tables: [...new Set(tables.map((r) => r[0]))].map((name) => ({ name, columns: tables.filter((r) => r[0] === name).map((r) => ({ name: r[1], type: r[2] })) })) };

        const todo = report.filter((entry) => (entry as { verdict: string }).verdict !== "equal") as { query: string; converted: string; traps: string[]; unconverted: string[]; verdict: string; detail: string; corrections?: unknown[]; correctedTo?: string }[];
        expect(todo.length).toBeGreaterThan(0);
        for (const entry of todo) {
            const legacy = LEGACY_QUERIES.find((q) => q.name === entry.query)!;
            const reference = (await run(oracleId, legacy.sql.trim().replace(/;\s*$/, ""))).results[0];
            let sql = convertQuery({ sql: legacy.sql, dialect: "oracle" }).validationSql;
            entry.corrections = [];
            for (let attempt = 1; attempt <= 3; attempt++) {
                const postgres = await run(pgId, sql, "flow-session-0005");
                let evidence;
                if (postgres.ok !== true) {
                    evidence = { kind: "error" as const, message: String(postgres.error?.message ?? "").split("\n")[0], expectedColumns: reference.columns.map((c: { name: string }) => c.name.toLowerCase()), missingRows: [], unexpectedRows: [], missingCount: 0, unexpectedCount: 0, differingColumns: [], brokenInvariants: [], staticFindings: [] };
                } else {
                    const actual = postgres.results[0];
                    const columns = actual.columns.map((c: { name: string; dataType: string }) => ({ name: c.name, category: categoryOfName(c.dataType) }));
                    const comparison = compareResults({ columns: reference.columns.map((c: { name: string }) => c.name), rows: reference.rows }, { columns, rows: actual.rows, truncated: actual.truncated });
                    if (comparison.passed) {
                        entry.verdict = "equal";
                        entry.correctedTo = sql;
                        break;
                    }
                    evidence = {
                        kind: "mismatch" as const, message: comparison.message, expectedColumns: reference.columns.map((c: { name: string }) => c.name.toLowerCase()), columnProblem: comparison.columnProblem,
                        missingRows: comparison.missing.slice(0, 20), unexpectedRows: comparison.additional.slice(0, 20), missingCount: comparison.missingCount, unexpectedCount: comparison.additionalCount,
                        differingColumns: comparison.columnProblem ? [] : differingColumns(reference.columns.map((c: { name: string }) => c.name), columns.map((c: { category: Category }) => c.category), comparison.missing, comparison.additional), brokenInvariants: [], staticFindings: [],
                    };
                }
                const { result } = await createQueryCorrection({ legacySql: legacy.sql, sourceDialect: "oracle", businessPurpose: legacy.name, schema, mapping: [], previousSql: sql, attempt, maxAttempts: 3, evidence, engineWarnings: [...entry.traps, ...entry.unconverted] });
                (entry.corrections as unknown[]).push({ attempt, evidence: evidence.message, proposed: result.sql, explanation: result.explanation });
                sql = result.sql.replace(/;\s*$/, "");
                expect(/\bvalues\s*\(/i.test(sql) && !/values/i.test(legacy.sql), `${entry.query}: the model wrote the evidence back as a VALUES list`).toBe(false);
            }
        }
    }, 600_000);

    it("5. deleting the Oracle database and the PostgreSQL database removes both from their servers", async () => {
        expect((await api("DELETE", `/api/connections/${oracleId}?dropDatabase=true`)).status).toBe(204);
        expect((await api("DELETE", `/api/connections/${pgId}?dropDatabase=true`)).status).toBe(204);
        const [{ rows: users }, gone] = await Promise.all([
            import("../services/oracle-client.js").then(({ withOracle }) => withOracle(getOracleServer()!.admin, async (c) => ({ rows: (await c.execute("SELECT count(*) FROM dba_users WHERE username = :n", { n: oracleSchema })).rows as number[][] }))),
            import("../services/pg-client.js").then(({ withPgClient }) => withPgClient(pgAdmin, async (client) => (await client.query("SELECT count(*)::int AS n FROM pg_database WHERE datname = $1", [cloudDatabase])).rows[0].n as number)),
        ]);
        expect(users[0][0]).toBe(0);
        expect(gone).toBe(0);
        oracleSchema = "";
        cloudDatabase = "";
    }, 60_000);
});
