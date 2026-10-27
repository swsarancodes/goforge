import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Local mode (no accounts), a real SQLite file, the real app, real HTTP. Oracle itself is replaced: see oracle.integration.test.ts for the real one.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goforge-oracle-routes-"));
process.env.SQLITE_PATH = path.join(dir, "connections.db");
process.env.MASTER_KEY = randomBytes(32).toString("base64");

const { createApp } = await import("../app.js");
const { installOracleServer, OracleSchemaError } = await import("../services/oracle-schemas.js");

type Call = { schema: string; password: string; sql: string };
const created: Call[] = [];
const dropped: string[] = [];
let failNext: Error | undefined;

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";

const api = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    const json = (response.headers.get("content-type") ?? "").includes("json") && text;
    return { status: response.status, body: json ? JSON.parse(text) : undefined };
};

beforeAll(async () => {
    installOracleServer({ admin: { host: "127.0.0.1", port: 1, user: "system", password: "not-real", database: "FREEPDB1", sslMode: "disable" }, maxSchemasPerUser: 50 });
    const app = createApp({
        oracleDatabases: {
            createSchema: async (_admin, schema, password, sql) => {
                if (failNext) {
                    const error = failNext;
                    failNext = undefined;
                    throw error;
                }
                created.push({ schema, password, sql });
                return { statementsRun: sql.split(";").filter((piece) => piece.trim()).length };
            },
            dropSchema: async (_admin, schema) => void dropped.push(schema),
        },
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    installOracleServer(null);
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
    created.length = 0;
    dropped.length = 0;
});

describe("/api/oracle-databases", () => {
    it("says whether Oracle is available and how much of the allowance is used", async () => {
        expect((await api("GET", "/api/oracle-databases/status")).body).toEqual({ configured: true, limit: 50, used: 0 });
        installOracleServer(undefined);
        expect((await api("GET", "/api/oracle-databases/status")).body).toEqual({ configured: false });
        expect((await api("POST", "/api/oracle-databases", { name: "x", sql: "CREATE TABLE t (id NUMBER)" })).status).toBe(404);
        installOracleServer({ admin: { host: "127.0.0.1", port: 1, user: "system", password: "not-real", database: "FREEPDB1", sslMode: "disable" }, maxSchemasPerUser: 50 });
    });

    it("creates a schema, saves a connection to it as that schema's own user, and never returns a password", async () => {
        const response = await api("POST", "/api/oracle-databases", { name: "Insurance demo", sql: "CREATE TABLE a (id NUMBER);\nCREATE TABLE b (id NUMBER);" });
        expect(response.status).toBe(201);
        expect(response.body.statementsRun).toBe(2);
        const connection = response.body.connection;
        expect(connection).toMatchObject({ name: "Insurance demo", engine: "oracle", kind: "cloud", sslMode: "disable", database: "FREEPDB1" });
        expect(connection.username).toMatch(/^GF_[0-9A-F]{8}_INSURANCE_DEMO$/);
        expect(JSON.stringify(response.body)).not.toContain(created[0].password);
        expect(connection.username).toBe(created[0].schema);
        expect(created[0].password).toMatch(/^Gf[0-9a-f]{36}$/);
    });

    it("keeps Oracle connections out of every list and page that is PostgreSQL only", async () => {
        const made = (await api("POST", "/api/oracle-databases", { name: "hidden", sql: "CREATE TABLE a (id NUMBER)" })).body.connection;
        const ids = async (query: string) => ((await api("GET", `/api/connections${query}`)).body as { id: string }[]).map((c) => c.id);
        expect(await ids("")).not.toContain(made.id);
        expect(await ids("?engine=postgres")).not.toContain(made.id);
        expect(await ids("?engine=oracle")).toContain(made.id);
        expect(await ids("?engine=all")).toContain(made.id);
        // pages that read PostgreSQL treat it as not found, instead of trying to speak PostgreSQL to Oracle
        const pages: [string, string][] = [
            ["GET", `/api/connections/${made.id}/introspect`],
            ["POST", `/api/connections/${made.id}/validate-sql`],
            ["GET", `/api/connections/${made.id}/schema-change/catalog`],
        ];
        for (const [method, route] of pages) {
            const response = await api(method, route, method === "POST" ? { sql: "SELECT 1" } : undefined);
            expect(response.status, `${method} ${route}`).toBe(404);
            expect(response.body?.error, `${method} ${route}`).toMatch(/not found/i);
        }
        // the Modernizer's preview reads Oracle too (the original query, next to the conversion), but only ever one SELECT: anything else is
        // refused before the database is touched
        for (const sql of ["DELETE FROM a", "UPDATE a SET id = 1", "SELECT 1 FROM dual; DELETE FROM a", "BEGIN NULL; END;"]) {
            const response = await api("POST", `/api/connections/${made.id}/query-preview`, { sql });
            expect(response.status, sql).toBe(400);
            expect(response.body?.error, sql).toMatch(/one SELECT at a time/i);
        }
        // the Data page reads Oracle too: its table list and rows are found (a request with no table is refused for that, not as "not found")
        expect((await api("GET", `/api/connections/${made.id}/data`)).status).toBe(400);
        // the SQL editor and connection management do know about it
        const status = await api("GET", `/api/connections/${made.id}/sql/sessions/abcdefgh1234`);
        expect(status.status).toBe(200);
        expect(status.body).toEqual({ exists: false, transaction: { open: false, hasChanges: false, startedAt: null } });
        expect((await api("POST", `/api/connections/${made.id}/sql/sessions/abcdefgh1234/commit`)).body).toEqual({ ok: true, transaction: { open: false, hasChanges: false, startedAt: null } });
    });

    it("limits how many an account can have, and refuses a duplicate name and a bad request", async () => {
        const used = ((await api("GET", "/api/oracle-databases/status")).body as { used: number }).used;
        installOracleServer({ admin: { host: "127.0.0.1", port: 1, user: "system", password: "not-real", database: "FREEPDB1", sslMode: "disable" }, maxSchemasPerUser: used });
        const over = await api("POST", "/api/oracle-databases", { name: "one-too-many", sql: "CREATE TABLE a (id NUMBER)" });
        expect(over.status).toBe(403);
        expect(over.body.code).toBe("oracle-database-limit");
        expect(over.body.error).toMatch(new RegExp(`${used} Oracle databases`));
        expect(created.some((call) => call.schema.endsWith("ONE_TOO_MANY"))).toBe(false);
        installOracleServer({ admin: { host: "127.0.0.1", port: 1, user: "system", password: "not-real", database: "FREEPDB1", sslMode: "disable" }, maxSchemasPerUser: 50 });
        expect((await api("POST", "/api/oracle-databases", { name: "", sql: "x" })).status).toBe(400);
        expect((await api("POST", "/api/oracle-databases", { name: "ok" })).status).toBe(400);
    });

    it("reports what went wrong with the script, the server or the name, as the right status", async () => {
        const before = ((await api("GET", "/api/connections?engine=oracle")).body as unknown[]).length;
        failNext = new OracleSchemaError("Statement 2 failed: ORA-00902: invalid datatype", "schema");
        const bad = await api("POST", "/api/oracle-databases", { name: "bad", sql: "CREATE TABLE a (id NUMBER)" });
        expect(bad.status).toBe(422);
        expect(bad.body.error).toMatch(/ORA-00902/);
        failNext = new OracleSchemaError("exists", "exists");
        expect((await api("POST", "/api/oracle-databases", { name: "dup", sql: "CREATE TABLE a (id NUMBER)" })).status).toBe(409);
        failNext = new OracleSchemaError("no", "permission");
        expect((await api("POST", "/api/oracle-databases", { name: "perm", sql: "CREATE TABLE a (id NUMBER)" })).status).toBe(403);
        failNext = new OracleSchemaError("down", "server");
        expect((await api("POST", "/api/oracle-databases", { name: "down", sql: "CREATE TABLE a (id NUMBER)" })).status).toBe(502);
        // none of the failed attempts left a connection behind
        expect(((await api("GET", "/api/connections?engine=oracle")).body as unknown[]).length).toBe(before);
    });

    it("asks before deleting, then drops the schema and forgets the connection", async () => {
        const made = (await api("POST", "/api/oracle-databases", { name: "gone", sql: "CREATE TABLE a (id NUMBER)" })).body.connection;
        const refused = await api("DELETE", `/api/connections/${made.id}`);
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe("cloud-database");
        expect(dropped).toEqual([]);
        // the real drop needs Oracle: here it fails to reach the stand-in server, and the connection stays
        const failed = await api("DELETE", `/api/connections/${made.id}?dropDatabase=true`);
        expect(failed.status).toBe(502);
        expect(((await api("GET", "/api/connections?engine=oracle")).body as { id: string }[]).map((c) => c.id)).toContain(made.id);
    });
});
