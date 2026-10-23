import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Local mode, a real SQLite file, the real app, real HTTP. Only what needs no Oracle: who may migrate what, and what is refused.
// The migration itself, against a real Oracle and PostgreSQL, is in flow.integration.test.ts and oracle-migration.integration.test.ts.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goforge-migration-routes-"));
process.env.SQLITE_PATH = path.join(dir, "connections.db");
process.env.MASTER_KEY = randomBytes(32).toString("base64");

const { createApp } = await import("../app.js");
const { getConnectionStore, LOCAL_OWNER } = await import("../db/stores.js");
const { oracleConnectionRow } = await import("../services/oracle-schemas.js");

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let oracleId = "";
let postgresId = "";

const post = async (url: string, body: unknown) => {
    const response = await fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

beforeAll(async () => {
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // an Oracle connection nothing listens behind, and an ordinary PostgreSQL one
    const row = oracleConnectionRow({ host: "127.0.0.1", port: 1, user: "system", password: "not-real", database: "FREEPDB1", sslMode: "disable" }, "GF_TEST_LEGACY", "legacy", "not-real");
    await getConnectionStore().insert(LOCAL_OWNER, { ...row, kind: "external" });
    oracleId = row.id;
    const saved = await post("/api/connections", { name: "plain", host: "127.0.0.1", port: 5432, username: "u", password: "p", database: "d", sslMode: "disable" });
    postgresId = (saved.body as { id?: string }).id ?? "";
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/migrations/oracle-to-postgres", () => {
    it("asks which Oracle database when the body has none", async () => {
        const plan = await post("/api/migrations/oracle-to-postgres/plan", {});
        expect(plan.status).toBe(400);
        const migrate = await post("/api/migrations/oracle-to-postgres", { name: "x", target: { kind: "cloud" } });
        expect(migrate.status).toBe(400);
    });

    it("does not know a connection that is not there", async () => {
        const plan = await post("/api/migrations/oracle-to-postgres/plan", { sourceConnectionId: "no-such-id" });
        expect(plan.status).toBe(404);
        const migrate = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: "no-such-id", name: "x", target: { kind: "cloud" } });
        expect(migrate.status).toBe(404);
    });

    it("refuses a PostgreSQL connection as the source", async () => {
        expect(postgresId).not.toBe("");
        const plan = await post("/api/migrations/oracle-to-postgres/plan", { sourceConnectionId: postgresId });
        expect(plan.status).toBe(400);
        expect(String(plan.body.error)).toContain("not an Oracle database");
        const migrate = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: postgresId, name: "x", target: { kind: "cloud" } });
        expect(migrate.status).toBe(400);
    });

    it("rejects a bad target and a bad database name before touching anything", async () => {
        const noTarget = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, name: "x", target: { kind: "elsewhere" } });
        expect(noTarget.status).toBe(400);
        const badName = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, name: "x", target: { kind: "server", connectionId: postgresId, database: "bad name; drop" } });
        expect(badName.status).toBe(400);
        const emptyName = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, name: "   ", target: { kind: "cloud" } });
        expect(emptyName.status).toBe(400);
    });

    it("says so when the Oracle database cannot be reached, and creates nothing", async () => {
        const plan = await post("/api/migrations/oracle-to-postgres/plan", { sourceConnectionId: oracleId });
        expect(plan.status).toBe(502);
        expect(String(plan.body.error)).toContain("Could not read the Oracle database");
        const migrate = await post("/api/migrations/oracle-to-postgres", { sourceConnectionId: oracleId, name: "x", target: { kind: "cloud" } });
        expect(migrate.status).toBe(502);
    });
});
