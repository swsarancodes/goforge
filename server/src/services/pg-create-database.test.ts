import { describe, expect, it } from "vitest";
import type { Client } from "pg";
import type { ConnectionConfig } from "./pg-client.js";
import { CreateDatabaseError, DATABASE_NAME_PATTERN, DatabaseExistsError, createDatabaseFromSql, type CreateDatabaseDeps } from "./pg-create-database.js";

const config: ConnectionConfig = { host: "db.example.com", port: 5432, user: "app", password: "not-real", database: "postgres", sslMode: "require" };

interface Call {
    database: string;
    sql: string;
    values?: unknown[];
}

/** A server stand-in: records every statement with the database it ran in, and fails the ones a test picks. */
function fakeServer(options: { existing?: string[]; fail?: (call: Call) => { message: string; code?: string } | undefined } = {}) {
    const calls: Call[] = [];
    const deps: CreateDatabaseDeps = {
        withClient: async (cfg, fn) => {
            const client = {
                query: async (sql: string, values?: unknown[]) => {
                    const call = { database: cfg.database, sql, values };
                    calls.push(call);
                    const failure = options.fail?.(call);
                    if (failure) throw Object.assign(new Error(failure.message), { code: failure.code });
                    if (sql.startsWith("SELECT 1 FROM pg_database")) return { rowCount: options.existing?.includes(String(values?.[0])) ? 1 : 0 };
                    return { rowCount: 0 };
                },
            } as unknown as Client;
            return fn(client);
        },
    };
    return { calls, deps };
}

describe("createDatabaseFromSql", () => {
    it("creates the database, then builds the schema in it as one transaction", async () => {
        const { calls, deps } = fakeServer();
        const result = await createDatabaseFromSql(config, "sales_v2", "CREATE TABLE a (id int);\nCREATE TABLE b (id int);", deps);

        expect(result).toEqual({ statementsRun: 2 });
        expect(calls.map((call) => `${call.database}: ${call.sql}`)).toEqual([
            "postgres: SELECT 1 FROM pg_database WHERE datname = $1",
            'postgres: CREATE DATABASE "sales_v2"',
            "sales_v2: BEGIN",
            "sales_v2: CREATE TABLE a (id int)",
            "sales_v2: CREATE TABLE b (id int)",
            "sales_v2: COMMIT",
        ]);
        expect(calls[0].values).toEqual(["sales_v2"]);
    });

    it("runs a script that carries its own BEGIN and COMMIT inside the one transaction it opens", async () => {
        const { calls, deps } = fakeServer();
        const result = await createDatabaseFromSql(config, "sales_v2", "BEGIN;\n\n-- the tables\nCREATE TABLE a (id int);\n\nCOMMIT;\n", deps);
        expect(result).toEqual({ statementsRun: 1 });
        const ran = calls.filter((call) => call.database === "sales_v2").map((call) => call.sql);
        expect(ran).toHaveLength(3);
        expect(ran[0]).toBe("BEGIN");
        expect(ran[1]).toContain("CREATE TABLE a (id int)");
        expect(ran[2]).toBe("COMMIT");
    });

    it("refuses a name that is already taken, without creating or dropping anything", async () => {
        const { calls, deps } = fakeServer({ existing: ["sales_v2"] });
        await expect(createDatabaseFromSql(config, "sales_v2", "CREATE TABLE a (id int);", deps)).rejects.toBeInstanceOf(DatabaseExistsError);
        expect(calls.map((call) => call.sql)).toEqual(["SELECT 1 FROM pg_database WHERE datname = $1"]);

        // two requests racing for one name: the server's own refusal is reported the same way
        const race = fakeServer({ fail: (call) => (call.sql.startsWith("CREATE DATABASE") ? { message: "database exists", code: "42P04" } : undefined) });
        await expect(createDatabaseFromSql(config, "sales_v2", "CREATE TABLE a (id int);", race.deps)).rejects.toBeInstanceOf(DatabaseExistsError);
        expect(race.calls.some((call) => call.sql.startsWith("DROP DATABASE"))).toBe(false);
    });

    it("says so when the role may not create databases", async () => {
        const { deps } = fakeServer({ fail: (call) => (call.sql.startsWith("CREATE DATABASE") ? { message: "permission denied to create database", code: "42501" } : undefined) });
        const error = await createDatabaseFromSql(config, "x", "CREATE TABLE a (id int);", deps).catch((caught) => caught);
        expect(error).toBeInstanceOf(CreateDatabaseError);
        expect(error).toMatchObject({ kind: "permission", message: expect.stringMatching(/role "app" is not allowed to create databases on db\.example\.com/) });
    });

    it("rolls back and drops the new database when a statement fails, naming the statement", async () => {
        const { calls, deps } = fakeServer({ fail: (call) => (call.sql.startsWith("CREATE TABLE b") ? { message: 'relation "zzz" does not exist', code: "42P01" } : undefined) });
        const error = await createDatabaseFromSql(config, "sales_v2", "CREATE TABLE a (id int);\nCREATE TABLE b (id int REFERENCES zzz);\nCREATE TABLE c (id int);", deps).catch((caught) => caught);

        expect(error).toBeInstanceOf(CreateDatabaseError);
        expect(error).toMatchObject({ kind: "schema", message: expect.stringContaining('Statement 2 of 3 failed: relation "zzz" does not exist') });
        expect(error.message).toContain("CREATE TABLE b (id int REFERENCES zzz)");
        const log = calls.map((call) => `${call.database}: ${call.sql}`);
        expect(log).toContain("sales_v2: ROLLBACK");
        expect(log).not.toContain("sales_v2: COMMIT");
        expect(log).not.toContain("sales_v2: CREATE TABLE c (id int)");
        expect(log[log.length - 1]).toBe('postgres: DROP DATABASE IF EXISTS "sales_v2"');
    });

    it("tells the user to drop the database by hand when even that fails", async () => {
        const { deps } = fakeServer({
            fail: (call) => (call.sql.startsWith("CREATE TABLE") ? { message: "boom" } : call.sql.startsWith("DROP DATABASE") ? { message: "being accessed by other users" } : undefined),
        });
        const error = await createDatabaseFromSql(config, "sales_v2", "CREATE TABLE a (id int);", deps).catch((caught) => caught);
        expect(error.message).toMatch(/Statement 1 of 1 failed: boom/);
        expect(error.message).toMatch(/could not be removed again: the database "sales_v2" \(being accessed by other users\)/);
    });

    describe("with a dedicated owner role", () => {
        const owner = { role: "gf_1234abcd_shop", password: "a".repeat(24) };

        it("creates the role, hands it the database, locks everyone else out, and builds the schema as that role", async () => {
            const { calls, deps } = fakeServer();
            await createDatabaseFromSql(config, "gf_1234abcd_shop", "CREATE TABLE a (id int);", deps, owner);

            const log = calls.map((call) => `${call.database}: ${call.sql}`);
            expect(log[0]).toBe("postgres: SELECT 1 FROM pg_database WHERE datname = $1");
            expect(log[1]).toBe("postgres: SELECT 1 FROM pg_roles WHERE rolname = $1");
            expect(log[2]).toMatch(/^postgres: CREATE ROLE "gf_1234abcd_shop" LOGIN PASSWORD '[a]{24}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 10$/);
            expect(log[3]).toBe('postgres: GRANT "gf_1234abcd_shop" TO CURRENT_USER WITH SET TRUE');
            expect(log[4]).toBe('postgres: CREATE DATABASE "gf_1234abcd_shop" OWNER "gf_1234abcd_shop"');
            expect(log[5]).toBe('postgres: REVOKE ALL ON DATABASE "gf_1234abcd_shop" FROM PUBLIC');
            expect(log.slice(6)).toEqual(['gf_1234abcd_shop: BEGIN', 'gf_1234abcd_shop: SET LOCAL ROLE "gf_1234abcd_shop"', "gf_1234abcd_shop: CREATE TABLE a (id int)", "gf_1234abcd_shop: COMMIT"]);
        });

        it("falls back to a plain GRANT on a server that does not know WITH SET", async () => {
            const { calls, deps } = fakeServer({ fail: (call) => (call.sql.includes("WITH SET TRUE") ? { message: "syntax error", code: "42601" } : undefined) });
            await createDatabaseFromSql(config, "gf_1234abcd_shop", "CREATE TABLE a (id int);", deps, owner);
            expect(calls.map((call) => call.sql)).toContain('GRANT "gf_1234abcd_shop" TO CURRENT_USER');
        });

        it("drops the database and then the role when the schema fails", async () => {
            const { calls, deps } = fakeServer({ fail: (call) => (call.sql.startsWith("CREATE TABLE") ? { message: "boom" } : undefined) });
            await expect(createDatabaseFromSql(config, "gf_1234abcd_shop", "CREATE TABLE a (id int);", deps, owner)).rejects.toMatchObject({ kind: "schema" });
            expect(calls.slice(-2).map((call) => call.sql)).toEqual(['DROP DATABASE IF EXISTS "gf_1234abcd_shop"', 'DROP ROLE IF EXISTS "gf_1234abcd_shop"']);
        });

        it("drops only the role when the database could not be created", async () => {
            const { calls, deps } = fakeServer({ fail: (call) => (call.sql.startsWith("CREATE DATABASE") ? { message: "disk full" } : undefined) });
            await expect(createDatabaseFromSql(config, "gf_1234abcd_shop", "CREATE TABLE a (id int);", deps, owner)).rejects.toMatchObject({ kind: "server" });
            const dropped = calls.map((call) => call.sql).filter((sql) => sql.startsWith("DROP"));
            expect(dropped).toEqual(['DROP ROLE IF EXISTS "gf_1234abcd_shop"']);
        });

        it("refuses a name already taken as a role, and says a role is missing a right when the server refuses", async () => {
            const taken = fakeServer({ fail: (call) => (call.sql.startsWith("SELECT 1 FROM pg_roles") ? undefined : undefined) });
            const roleExists: CreateDatabaseDeps = { withClient: async (cfg, fn) => fn({ query: async (sql: string) => ({ rowCount: sql.startsWith("SELECT 1 FROM pg_roles") ? 1 : 0 }) } as unknown as Client) };
            await expect(createDatabaseFromSql(config, "gf_1234abcd_shop", "CREATE TABLE a (id int);", roleExists, owner)).rejects.toBeInstanceOf(DatabaseExistsError);
            expect(taken.calls).toHaveLength(0);

            const denied = fakeServer({ fail: (call) => (call.sql.startsWith("CREATE ROLE") ? { message: "permission denied to create role", code: "42501" } : undefined) });
            await expect(createDatabaseFromSql(config, "gf_1234abcd_shop", "CREATE TABLE a (id int);", denied.deps, owner)).rejects.toMatchObject({ kind: "permission", message: expect.stringMatching(/CREATEROLE and CREATEDB/) });
        });

        it("refuses an unsafe role name or password before connecting", async () => {
            const { calls, deps } = fakeServer();
            await expect(createDatabaseFromSql(config, "ok_db", "CREATE TABLE a (id int);", deps, { role: "bad role", password: "a".repeat(24) })).rejects.toBeInstanceOf(CreateDatabaseError);
            await expect(createDatabaseFromSql(config, "ok_db", "CREATE TABLE a (id int);", deps, { role: "ok_role", password: "short" })).rejects.toBeInstanceOf(CreateDatabaseError);
            await expect(createDatabaseFromSql(config, "ok_db", "CREATE TABLE a (id int);", deps, { role: "ok_role", password: "a'; DROP ROLE x; --aaaaaaaaaa" })).rejects.toBeInstanceOf(CreateDatabaseError);
            expect(calls).toHaveLength(0);
        });
    });

    it("refuses a name that is not a plain identifier, and an empty script, before connecting", async () => {
        const { calls, deps } = fakeServer();
        for (const bad of ["", "1abc", "has space", 'quote"d', "semi;colon", "a".repeat(64), "dash-ed"]) {
            await expect(createDatabaseFromSql(config, bad, "CREATE TABLE a (id int);", deps), bad).rejects.toBeInstanceOf(CreateDatabaseError);
        }
        await expect(createDatabaseFromSql(config, "ok_name", "  \n -- only a comment\n", deps)).rejects.toMatchObject({ kind: "schema" });
        expect(calls).toHaveLength(0);
        expect(DATABASE_NAME_PATTERN.test("Sales_2026")).toBe(true);
        expect(DATABASE_NAME_PATTERN.test("a".repeat(63))).toBe(true);
    });
});
