import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Carrying indexes and CHECK constraints over, on the migration page's server side, on a real Oracle and a real PostgreSQL: which of them the plan can
 * carry and why the rest cannot, asking the assistant to carry them (the model is the only thing stood in for), the report that says what is carried,
 * the migration that creates them after the rows and finds them in PostgreSQL's catalog, and the constraints really holding there.
 * Set ORACLE_TEST_ADMIN_URL and PG_TEST_ADMIN_URL as for migration-edits.integration.test.ts. Skipped without both.
 */
const oracleUrl = process.env.ORACLE_TEST_ADMIN_URL;
const pgUrl = process.env.PG_TEST_ADMIN_URL;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goforge-migration-carry-"));
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

const DDL = `CREATE TABLE clm (id NUMBER(6) PRIMARY KEY, pol NUMBER(6) NOT NULL, amt NUMBER(10,2), stat VARCHAR2(2), happened DATE);
    CREATE INDEX ix_clm_pol ON clm (pol, happened);
    CREATE UNIQUE INDEX ux_clm_amt ON clm (amt, stat);
    CREATE BITMAP INDEX ix_clm_stat ON clm (stat);
    CREATE INDEX ix_clm_upper ON clm (UPPER(stat));
    CREATE INDEX ix_clm_desc ON clm (happened DESC);
    ALTER TABLE clm ADD CONSTRAINT ck_amt CHECK (amt >= 0);
    ALTER TABLE clm ADD CONSTRAINT ck_stat CHECK (stat IN ('OP', 'CL') OR stat IS NULL);
    ALTER TABLE clm ADD CONSTRAINT ck_upper CHECK (UPPER(stat) = stat)`;
const ROWS = `
    INSERT INTO clm VALUES (1, 10, 100.50, 'OP', DATE '2026-01-01');
    INSERT INTO clm VALUES (2, 10, 0, 'CL', DATE '2026-02-03');
    INSERT INTO clm VALUES (3, 11, NULL, NULL, DATE '2026-03-04');
    INSERT INTO clm VALUES (4, 12, 5000, 'OP', DATE '2026-04-05');
    ALTER TABLE clm ADD CONSTRAINT ck_noval CHECK (amt < 1000) ENABLE NOVALIDATE;
`;

let stubbed: { reply: string; operations: unknown[] } = { reply: "", operations: [] };
const asked: any[] = [];
let reviewStub: { overview: string; findings: unknown[] } | Error = { overview: "", findings: [] };
const reviewAsked: any[] = [];

describe.skipIf(!oracleUrl || !pgUrl)("carrying indexes and CHECK constraints (real Oracle, real PostgreSQL)", () => {
    const admin = oracleServerFromEnv({ ORACLE_ADMIN_URL: oracleUrl } as NodeJS.ProcessEnv)?.admin as NonNullable<ReturnType<typeof oracleServerFromEnv>>["admin"];
    let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
    let base = "";
    let schema = "";
    let oracleId = "";
    let pgServerId = "";
    const databases: string[] = [];
    const pg = () => adminConfigFromUrl(pgUrl!);

    const post = async (url: string, body: unknown) => {
        const response = await fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: response.status, body: (await response.json()) as any };
    };

    beforeAll(async () => {
        const password = newSchemaPassword();
        schema = oracleSchemaName("0a1b2c3d-0000-0000-0000-000000000002", `carry_${Math.random().toString(36).slice(2, 6)}`);
        await createOracleSchema(admin, schema, password, DDL);
        const row = oracleConnectionRow(admin, schema, "carry", password);
        const ran = await oracleSql.run(row, "carry-0001", ROWS);
        expect(ran.ok, JSON.stringify(!ran.ok && ran.error)).toBe(true);
        await getConnectionStore().insert(LOCAL_OWNER, { ...row, kind: "external" });
        oracleId = row.id;
        server = createApp({
            migrations: {
                ...defaultMigrationDeps,
                review: async (input) => {
                    reviewAsked.push(input);
                    if (reviewStub instanceof Error) throw reviewStub;
                    return { result: reviewStub as { overview: string; findings: any[] }, model: "stand-in" };
                },
                agent: async (input) => {
                    asked.push(input);
                    return { result: stubbed as { reply: string; operations: any[] }, model: "stand-in" };
                },
            },
        }).listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const saved = await post("/api/connections", { name: "pg", host: pg().host, port: pg().port, username: pg().user, password: pg().password, database: "postgres", sslMode: "disable" });
        pgServerId = saved.body.id;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        await dropOracleSchema(admin, schema).catch(() => undefined);
        for (const database of databases) await withPgClient(pg(), (client) => client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)).catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const byName = (objects: any[], name: string) => objects.find((object) => object.oracleName === name);

    it("lists every index and CHECK constraint, says which can be carried and why the rest cannot, and carries none until asked", async () => {
        const plan = await post("/api/migrations/oracle-to-postgres/plan", { sourceConnectionId: oracleId });
        expect(plan.status).toBe(200);
        expect(plan.body.objects).toHaveLength(9);
        expect(plan.body.objects.every((object: any) => object.carried === false)).toBe(true);
        expect(plan.body.objects.filter((object: any) => object.carriable).map((object: any) => object.oracleName).sort()).toEqual(["CK_AMT", "CK_STAT", "IX_CLM_POL", "UX_CLM_AMT"]);
        expect(byName(plan.body.objects, "IX_CLM_STAT").reason).toMatch(/no bitmap/);
        expect(byName(plan.body.objects, "IX_CLM_UPPER").reason).toMatch(/expression/);
        expect(byName(plan.body.objects, "IX_CLM_DESC").reason).toMatch(/descending/);
        expect(byName(plan.body.objects, "CK_UPPER").reason).toMatch(/calls UPPER/);
        expect(byName(plan.body.objects, "CK_NOVAL").reason).toMatch(/not validated/);
        expect(plan.body.notCarried.filter((entry: any) => entry.canCarry === true).map((entry: any) => entry.name).sort()).toEqual(["CK_AMT", "CK_STAT", "IX_CLM_POL", "UX_CLM_AMT"]);
        expect(plan.body.statements).toBe(1); // the table only: nothing carried yet
    });

    it("lets the assistant carry them over, tells it what can and cannot be, and says what it refused and why", async () => {
        stubbed = {
            reply: "Carried the indexes and checks that can be.",
            operations: [
                { op: "carry_all", kind: "index" },
                { op: "carry_all", kind: "check" },
                { op: "carry_object", kind: "index", name: "IX_CLM_STAT" },
            ],
        };
        const answer = await post("/api/migrations/oracle-to-postgres/agent", { sourceConnectionId: oracleId, message: "carry over the indexes and check constraints too", messages: [], edits: {} });
        expect(answer.status).toBe(200);
        const sent = asked[asked.length - 1].state;
        expect(sent.objects).toHaveLength(9);
        expect(sent.objects.find((object: any) => object.name === "IX_CLM_POL")).toMatchObject({ kind: "index", canCarry: true, carried: false });
        expect(sent.objects.find((object: any) => object.name === "CK_UPPER")).toMatchObject({ canCarry: false, reason: expect.stringMatching(/UPPER/) });
        expect(answer.body.edits.objects).toEqual({ "index:IX_CLM_POL": { carry: true }, "index:UX_CLM_AMT": { carry: true }, "check:CK_AMT": { carry: true }, "check:CK_STAT": { carry: true } });
        expect(answer.body.rejected.map((entry: any) => entry.reason).join(" | ")).toMatch(/no bitmap/);
        expect(answer.body.plan.objects.filter((object: any) => object.carried)).toHaveLength(4);
        expect(answer.body.plan.notCarried.map((entry: any) => entry.name).sort()).toEqual(["CK_NOVAL", "CK_UPPER", "IX_CLM_DESC", "IX_CLM_STAT", "IX_CLM_UPPER"]);
        expect(answer.body.plan.statements).toBe(5);
    });

    it("puts what is carried in the report, changes its fingerprint, and refuses an approval of the report without it", async () => {
        const edits = { objects: { "index:IX_CLM_POL": { carry: true }, "check:CK_AMT": { carry: true } } };
        const plain = await post("/api/migrations/oracle-to-postgres/report", { sourceConnectionId: oracleId, edits: {} });
        const withCarry = await post("/api/migrations/oracle-to-postgres/report", { sourceConnectionId: oracleId, edits });
        expect(plain.body.report.carried).toEqual([]);
        expect(withCarry.body.report.carried.map((entry: any) => entry.name)).toEqual(["IX_CLM_POL", "CK_AMT"]);
        expect(withCarry.body.report.carried[1].sql).toBe('ALTER TABLE "clm" ADD CONSTRAINT "ck_amt" CHECK ("amt" >= 0)');
        expect(withCarry.body.report.summary).toMatchObject({ carried: 2, canBeCarried: 2 });
        expect(plain.body.report.summary).toMatchObject({ carried: 0, canBeCarried: 4 });
        expect(withCarry.body.report.hash).not.toBe(plain.body.report.hash);

        const database = `carry_stale_${Math.random().toString(36).slice(2, 8)}`;
        databases.push(database);
        const refused = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, edits, name: "stale", target: { kind: "server", connectionId: pgServerId, database }, approval: { reportHash: plain.body.report.hash } });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe("report-changed");
    });

    it("says so when the edits ask for something that cannot be carried, and leaves it behind", async () => {
        const plan = await post("/api/migrations/oracle-to-postgres/plan", { sourceConnectionId: oracleId, edits: { objects: { "check:CK_NOVAL": { carry: true }, "index:NOPE": { carry: true } } } });
        expect(plan.body.editProblems.join("\n")).toMatch(/check CK_NOVAL cannot be carried over: Oracle does not guarantee/);
        expect(plan.body.editProblems.join("\n")).toMatch(/no index NOPE/);
        expect(plan.body.objects.filter((object: any) => object.carried)).toHaveLength(0);
    });

    it("asks a separate reviewer for a second opinion, sends it the report and the changes and no row, and shows only findings about what is in the plan", async () => {
        const edits = { columns: { "CLM.AMT": { pgName: "amount" } }, objects: { "check:CK_AMT": { carry: true } } };
        const finding = (table: string | null, column: string | null, title: string) => ({ severity: "warning", table, column, title, detail: "d", suggestion: null });
        reviewStub = {
            overview: "Looks consistent.",
            findings: [finding("CLM", "AMT", "AMT is renamed"), finding("NO_SUCH_TABLE", null, "invented table"), finding("clm", "NOPE", "invented column"), finding(null, "AMT", "a column with no table"), finding(null, null, "the plan as a whole"), finding("CLM", "AMT", "AMT is renamed")],
        };
        const answer = await post("/api/migrations/oracle-to-postgres/review", { sourceConnectionId: oracleId, edits, focus: "is the rename safe?" });
        expect(answer.status).toBe(200);
        expect(answer.body.model).toBe("stand-in");
        expect(answer.body.review.overview).toBe("Looks consistent.");
        expect(answer.body.review.findings.map((entry: any) => entry.title)).toEqual(["AMT is renamed", "the plan as a whole"]);
        expect(answer.body.review.dropped).toBe(4);
        const report = await post("/api/migrations/oracle-to-postgres/report", { sourceConnectionId: oracleId, edits });
        expect(answer.body.reportHash).toBe(report.body.report.hash);

        const sent = reviewAsked.at(-1);
        expect(sent.focus).toBe("is the rename safe?");
        expect(sent.digest.changesTheyMade).toEqual(["column CLM.AMT is called amount", "check CK_AMT is carried over"]);
        expect(sent.digest.carriedOver).toEqual(["check CK_AMT amt >= 0"]);
        expect(sent.digest.leftBehind.join("\n")).toMatch(/index IX_CLM_STAT.*cannot be carried over, PostgreSQL has no bitmap/);
        expect(sent.digest.leftBehind.join("\n")).toMatch(/index IX_CLM_POL.*could be carried over if asked/);
        expect(sent.digest.tables[0].columns.find((entry: any) => entry.column === "AMT")).toMatchObject({ to: "numeric(10,2)", changedByThem: ["name"] });
        // the reviewer sees names, types and counts: no value of any row
        const text = JSON.stringify(sent);
        for (const value of ["100.5", "5000", "2026-02-03", "2026-04-05"]) expect(text, value).not.toContain(value);

        reviewStub = new AiNotConfiguredError("No OpenAI API key is set.");
        expect((await post("/api/migrations/oracle-to-postgres/review", { sourceConnectionId: oracleId })).status).toBe(503);
        reviewStub = new Error("boom");
        const failed = await post("/api/migrations/oracle-to-postgres/review", { sourceConnectionId: oracleId });
        expect(failed.status).toBe(502);
        expect(String(failed.body.error)).toMatch(/^The reviewer could not answer/);
    });

    it("creates them after the rows, finds each in PostgreSQL's catalog, proves the copy, and the constraints hold", async () => {
        const edits = { objects: { "index:IX_CLM_POL": { carry: true }, "index:UX_CLM_AMT": { carry: true }, "check:CK_AMT": { carry: true }, "check:CK_STAT": { carry: true } } };
        const report = await post("/api/migrations/oracle-to-postgres/report", { sourceConnectionId: oracleId, edits });
        const database = `carry_${Math.random().toString(36).slice(2, 8)}`;
        databases.push(database);
        const migrated = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, edits, name: "carry", target: { kind: "server", connectionId: pgServerId, database }, approval: { reportHash: report.body.report.hash } });
        expect(migrated.status, JSON.stringify(migrated.body)).toBe(201);
        expect(migrated.body.statementsRun).toBe(5);
        expect(migrated.body.carried.map((entry: any) => `${entry.kind}:${entry.name}`)).toEqual(["index:ix_clm_pol", "index:ux_clm_amt", "check:ck_amt", "check:ck_stat"]);
        expect(migrated.body.verification.every((entry: any) => entry.mismatches.length === 0 && entry.oracleRows === 4)).toBe(true);

        await withPgClient({ ...pg(), database }, async (client) => {
            const indexes = (await client.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'clm' ORDER BY indexname")).rows;
            expect(indexes.map((row: any) => row.indexname)).toEqual(["clm_pkey", "ix_clm_pol", "ux_clm_amt"]);
            expect(indexes.find((row: any) => row.indexname === "ux_clm_amt").indexdef).toMatch(/CREATE UNIQUE INDEX ux_clm_amt ON public\.clm USING btree \(amt, stat\)/);
            expect(indexes.find((row: any) => row.indexname === "ix_clm_pol").indexdef).toMatch(/\(pol, happened\)/);
            const checks = (await client.query("SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = 'clm'::regclass ORDER BY conname")).rows.map((row: any) => row.conname);
            expect(checks).toEqual(["ck_amt", "ck_stat"]);
            // they hold: a negative amount, an unknown status and a repeated (amt, stat) are all refused
            await expect(client.query("INSERT INTO clm VALUES (9, 1, -1, 'OP', now())")).rejects.toThrow(/ck_amt/);
            await expect(client.query("INSERT INTO clm VALUES (9, 1, 1, 'ZZ', now())")).rejects.toThrow(/ck_stat/);
            await expect(client.query("INSERT INTO clm VALUES (9, 1, 100.50, 'OP', now())")).rejects.toThrow(/ux_clm_amt/);
            // the one Oracle did not validate was left behind, so the row that breaks it was copied
            expect(Number((await client.query("SELECT count(*) FROM clm WHERE amt >= 1000")).rows[0].count)).toBe(1);
        });
    }, 120_000);

    it("migrates with nothing carried exactly as before: no indexes but the key, no checks", async () => {
        const database = `carry_none_${Math.random().toString(36).slice(2, 8)}`;
        databases.push(database);
        const migrated = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, edits: {}, name: "none", target: { kind: "server", connectionId: pgServerId, database } });
        expect(migrated.status).toBe(201);
        expect(migrated.body.carried).toEqual([]);
        await withPgClient({ ...pg(), database }, async (client) => {
            expect((await client.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'clm'")).rows.map((row: any) => row.indexname)).toEqual(["clm_pkey"]);
            expect(Number((await client.query("SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND conrelid = 'clm'::regclass")).rows[0].count)).toBe(0);
        });
    }, 120_000);
});
