import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestAppDb } from "../../test/pglite-app-db.js";
import { DEFAULT_SETTINGS } from "../ai/policy.js";
import { migrate, MIGRATIONS } from "./migrations.js";
import { createPgStores } from "./pg-stores.js";
import { EmailTakenError, type ConnectionRow } from "./stores.js";

let db: Awaited<ReturnType<typeof createTestAppDb>>;
let stores: Awaited<ReturnType<typeof createPgStores>>;

beforeAll(async () => {
    db = await createTestAppDb();
    expect(await migrate(db)).toEqual(MIGRATIONS.map((migration) => migration.id));
    stores = await createPgStores(db);
});
afterAll(() => db.close());

const user = (email: string, isAdmin = false) => stores.users.create({ email, displayName: email.split("@")[0], passwordHash: "scrypt$x", isAdmin });

const connection = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
    id: randomUUID(),
    name: "main",
    host: "db.example.com",
    port: 5432,
    username: "app",
    database_name: "app",
    ssl_mode: "require",
    password_ciphertext: randomBytes(24),
    password_iv: randomBytes(12),
    password_auth_tag: randomBytes(16),
    kind: "external",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
});

describe("migrations", () => {
    it("run once and are safe to run again", async () => {
        expect(await migrate(db)).toEqual([]);
        const done = await db.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id");
        expect(done.rows.map((row) => row.id)).toEqual(MIGRATIONS.map((migration) => migration.id));
    });

    it("roll the whole step back when one statement fails, and record nothing", async () => {
        const fresh = await createTestAppDb();
        await expect(migrate(fresh, [{ id: "bad", sql: "CREATE TABLE ok (id int); CREATE TABLE broken (id int REFERENCES nowhere(id));" }])).rejects.toThrow();
        expect((await fresh.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'ok'")).rowCount).toBe(0);
        expect((await fresh.query("SELECT 1 FROM schema_migrations")).rowCount).toBe(0);
        await fresh.close();
    });
});

describe("accounts and sessions", () => {
    it("creates accounts, refuses the same email in any case, and finds them by email or id", async () => {
        const first = await user("Ada@Example.com", true);
        expect(first).toMatchObject({ email: "Ada@Example.com", isAdmin: true, displayName: "Ada" });
        await expect(user("ada@example.COM")).rejects.toBeInstanceOf(EmailTakenError);
        expect((await stores.users.findByEmail("ADA@example.com"))?.id).toBe(first.id);
        expect((await stores.users.findById(first.id))?.email).toBe("Ada@Example.com");
        expect(await stores.users.findById(randomUUID())).toBeUndefined();
        expect(await stores.users.count()).toBeGreaterThanOrEqual(1);
    });

    it("finds the account for a live session only, and forgets deleted and expired ones", async () => {
        const account = await user("session@example.com");
        await stores.sessions.create({ tokenHash: "live", userId: account.id, expiresAt: new Date(Date.now() + 60_000) });
        await stores.sessions.create({ tokenHash: "old", userId: account.id, expiresAt: new Date(Date.now() - 60_000), userAgent: "x".repeat(500) });
        expect((await stores.sessions.findUser("live"))?.id).toBe(account.id);
        expect(await stores.sessions.findUser("old")).toBeUndefined();
        expect(await stores.sessions.findUser("never")).toBeUndefined();
        expect(await stores.sessions.deleteExpired()).toBe(1);
        await stores.sessions.delete("live");
        expect(await stores.sessions.findUser("live")).toBeUndefined();

        await stores.sessions.create({ tokenHash: "a", userId: account.id, expiresAt: new Date(Date.now() + 60_000) });
        await stores.sessions.deleteForUser(account.id);
        expect(await stores.sessions.findUser("a")).toBeUndefined();
    });
});

describe("connections", () => {
    it("belong to their owner: others cannot list, read, rename or delete them", async () => {
        const [alice, bob] = [await user("alice@example.com"), await user("bob@example.com")];
        const mine = connection({ name: "alice db" });
        await stores.connections.insert(alice.id, mine);

        expect((await stores.connections.list(alice.id)).map((row) => row.name)).toContain("alice db");
        expect((await stores.connections.list(bob.id)).map((row) => row.name)).not.toContain("alice db");
        expect(await stores.connections.get(bob.id, mine.id)).toBeUndefined();
        expect(await stores.connections.rename(bob.id, mine.id, "stolen")).toBeUndefined();
        await stores.connections.delete(bob.id, mine.id);
        expect((await stores.connections.get(alice.id, mine.id))?.name).toBe("alice db");

        const renamed = await stores.connections.rename(alice.id, mine.id, "renamed");
        expect(renamed?.name).toBe("renamed");
        await stores.connections.delete(alice.id, mine.id);
        expect(await stores.connections.get(alice.id, mine.id)).toBeUndefined();
    });

    it("round-trips the encrypted password bytes and the timestamps unchanged", async () => {
        const owner = await user("bytes@example.com");
        const row = connection();
        await stores.connections.insert(owner.id, row);
        const read = (await stores.connections.get(owner.id, row.id))!;
        expect(read.password_ciphertext.equals(row.password_ciphertext)).toBe(true);
        expect(read.password_iv.equals(row.password_iv)).toBe(true);
        expect(read.password_auth_tag.equals(row.password_auth_tag)).toBe(true);
        expect(Buffer.isBuffer(read.password_ciphertext)).toBe(true);
        expect(read.created_at).toBe("2026-01-01T00:00:00.000Z");
        expect(read.kind).toBe("external");
    });

    it("counts only the cloud databases of one owner, and allows each physical database once", async () => {
        const [carol, dave] = [await user("carol@example.com"), await user("dave@example.com")];
        await stores.connections.insert(carol.id, connection({ kind: "cloud", database_name: "gf_aaaaaaaa_shop" }));
        await stores.connections.insert(carol.id, connection({ kind: "cloud", database_name: "gf_aaaaaaaa_crm" }));
        await stores.connections.insert(carol.id, connection({ kind: "external" }));
        expect(await stores.connections.countCloud(carol.id)).toBe(2);
        expect(await stores.connections.countCloud(dave.id)).toBe(0);
        await expect(stores.connections.insert(dave.id, connection({ kind: "cloud", database_name: "gf_aaaaaaaa_shop" }))).rejects.toThrow();
    });

    it("keeps the engine of a connection, defaults old rows to PostgreSQL, and counts each engine's managed databases separately", async () => {
        const erin = await user("oracle-erin@example.com");
        const [pg, oracle] = [connection({ kind: "cloud", database_name: "gf_bbbbbbbb_shop" }), connection({ kind: "cloud", engine: "oracle", database_name: "FREEPDB1", username: "GF_BBBBBBBB_INS" })];
        const plain = connection({ kind: "external" });
        delete (plain as { engine?: string }).engine;
        for (const row of [pg, oracle, plain]) await stores.connections.insert(erin.id, row);

        expect((await stores.connections.get(erin.id, oracle.id))?.engine).toBe("oracle");
        expect((await stores.connections.get(erin.id, pg.id))?.engine).toBe("postgres");
        expect((await stores.connections.get(erin.id, plain.id))?.engine).toBe("postgres");
        // the PostgreSQL allowance is not eaten by Oracle databases, and the other way round
        expect(await stores.connections.countCloud(erin.id)).toBe(1);
        expect(await stores.connections.countManaged(erin.id, "postgres")).toBe(1);
        expect(await stores.connections.countManaged(erin.id, "oracle")).toBe(1);
        // two accounts' Oracle schemas may share a service name; the unique rule is on the physical database of a PostgreSQL cloud database only
        const frank = await user("oracle-frank@example.com");
        await stores.connections.insert(frank.id, connection({ kind: "cloud", engine: "oracle", database_name: "FREEPDB1", username: "GF_CCCCCCCC_INS" }));
        expect(await stores.connections.countManaged(frank.id, "oracle")).toBe(1);
        // ...but the same schema on the same server can only be recorded once
        await expect(stores.connections.insert(frank.id, connection({ kind: "cloud", engine: "oracle", database_name: "FREEPDB1", username: "GF_CCCCCCCC_INS" }))).rejects.toThrow();
        // and a PostgreSQL cloud database is still unique by its database name
        await expect(stores.connections.insert(frank.id, connection({ kind: "cloud", database_name: "gf_bbbbbbbb_shop" }))).rejects.toThrow();
    });

    it("refuses an engine it does not know", async () => {
        const gina = await user("oracle-gina@example.com");
        await expect(stores.connections.insert(gina.id, connection({ engine: "mysql" as never }))).rejects.toThrow();
    });

    it("go away with their owner", async () => {
        const gone = await user("gone@example.com");
        const row = connection();
        await stores.connections.insert(gone.id, row);
        await db.query("DELETE FROM users WHERE id = $1", [gone.id]);
        expect((await db.query("SELECT 1 FROM connections WHERE id = $1", [row.id])).rowCount).toBe(0);
    });
});

describe("diagrams", () => {
    const document = (tables: number) => ({ format: "goforge-project", formatVersion: 1, project: { name: "shop", tables: Array.from({ length: tables }, (_, index) => ({ id: `t${index}` })) } });

    it("are created, replaced (counting versions), listed newest first and deleted", async () => {
        const owner = await user("projects@example.com");
        const id = "proj-" + randomUUID();
        const created = await stores.projects.upsert(owner.id, { id, name: "Shop", dialect: "postgres", tables: 2, document: document(2) });
        expect(created).toMatchObject({ id, name: "Shop", dialect: "postgres", tables: 2, version: 1 });

        const replaced = await stores.projects.upsert(owner.id, { id, name: "Shop v2", dialect: "postgres", tables: 3, document: document(3) });
        expect(replaced).toMatchObject({ name: "Shop v2", tables: 3, version: 2 });
        expect(new Date(replaced!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(created!.updatedAt).getTime());

        const read = await stores.projects.get(owner.id, id);
        expect((read?.document as { project: { tables: unknown[] } }).project.tables).toHaveLength(3);
        expect((await stores.projects.list(owner.id)).map((project) => project.id)).toEqual([id]);

        expect(await stores.projects.delete(owner.id, id)).toBe(true);
        expect(await stores.projects.delete(owner.id, id)).toBe(false);
        expect(await stores.projects.get(owner.id, id)).toBeUndefined();
    });

    it("cannot be read, replaced or deleted by someone else, even with the same id", async () => {
        const [owner, other] = [await user("p-owner@example.com"), await user("p-other@example.com")];
        const id = "proj-" + randomUUID();
        await stores.projects.upsert(owner.id, { id, name: "Mine", dialect: "postgres", tables: 1, document: document(1) });

        expect(await stores.projects.get(other.id, id)).toBeUndefined();
        expect(await stores.projects.upsert(other.id, { id, name: "Hijack", dialect: "postgres", tables: 9, document: document(9) })).toBeUndefined();
        expect(await stores.projects.delete(other.id, id)).toBe(false);
        expect(await stores.projects.list(other.id)).toEqual([]);
        expect(await stores.projects.get(owner.id, id)).toMatchObject({ name: "Mine", tables: 1, version: 1 });
    });
});

describe("AI settings and the audit log", () => {
    beforeEach(async () => {
        await db.query("DELETE FROM ai_audit");
    });

    it("keep the workspace settings across a restart, and read legacy rows without the parts that no longer apply", async () => {
        expect(stores.settings.read().settings).toEqual(DEFAULT_SETTINGS);
        await stores.settings.write({ ...DEFAULT_SETTINGS, model: "gpt-5.6-luna", allowedModels: ["gpt-5.6-*"], redactNames: true });

        const restarted = await createPgStores(db);
        expect(restarted.settings.read().settings).toMatchObject({ model: "gpt-5.6-luna", allowedModels: ["gpt-5.6-*"], redactNames: true });

        await db.query("UPDATE ai_settings SET json = $1::jsonb WHERE id = 1", [JSON.stringify({ region: "us-east-1", model: "deepseek.v3.2", redactNames: true })]);
        expect((await createPgStores(db)).settings.read().settings).toMatchObject({ model: "", redactNames: true });
        await stores.settings.write(DEFAULT_SETTINGS);
    });

    it("show each account only its own entries, and let nobody read another's", async () => {
        const [erin, frank] = [await user("erin@example.com"), await user("frank@example.com")];
        const mine = await stores.audit.record({ ownerId: erin.id, kind: "model-call", purpose: "schema-plan", status: "ok", model: "m", payload: '{"a":1}', detail: { tables: ["a"] }, redacted: true });
        await stores.audit.record({ ownerId: frank.id, kind: "model-call", purpose: "other", status: "ok" });
        await stores.audit.record({ kind: "settings-changed", purpose: "ai-settings", status: "ok" });

        expect((await stores.audit.list({ ownerId: erin.id })).map((entry) => entry.id)).toEqual([mine]);
        expect((await stores.audit.list({ ownerId: frank.id })).map((entry) => entry.purpose)).toEqual(["other"]);
        expect((await stores.audit.list({ ownerId: "local" })).map((entry) => entry.purpose)).toEqual(["ai-settings"]);
        expect(await stores.audit.get(mine, frank.id)).toBeUndefined();
        expect(await stores.audit.get(mine, erin.id)).toMatchObject({ id: mine, purpose: "schema-plan", redacted: true, payload: '{"a":1}', detail: { tables: ["a"] } });
    });

    it("link a plan to the request it follows and honour sinceId and limit, newest first", async () => {
        const owner = await user("linker@example.com");
        const first = await stores.audit.record({ ownerId: owner.id, kind: "model-call", purpose: "schema-plan", status: "ok" });
        const second = await stores.audit.record({ ownerId: owner.id, kind: "plan", purpose: "schema-plan", status: "ok", parentId: first });
        expect(typeof first).toBe("number");
        expect((await stores.audit.list({ ownerId: owner.id })).map((entry) => entry.id)).toEqual([second, first]);
        expect((await stores.audit.list({ ownerId: owner.id, sinceId: first })).map((entry) => entry.id)).toEqual([second]);
        expect((await stores.audit.list({ ownerId: owner.id, limit: 1 })).map((entry) => entry.id)).toEqual([second]);
        expect((await stores.audit.get(second, owner.id))?.parentId).toBe(first);
    });
});


describe("moving local connections to an account", () => {
    it("copies them with their encrypted password bytes untouched, and leaves existing ones alone when run again", async () => {
        const { importLocalConnections } = await import("./import-local.js");
        const owner = await user("importer@example.com");
        const local = [connection({ name: "shop-db" }), connection({ name: "crm-db" })];

        const first = await importLocalConnections(local, stores.connections, owner.id);
        expect(first).toEqual({ imported: ["shop-db", "crm-db"], skipped: [] });
        const copied = (await stores.connections.get(owner.id, local[0].id))!;
        expect(copied.password_ciphertext.equals(local[0].password_ciphertext)).toBe(true);
        expect(copied.kind).toBe("external");

        expect(await importLocalConnections(local, stores.connections, owner.id)).toEqual({ imported: [], skipped: ["shop-db", "crm-db"] });
        expect((await stores.connections.list(owner.id)).filter((row) => ["shop-db", "crm-db"].includes(row.name))).toHaveLength(2);
    });

    it("does not take a connection whose id belongs to another account", async () => {
        const { importLocalConnections } = await import("./import-local.js");
        const [first, second] = [await user("first-importer@example.com"), await user("second-importer@example.com")];
        const shared = connection({ name: "shared id" });
        await stores.connections.insert(first.id, shared);
        expect(await importLocalConnections([shared], stores.connections, second.id)).toEqual({ imported: [], skipped: ["shared id"] });
        expect(await stores.connections.get(second.id, shared.id)).toBeUndefined();
    });
});
