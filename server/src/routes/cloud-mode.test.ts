import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Accounts are on for this whole file: a Postgres application database (in-process), the real app, real HTTP.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goforge-cloud-"));
process.env.SQLITE_PATH = path.join(dir, "unused.db"); // cloud mode must never create this
process.env.MASTER_KEY = randomBytes(32).toString("base64");

const { createApp } = await import("../app.js");
const { createTestAppDb } = await import("../../test/pglite-app-db.js");
const { migrate } = await import("../db/migrations.js");
const { createPgStores } = await import("../db/pg-stores.js");
const { installCloud, installConnectionStore, getConnectionStore } = await import("../db/stores.js");
const { toConnectionConfig } = await import("../services/pg-client.js");
const { installAiStores } = await import("../ai/provider.js");
const { CreateDatabaseError, DatabaseExistsError } = await import("../services/pg-create-database.js");

type CloudCall = { database: string; sql: string; user: string; owner?: { role: string; password: string; connectionLimit?: number } };
const created: CloudCall[] = [];
let failNext: Error | undefined;

let db: Awaited<ReturnType<typeof createTestAppDb>>;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
let cloud: Parameters<typeof installCloud>[0] & object;

beforeAll(async () => {
    db = await createTestAppDb();
    await migrate(db);
    const stores = await createPgStores(db);
    installConnectionStore(stores.connections);
    installAiStores({ settings: stores.settings, audit: stores.audit });
    cloud = {
        users: stores.users,
        sessions: stores.sessions,
        projects: stores.projects,
        // nothing listens here: dropping a database must fail cleanly and leave the connection in place
        admin: { host: "127.0.0.1", port: 1, user: "app_admin", password: "admin-secret-not-real", database: "neondb", sslMode: "disable" },
        maxDatabasesPerUser: 2,
        allowSignup: false,
        secureCookies: false,
    };
    installCloud(cloud);
    const app = createApp({
        cloudDatabases: {
            createDatabase: async (config, database, sql, _deps, owner) => {
                if (failNext) {
                    const error = failNext;
                    failNext = undefined;
                    throw error;
                }
                created.push({ database, sql, user: config.user, owner });
                return { statementsRun: sql.split(";").filter((piece) => piece.trim()).length };
            },
            dropDatabase: async () => undefined,
        },
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    installCloud(undefined);
    installConnectionStore(undefined);
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    expect(fs.existsSync(process.env.SQLITE_PATH!)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
});

interface Client {
    cookie?: string;
    send(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
}

/** One browser: keeps its own session cookie. */
const browser = (): Client => {
    const client: Client = {
        async send(method, url, body, headers = {}) {
            const response = await fetch(`${base}${url}`, {
                method,
                headers: { "Content-Type": "application/json", ...(client.cookie ? { Cookie: client.cookie } : {}), ...headers },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const set = response.headers.get("set-cookie");
            if (set) client.cookie = set.startsWith("goforge_session=;") || /Expires=Thu, 01 Jan 1970/.test(set) ? undefined : set.split(";")[0];
            const text = await response.text();
            return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
        },
    };
    return client;
};

const PASSWORD = "correct horse battery";
const signup = (client: Client, email: string, password = PASSWORD) => client.send("POST", "/api/auth/signup", { email, password });
const savedConnection = { name: "neon", host: "db.example.com", port: 5432, username: "app", password: "p@ss-not-real", database: "neondb", sslMode: "require" };

const ada = browser();
const bob = browser();

describe("signing in", () => {
    it("says accounts are on and sign-up is open before the first account", async () => {
        expect((await browser().send("GET", "/api/auth/me")).body).toEqual({ mode: "cloud", user: null, signupOpen: true });
    });

    it("keeps everything but sign-in and the health check behind an account", async () => {
        const anonymous = browser();
        expect((await anonymous.send("GET", "/api/health")).status).toBe(200);
        for (const url of ["/api/connections", "/api/projects", "/api/ai/settings", "/api/ai/status", "/api/ai/audit"]) {
            const response = await anonymous.send("GET", url);
            expect(response.status, url).toBe(401);
            expect(response.body).toMatchObject({ code: "unauthenticated" });
        }
        expect((await anonymous.send("POST", "/api/cloud-databases", { name: "x", sql: "CREATE TABLE a (id int);" })).status).toBe(401);
    });

    it("creates the first account as admin, starts a session in an httpOnly cookie, and never returns the hash", async () => {
        const response = await signup(ada, "Ada@Example.com");
        expect(response.status).toBe(201);
        expect(response.body.user).toMatchObject({ email: "ada@example.com", isAdmin: true });
        expect(JSON.stringify(response.body)).not.toMatch(/scrypt|passwordHash/);
        const cookie = response.headers.get("set-cookie") ?? "";
        expect(cookie).toMatch(/^goforge_session=/);
        expect(cookie).toMatch(/HttpOnly/i);
        expect(cookie).toMatch(/SameSite=Lax/i);

        const me = await ada.send("GET", "/api/auth/me");
        expect(me.body).toMatchObject({ mode: "cloud", user: { email: "ada@example.com", isAdmin: true }, signupOpen: false, cloudDatabases: { limit: 2, used: 0 } });
    });

    it("closes sign-up after the first account, unless the admin opened it", async () => {
        const response = await signup(bob, "bob@example.com");
        expect(response.status).toBe(403);
        expect(response.body.error).toMatch(/closed/i);
        cloud.allowSignup = true;
        expect((await signup(bob, "bob@example.com")).status).toBe(201);
        expect((await bob.send("GET", "/api/auth/me")).body.user).toMatchObject({ email: "bob@example.com", isAdmin: false });
    });

    it("refuses a weak password, a bad email and an email already taken in any case", async () => {
        expect((await signup(browser(), "weak@example.com", "short")).body.error).toMatch(/at least 10/);
        expect((await signup(browser(), "not-an-email")).status).toBe(400);
        expect((await signup(browser(), "ADA@example.com")).status).toBe(409);
    });

    it("logs in with the right password only, and tells a wrong password from an unknown account in no way", async () => {
        const wrong = await browser().send("POST", "/api/auth/login", { email: "ada@example.com", password: "wrong password!" });
        const unknown = await browser().send("POST", "/api/auth/login", { email: "nobody@example.com", password: "wrong password!" });
        expect(wrong.status).toBe(401);
        expect(unknown.status).toBe(401);
        expect(wrong.body).toEqual(unknown.body);

        const again = browser();
        expect((await again.send("POST", "/api/auth/login", { email: "ADA@example.com", password: PASSWORD })).status).toBe(200);
        expect((await again.send("GET", "/api/connections")).status).toBe(200);
    });

    it("slows guessing down: ten wrong passwords and the account is locked for that address for a while", async () => {
        const guesser = browser();
        for (let attempt = 0; attempt < 10; attempt++) {
            expect((await guesser.send("POST", "/api/auth/login", { email: "victim@example.com", password: `guess number ${attempt}` })).status).toBe(401);
        }
        const blocked = await guesser.send("POST", "/api/auth/login", { email: "victim@example.com", password: "guess number 11" });
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    });

    it("ends the session on logout, and the old cookie stops working", async () => {
        const session = browser();
        await session.send("POST", "/api/auth/login", { email: "ada@example.com", password: PASSWORD });
        const cookie = session.cookie!;
        expect((await session.send("POST", "/api/auth/logout")).status).toBe(204);
        expect(session.cookie).toBeUndefined();

        const replay = browser();
        replay.cookie = cookie;
        expect((await replay.send("GET", "/api/connections")).status).toBe(401);
    });

    it("refuses a changing request that comes from another site, and accepts one from this site", async () => {
        const evil = await ada.send("POST", "/api/connections", savedConnection, { Origin: "https://evil.example" });
        expect(evil.status).toBe(403);
        const own = await ada.send("POST", "/api/connections", { ...savedConnection, name: "from this site" }, { Origin: base });
        expect(own.status).toBe(201);

        // behind a proxy the API may see its own address as Host; the host the browser used arrives as X-Forwarded-Host
        const proxied = await ada.send("POST", "/api/connections", { ...savedConnection, name: "through a proxy" }, { Origin: "https://app.example.com", "X-Forwarded-Host": "app.example.com" });
        expect(proxied.status).toBe(201);
        const wrongProxy = await ada.send("POST", "/api/connections", savedConnection, { Origin: "https://evil.example", "X-Forwarded-Host": "app.example.com" });
        expect(wrongProxy.status).toBe(403);
    });
});

describe("what belongs to whom", () => {
    it("keeps saved connections private to their owner, in every route that takes an id", async () => {
        const made = await ada.send("POST", "/api/connections", { ...savedConnection, name: "ada private" });
        const id = made.body.id as string;
        expect(JSON.stringify(made.body)).not.toContain("p@ss-not-real");

        expect((await ada.send("GET", "/api/connections")).body.map((c: any) => c.name)).toContain("ada private");
        expect((await bob.send("GET", "/api/connections")).body.map((c: any) => c.name)).not.toContain("ada private");

        for (const [method, url, body] of [
            ["PATCH", `/api/connections/${id}`, { name: "stolen" }],
            ["POST", `/api/connections/${id}/test`],
            ["GET", `/api/connections/${id}/introspect`],
            ["POST", `/api/connections/${id}/preview`, { sql: "select 1" }],
            ["POST", `/api/connections/${id}/execute`, { sql: "select 1" }],
            ["GET", `/api/connections/${id}/relations`],
            ["POST", `/api/connections/${id}/create-database`, { database: "x", sql: "CREATE TABLE a (id int);" }],
            ["DELETE", `/api/connections/${id}`],
        ] as const) {
            const response = await bob.send(method, url, body);
            expect(response.status, `${method} ${url}`).toBe(404);
        }
        expect((await ada.send("GET", "/api/connections")).body.find((c: any) => c.id === id)?.name).toBe("ada private");
    });

    it("keeps diagrams private, and refuses to overwrite someone else's id", async () => {
        const document = { format: "goforge-project", formatVersion: 1, project: { name: "Shop", dialect: "postgres", tables: [{ id: "t1" }, { id: "t2" }] } };
        const id = "11111111-2222-4333-8444-555555555555";
        const saved = await ada.send("PUT", `/api/projects/${id}`, { name: "Shop", dialect: "postgres", document });
        expect(saved.body).toMatchObject({ id, name: "Shop", tables: 2, version: 1 });
        expect((await ada.send("PUT", `/api/projects/${id}`, { name: "Shop 2", dialect: "postgres", document })).body.version).toBe(2);

        expect((await ada.send("GET", "/api/projects")).body.map((p: any) => p.id)).toEqual([id]);
        expect((await ada.send("GET", `/api/projects/${id}`)).body.document.project.tables).toHaveLength(2);
        expect((await bob.send("GET", "/api/projects")).body).toEqual([]);
        expect((await bob.send("GET", `/api/projects/${id}`)).status).toBe(404);
        expect((await bob.send("PUT", `/api/projects/${id}`, { name: "Hijack", dialect: "postgres", document })).status).toBe(409);
        await bob.send("DELETE", `/api/projects/${id}`);
        expect((await ada.send("GET", `/api/projects/${id}`)).status).toBe(200);

        expect((await ada.send("PUT", `/api/projects/${id}`, { name: "bad", dialect: "postgres", document: { not: "a project" } })).status).toBe(400);
        expect((await ada.send("PUT", "/api/projects/x", { name: "Shop", dialect: "postgres", document })).status).toBe(400);
        expect((await ada.send("DELETE", `/api/projects/${id}`)).status).toBe(204);
        expect((await ada.send("GET", `/api/projects/${id}`)).status).toBe(404);
    });

    it("lets only the admin change the AI settings, which are one set for the workspace", async () => {
        expect((await bob.send("PUT", "/api/ai/settings", { model: "gpt-5.6-terra" })).status).toBe(403);
        const changed = await ada.send("PUT", "/api/ai/settings", { model: "gpt-5.6-terra", redactNames: true });
        expect(changed.status).toBe(200);
        expect((await bob.send("GET", "/api/ai/settings")).body.settings).toMatchObject({ model: "gpt-5.6-terra", redactNames: true });
        await ada.send("PUT", "/api/ai/settings", { model: "", redactNames: false });
    });

    it("lists each account's audit log to that account only", async () => {
        const adas = (await ada.send("GET", "/api/ai/audit")).body.entries as { purpose: string }[];
        const bobs = (await bob.send("GET", "/api/ai/audit")).body.entries as { purpose: string }[];
        expect(adas.some((entry) => entry.purpose === "ai-settings")).toBe(true);
        expect(bobs.some((entry) => entry.purpose === "ai-settings")).toBe(false);
        const id = (await ada.send("GET", "/api/ai/audit")).body.entries[0].id;
        expect((await ada.send("GET", `/api/ai/audit/${id}`)).status).toBe(200);
        expect((await bob.send("GET", `/api/ai/audit/${id}`)).status).toBe(404);
    });
});

describe("databases created on the application server", () => {
    const schema = "CREATE TABLE shop (id int);\nCREATE TABLE orders (id int);";

    it("creates one for the account, under a name made from the account and the name, and saves a connection to it", async () => {
        const response = await ada.send("POST", "/api/cloud-databases", { name: "My Shop!", sql: schema });
        expect(response.status).toBe(201);
        expect(response.body.statementsRun).toBe(2);
        const physical = response.body.connection.database as string;
        expect(physical).toMatch(/^gf_[0-9a-f]{8}_my_shop$/);
        // the connection signs in as the database's own role, never as the server's admin role
        expect(response.body.connection).toMatchObject({ name: "My Shop!", kind: "cloud", username: physical });
        expect(created.at(-1)).toMatchObject({ database: physical, sql: schema, user: "app_admin", owner: { role: physical, connectionLimit: 10 } });

        // the admin password is nowhere, and the role's password is not in the answer: it is only in the encrypted connection row
        expect(JSON.stringify(response.body)).not.toContain("admin-secret-not-real");
        const rolePassword = created.at(-1)!.owner!.password;
        expect(rolePassword).not.toBe("admin-secret-not-real");
        expect(JSON.stringify(response.body)).not.toContain(rolePassword);
        const me = (await ada.send("GET", "/api/auth/me")).body.user.id as string;
        const row = (await getConnectionStore().get(me, response.body.connection.id))!;
        expect(toConnectionConfig(row)).toMatchObject({ user: physical, password: rolePassword, database: physical });
        expect(row.password_ciphertext.toString("utf8")).not.toContain(rolePassword);
        expect((await ada.send("GET", "/api/connections")).body.find((c: any) => c.id === response.body.connection.id)).toMatchObject({ kind: "cloud", database: physical });
        expect((await ada.send("GET", "/api/auth/me")).body.cloudDatabases).toEqual({ limit: 2, used: 1 });
    });

    it("will not create more databases through a cloud database's own connection, which would sidestep the limit", async () => {
        const cloudOne = (await ada.send("GET", "/api/connections")).body.find((c: any) => c.kind === "cloud");
        const response = await ada.send("POST", `/api/connections/${cloudOne.id}/create-database`, { database: "sneaky", sql: "CREATE TABLE a (id int);" });
        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/GoForge cloud option/);
        expect(created.some((call) => call.database === "sneaky")).toBe(false);
    });

    it("gives two accounts that pick the same name two different databases", async () => {
        const mine = await ada.send("POST", "/api/cloud-databases", { name: "crm", sql: schema });
        const his = await bob.send("POST", "/api/cloud-databases", { name: "crm", sql: schema });
        expect(mine.status).toBe(201);
        expect(his.status).toBe(201);
        expect(mine.body.connection.database).not.toBe(his.body.connection.database);
        expect((await bob.send("GET", "/api/connections")).body.map((c: any) => c.database)).toEqual([his.body.connection.database]);
    });

    it("stops at the per-account limit", async () => {
        // ada has two now (limit 2)
        const response = await ada.send("POST", "/api/cloud-databases", { name: "third", sql: schema });
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ code: "cloud-database-limit" });
    });

    it("reports a name already used, a schema that failed, and a role that may not create databases", async () => {
        cloud.maxDatabasesPerUser = 20;
        failNext = new DatabaseExistsError("x");
        expect((await bob.send("POST", "/api/cloud-databases", { name: "dup", sql: schema })).status).toBe(409);
        failNext = new CreateDatabaseError('Statement 2 of 2 failed: relation "zz" does not exist', "schema");
        const failed = await bob.send("POST", "/api/cloud-databases", { name: "broken", sql: schema });
        expect(failed.status).toBe(422);
        expect(failed.body.error).toMatch(/relation "zz" does not exist/);
        failNext = new CreateDatabaseError("not allowed", "permission");
        expect((await bob.send("POST", "/api/cloud-databases", { name: "denied", sql: schema })).status).toBe(403);
        // none of the failures left a connection behind
        expect((await bob.send("GET", "/api/connections")).body.map((c: any) => c.name)).toEqual(["crm"]);
        expect((await bob.send("POST", "/api/cloud-databases", { name: "", sql: schema })).status).toBe(400);
    });

    it("will not delete a database without being told to, and keeps the connection when the server cannot drop it", async () => {
        const list = (await bob.send("GET", "/api/connections")).body as { id: string; kind: string; name: string }[];
        const cloudOne = list.find((c) => c.kind === "cloud")!;
        const guarded = await bob.send("DELETE", `/api/connections/${cloudOne.id}`);
        expect(guarded.status).toBe(409);
        expect(guarded.body).toMatchObject({ code: "cloud-database" });
        expect(guarded.body.error).toMatch(/permanently deletes/);

        const unreachable = await bob.send("DELETE", `/api/connections/${cloudOne.id}?dropDatabase=true`);
        expect(unreachable.status).toBe(502);
        expect((await bob.send("GET", "/api/connections")).body.map((c: any) => c.id)).toContain(cloudOne.id);
    });
});

describe("the server", () => {
    it("answers a broken request body with JSON, not a stack trace", async () => {
        const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toMatch(/not valid JSON/);
    });
});
