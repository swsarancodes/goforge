import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The migration page's server side over HTTP, on a real Oracle and a real PostgreSQL: the plan with edits, the assistant (the model is the
 * only thing stood in for), the refusal to migrate over a loss nobody accepted, the migration under the new names and types, and the proof.
 * Set ORACLE_TEST_ADMIN_URL=oracle://system:pw@127.0.0.1:1521/FREEPDB1 and PG_TEST_ADMIN_URL=postgres://postgres:pw@127.0.0.1:54330/postgres. Skipped without both.
 */
const oracleUrl = process.env.ORACLE_TEST_ADMIN_URL;
const pgUrl = process.env.PG_TEST_ADMIN_URL;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goforge-migration-edits-"));
process.env.SQLITE_PATH = path.join(dir, "connections.db");
process.env.MASTER_KEY = randomBytes(32).toString("base64");

const { createApp } = await import("../app.js");
const { defaultMigrationDeps } = await import("./migrations.js");
const { getConnectionStore, LOCAL_OWNER } = await import("../db/stores.js");
const { createOracleSchema, dropOracleSchema, newSchemaPassword, oracleConnectionRow, oracleSchemaName, oracleServerFromEnv } = await import("../services/oracle-schemas.js");
const { oracleSql } = await import("../services/oracle-sql.js");
const { adminConfigFromUrl } = await import("../services/cloud-databases.js");
const { withPgClient } = await import("../services/pg-client.js");
const { AiNotConfiguredError } = await import("../ai/provider.js");
const { withOracle } = await import("../services/oracle-client.js");

const DDL = `CREATE TABLE pol (id NUMBER(6) PRIMARY KEY, started DATE NOT NULL, ended DATE, active NUMBER(1) DEFAULT 1, qty VARCHAR2(10));
    CREATE TABLE ev (ev_id NUMBER(6) PRIMARY KEY, pol_id NUMBER(6) REFERENCES pol (id), happened TIMESTAMP(3))`;
const ROWS = `
    INSERT INTO pol VALUES (1, DATE '2026-01-01', DATE '2026-12-31', 1, '7');
    INSERT INTO pol VALUES (2, TO_DATE('2026-03-04 09:30:00', 'YYYY-MM-DD HH24:MI:SS'), NULL, 0, '12');
    INSERT INTO pol VALUES (3, DATE '2026-05-05', DATE '2027-05-05', 1, '30');
    INSERT INTO ev VALUES (10, 1, TIMESTAMP '2026-01-02 03:04:05.678');
`;

let stubbed: { reply: string; operations: unknown[] } | Error = { reply: "", operations: [] };
const asked: unknown[] = [];
let summaryStub: { summary: string } | Error = { summary: "" };
const summaryAsked: unknown[] = [];

describe.skipIf(!oracleUrl || !pgUrl)("the migration page over HTTP (real Oracle, real PostgreSQL)", () => {
    const admin = oracleServerFromEnv({ ORACLE_ADMIN_URL: oracleUrl } as NodeJS.ProcessEnv)?.admin as NonNullable<ReturnType<typeof oracleServerFromEnv>>["admin"];
    let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
    let base = "";
    let schema = "";
    let schemaPassword = "";
    let oracleId = "";
    let pgServerId = "";
    const databases: string[] = [];

    const post = async (url: string, body: unknown) => {
        const response = await fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: response.status, body: (await response.json()) as any };
    };

    beforeAll(async () => {
        const password = newSchemaPassword();
        schemaPassword = password;
        schema = oracleSchemaName("0a1b2c3d-0000-0000-0000-000000000001", `edits_${Math.random().toString(36).slice(2, 6)}`);
        await createOracleSchema(admin, schema, password, DDL);
        const row = oracleConnectionRow(admin, schema, "edits", password);
        const ran = await oracleSql.run(row, "edits-0001", ROWS);
        expect(ran.ok).toBe(true);
        await getConnectionStore().insert(LOCAL_OWNER, { ...row, kind: "external" });
        oracleId = row.id;

        server = createApp({
            migrations: {
                ...defaultMigrationDeps,
                summary: async (input) => {
                    summaryAsked.push(input);
                    if (summaryStub instanceof Error) throw summaryStub;
                    return { result: summaryStub as { summary: string }, model: "stand-in" };
                },
                agent: async (input) => {
                    asked.push(input);
                    if (stubbed instanceof Error) throw stubbed;
                    return { result: stubbed as { reply: string; operations: any[] }, model: "stand-in" };
                },
            },
        }).listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        const pg = adminConfigFromUrl(pgUrl!);
        const saved = await post("/api/connections", { name: "pg", host: pg.host, port: pg.port, username: pg.user, password: pg.password, database: "postgres", sslMode: "disable" });
        pgServerId = saved.body.id;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        await dropOracleSchema(admin, schema).catch(() => undefined);
        const pg = adminConfigFromUrl(pgUrl!);
        for (const database of databases) await withPgClient(pg, (client) => client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)).catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("plans with no edits, and says what is left behind and how each column fares", async () => {
        const plan = await post("/api/migrations/oracle-to-postgres/plan", { sourceConnectionId: oracleId });
        expect(plan.status).toBe(200);
        expect(plan.body.problems).toEqual([]);
        expect(plan.body.editProblems).toEqual([]);
        const pol = plan.body.tables.find((t: any) => t.oracleName === "POL");
        expect(pol.columns.find((c: any) => c.oracleName === "STARTED")).toMatchObject({ pgType: "timestamp(0)", edited: [], note: { status: "changed" } });
        expect(pol.columns.every((c: any) => c.check === undefined)).toBe(true);
    });

    it("lets the assistant change the plan through operations the server checks, and says what it refused and why", async () => {
        stubbed = {
            reply: "I made the dates real dates and renamed the table.",
            operations: [
                { op: "set_column_type", table: "POL", column: "STARTED", pgType: "date" },
                { op: "set_column_type", table: "POL", column: "ENDED", pgType: "date" },
                { op: "rename_table", table: "POL", newName: "policy" },
                { op: "set_column_type", table: "POL", column: "STARTED", pgType: "money" },
                { op: "rename_table", table: "GHOST", newName: "x" },
            ],
        };
        const answer = await post("/api/migrations/oracle-to-postgres/agent", { sourceConnectionId: oracleId, message: "make the dates real dates and call the table policy", messages: [{ role: "user", text: "hello" }] });
        expect(answer.status).toBe(200);
        expect(answer.body.reply).toContain("real dates");
        expect(answer.body.applied).toEqual(["make POL.STARTED date", "make POL.ENDED date", "rename table POL to policy"]);
        expect(answer.body.rejected.map((r: any) => r.reason)).toEqual([expect.stringContaining('"money" is not a type this migration knows'), "there is no table GHOST"]);
        expect(answer.body.edits).toEqual({ tables: { POL: { pgName: "policy" } }, columns: { "POL.STARTED": { pgType: "date" }, "POL.ENDED": { pgType: "date" } } });

        const policy = answer.body.plan.tables.find((t: any) => t.oracleName === "POL");
        expect(policy.pgName).toBe("policy");
        expect(policy.columns.find((c: any) => c.oracleName === "STARTED").check).toMatchObject({ count: 1, description: "values with a time of day, which a date does not keep" });
        expect(policy.columns.find((c: any) => c.oracleName === "ENDED").check).toMatchObject({ count: 0 });

        // the model was shown names, types and counts: never a row
        const seen = JSON.stringify(asked[0]);
        expect(seen).toContain("allowedPgTypes");
        expect(seen).not.toContain("2026-03-04");
    });

    it("keeps the earlier changes when the next message changes something else", async () => {
        stubbed = { reply: "Active is a boolean now.", operations: [{ op: "set_column_type", table: "POL", column: "ACTIVE", pgType: "boolean" }] };
        const first = await post("/api/migrations/oracle-to-postgres/agent", { sourceConnectionId: oracleId, message: "make ACTIVE a boolean", edits: { tables: { POL: { pgName: "policy" } }, columns: { "POL.STARTED": { pgType: "date" } } } });
        expect(first.body.edits).toEqual({ tables: { POL: { pgName: "policy" } }, columns: { "POL.STARTED": { pgType: "date" }, "POL.ACTIVE": { pgType: "boolean" } } });
        stubbed = { reply: "Back to how it was.", operations: [{ op: "reset_column", table: "POL", column: "STARTED" }, { op: "reset_table", table: "POL" }] };
        const second = await post("/api/migrations/oracle-to-postgres/agent", { sourceConnectionId: oracleId, message: "undo the date and the name", edits: first.body.edits });
        expect(second.body.edits).toEqual({ tables: {}, columns: { "POL.ACTIVE": { pgType: "boolean" } } });
    });

    it("answers a question without changing anything", async () => {
        stubbed = { reply: "A DATE keeps its time of day.", operations: [] };
        const edits = { tables: {}, columns: { "POL.ENDED": { pgType: "date" } } };
        const answer = await post("/api/migrations/oracle-to-postgres/agent", { sourceConnectionId: oracleId, message: "does a DATE keep its time?", edits });
        expect(answer.body).toMatchObject({ reply: "A DATE keeps its time of day.", applied: [], rejected: [], edits });
    });

    it("says so when the model is not set up, or the request is not valid", async () => {
        stubbed = new AiNotConfiguredError("No OpenAI API key is set.");
        const unset = await post("/api/migrations/oracle-to-postgres/agent", { sourceConnectionId: oracleId, message: "hi" });
        expect(unset.status).toBe(503);
        expect(unset.body.error).toBe("No OpenAI API key is set.");
        stubbed = new Error("boom");
        expect((await post("/api/migrations/oracle-to-postgres/agent", { sourceConnectionId: oracleId, message: "hi" })).status).toBe(502);
        expect((await post("/api/migrations/oracle-to-postgres/agent", { sourceConnectionId: oracleId, message: "" })).status).toBe(400);
        expect((await post("/api/migrations/oracle-to-postgres/agent", { sourceConnectionId: "nope", message: "hi" })).status).toBe(404);
    });

    it("refuses to migrate over a loss nobody accepted, then migrates under the new names and types once it is, and proves it", async () => {
        const edits = { tables: { POL: { pgName: "policy" } }, columns: { "POL.STARTED": { pgType: "date" }, "POL.ENDED": { pgType: "date" }, "POL.ACTIVE": { pgType: "boolean" } } };
        const database = `edits_test_${Math.random().toString(36).slice(2, 8)}`;
        databases.push(database);
        const target = { kind: "server", connectionId: pgServerId, database };

        const refused = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, name: "edits", target, edits });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe("data-loss-not-accepted");
        expect(refused.body.error).toContain("policy.started (1 values with a time of day, which a date does not keep)");
        expect(refused.body.checks).toEqual([expect.objectContaining({ table: "policy", column: "started", count: 1 })]);
        // nothing was created
        const exists = await withPgClient(adminConfigFromUrl(pgUrl!), async (client) => (await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database])).rowCount);
        expect(exists).toBe(0);

        const done = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, name: "edits", target, edits, acceptLoss: true });
        expect(done.status).toBe(201);
        expect(done.body.tables).toEqual([{ name: "ev", rows: 1 }, { name: "policy", rows: 3 }]);
        expect(done.body.verification.every((v: any) => v.mismatches.length === 0)).toBe(true);
        const policy = done.body.verification.find((v: any) => v.table === "policy");
        expect(policy.proof.checks.find((c: any) => c.label === "first started")).toMatchObject({ oracle: "2026-01-01", postgres: "2026-01-01", match: true });

        const again = await post("/api/migrations/oracle-to-postgres/verify", { sourceConnectionId: oracleId, targetConnectionId: done.body.connection.id, edits });
        expect(again.status).toBe(200);
        expect(again.body.verification.every((v: any) => v.mismatches.length === 0)).toBe(true);
        // without the edits the names do not line up, and the comparison says it cannot be made rather than passing
        const wrong = await post("/api/migrations/oracle-to-postgres/verify", { sourceConnectionId: oracleId, targetConnectionId: done.body.connection.id });
        expect(wrong.status).toBe(502);
    }, 180_000);

    it("builds the report from the plan and the data, with samples, and the same fingerprint every time", async () => {
        const first = await post("/api/migrations/oracle-to-postgres/report", { sourceConnectionId: oracleId });
        expect(first.status).toBe(200);
        const { report } = first.body;
        expect(report).toMatchObject({ source: "edits", dataRead: true, verdict: "ready", summary: { tables: 2, columns: 8, rows: 4 } });
        expect(report.hash).toMatch(/^[0-9a-f]{64}$/);
        const pol = report.tables.find((t: any) => t.oracleName === "POL");
        expect(pol.sample).toMatchObject({ ordered: true, columns: ["id", "started", "ended", "active", "qty"] });
        expect(pol.sample.oracle).toHaveLength(3);
        expect(pol.columns.find((c: any) => c.oracleName === "STARTED")).toMatchObject({ facts: { nulls: 0, values: 3, affected: [{ count: 1 }] }, dataChange: { effect: "kept" } });
        const again = await post("/api/migrations/oracle-to-postgres/report", { sourceConnectionId: oracleId });
        expect(again.body.report.hash).toBe(report.hash);
        // an edit is a different report
        const edited = await post("/api/migrations/oracle-to-postgres/report", { sourceConnectionId: oracleId, edits: { tables: {}, columns: { "POL.STARTED": { pgType: "date" } } } });
        expect(edited.body.report.hash).not.toBe(report.hash);
        expect(edited.body.report).toMatchObject({ verdict: "needs-acceptance", mustAccept: [{ table: "pol", column: "started", count: 1 }], summary: { changesByYou: 1 } });
    });

    it("has the model write the opening paragraph from the figures alone, and hands it back to be labelled", async () => {
        summaryStub = { summary: "Two tables move; nothing blocks them." };
        const answer = await post("/api/migrations/oracle-to-postgres/report/summary", { sourceConnectionId: oracleId });
        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({ summary: "Two tables move; nothing blocks them.", model: "stand-in" });
        const report = (await post("/api/migrations/oracle-to-postgres/report", { sourceConnectionId: oracleId })).body.report;
        expect(answer.body.reportHash).toBe(report.hash);
        // the model was shown names, counts and notes: never a row
        const seen = JSON.stringify(summaryAsked.at(-1));
        expect(seen).toContain("columnsToRead");
        expect(seen).not.toContain("2026-03-04");
        expect(seen).not.toContain("SELECT COUNT");
        summaryStub = new AiNotConfiguredError("No OpenAI API key is set.");
        const unset = await post("/api/migrations/oracle-to-postgres/report/summary", { sourceConnectionId: oracleId });
        expect([unset.status, unset.body.error]).toEqual([503, "No OpenAI API key is set."]);
        summaryStub = new Error("boom");
        expect((await post("/api/migrations/oracle-to-postgres/report/summary", { sourceConnectionId: oracleId })).status).toBe(502);
    });

    it("migrates only the report that was approved: a stale fingerprint is refused, and nothing is created", async () => {
        const database = `approve_test_${Math.random().toString(36).slice(2, 8)}`;
        databases.push(database);
        const target = { kind: "server", connectionId: pgServerId, database };
        const report = (await post("/api/migrations/oracle-to-postgres/report", { sourceConnectionId: oracleId })).body.report;

        const wrong = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, name: "approve", target, approval: { reportHash: "0".repeat(64) } });
        expect(wrong.status).toBe(409);
        expect(wrong.body.code).toBe("report-changed");
        const exists = async () => withPgClient(adminConfigFromUrl(pgUrl!), async (client) => (await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database])).rowCount);
        expect(await exists()).toBe(0);

        // the data moves after the report was read: the approval no longer fits
        await withOracle({ ...admin, user: schema, password: schemaPassword }, async (c) => {
            await c.execute("INSERT INTO pol VALUES (4, DATE '2026-07-07', NULL, 1, '5')", [], { autoCommit: true });
        });
        const moved = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, name: "approve", target, approval: { reportHash: report.hash } });
        expect(moved.status).toBe(409);
        expect(await exists()).toBe(0);

        const fresh = (await post("/api/migrations/oracle-to-postgres/report", { sourceConnectionId: oracleId })).body.report;
        expect(fresh.hash).not.toBe(report.hash);
        const done = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, name: "approve", target, approval: { reportHash: fresh.hash } });
        expect(done.status).toBe(201);
        expect(done.body.approval).toEqual({ reportHash: fresh.hash, approvedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
        expect(done.body.verification.every((v: any) => v.mismatches.length === 0)).toBe(true);

        // without an approval the migration still runs (the page always sends one)
        const database2 = `approve_test_${Math.random().toString(36).slice(2, 8)}`;
        databases.push(database2);
        const plain = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, name: "plain", target: { kind: "server", connectionId: pgServerId, database: database2 } });
        expect(plain.status).toBe(201);
        expect(plain.body.approval).toBeNull();
    }, 180_000);
});
