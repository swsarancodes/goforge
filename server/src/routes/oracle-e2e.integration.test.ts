import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The whole path over HTTP against a real Oracle: set ORACLE_TEST_ADMIN_URL=oracle://system:password@127.0.0.1:1521/FREEPDB1. Skipped without it. */
const url = process.env.ORACLE_TEST_ADMIN_URL;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goforge-oracle-e2e-"));
process.env.SQLITE_PATH = path.join(dir, "connections.db");
process.env.MASTER_KEY = randomBytes(32).toString("base64");
process.env.MAX_ORACLE_DATABASES_PER_USER = "3";

const { createApp } = await import("../app.js");
const { installOracleServer, oracleServerFromEnv, getOracleServer } = await import("../services/oracle-schemas.js");
const { withOracle } = await import("../services/oracle-client.js");

describe.skipIf(!url)("Oracle databases over HTTP (real Oracle)", () => {
    let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
    let base = "";
    const api = async (method: string, route: string, body?: unknown) => {
        const response = await fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined };
    };

    beforeAll(async () => {
        installOracleServer(oracleServerFromEnv({ ORACLE_ADMIN_URL: url, MAX_ORACLE_DATABASES_PER_USER: "3" } as NodeJS.ProcessEnv));
        server = createApp().listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("creates a database from Oracle DDL, runs Oracle SQL in it, tests the connection, and deletes it for good", async () => {
        const ddl = fs.readFileSync(path.resolve(import.meta.dirname, "../../../queryshift/domain/legacy_schema.sql"), "utf8");
        const created = await api("POST", "/api/oracle-databases", { name: "insurance", sql: ddl });
        expect(created.status).toBe(201);
        expect(created.body.statementsRun).toBe(4);
        const id = created.body.connection.id as string;
        const schema = created.body.connection.username as string;
        expect(created.body.connection.engine).toBe("oracle");

        expect(((await api("GET", "/api/oracle-databases/status")).body)).toMatchObject({ configured: true, limit: 3, used: 1 });
        expect((await api("POST", `/api/connections/${id}/test`)).body).toEqual({ ok: true });

        const sessionId = "e2e-session-0001";
        const insert = await api("POST", `/api/connections/${id}/sql/run`, { sessionId, sql: "INSERT INTO cust_mst VALUES (1, 'Asha', NULL, 'RET', DATE '2019-04-12');\nINSERT INTO polcy_hdr VALUES (101, 1, 'AUTO', DATE '2026-01-01', DATE '2026-12-31', 1200.5, 'AC');" });
        expect(insert.body.ok).toBe(true);
        const legacy = await api("POST", `/api/connections/${id}/sql/run`, {
            sessionId,
            // a legacy Oracle query, written as it would have been: (+) join, NVL, TO_DATE
            sql: "SELECT c.cust_id, c.cust_nm, COUNT(p.polcy_id) AS polcy_cnt, SUM(NVL(p.annl_prem, 0)) AS tot_prem FROM cust_mst c, polcy_hdr p WHERE c.cust_id = p.cust_id(+) AND p.eff_dt(+) >= TO_DATE('2026-01-01', 'YYYY-MM-DD') GROUP BY c.cust_id, c.cust_nm ORDER BY c.cust_id;",
        });
        expect(legacy.body.ok).toBe(true);
        expect(legacy.body.results[0].rows).toEqual([["1", "Asha", "1", "1200.5"]]);
        expect(legacy.body.results[0].columns.map((c: { name: string }) => c.name)).toEqual(["CUST_ID", "CUST_NM", "POLCY_CNT", "TOT_PREM"]);

        expect((await api("DELETE", `/api/connections/${id}`)).status).toBe(409);
        expect((await api("DELETE", `/api/connections/${id}?dropDatabase=true`)).status).toBe(204);
        const admin = getOracleServer()!.admin;
        const gone = await withOracle(admin, async (c) => ((await c.execute("SELECT count(*) FROM dba_users WHERE username = :n", { n: schema })).rows as number[][])[0][0]);
        expect(gone).toBe(0);
        expect(((await api("GET", "/api/connections?engine=all")).body as unknown[]).length).toBe(0);
    });
});
