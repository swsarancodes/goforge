import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOracle } from "./oracle-client.js";
import { oracleConfigOf } from "./oracle-client.js";
import { createOracleSchema, dropOracleSchema, newSchemaPassword, oracleConnectionRow, oracleSchemaName, oracleServerFromEnv } from "./oracle-schemas.js";
import { oracleSql } from "./oracle-sql.js";

/**
 * Against a real Oracle: set ORACLE_TEST_ADMIN_URL=oracle://system:password@127.0.0.1:1521/FREEPDB1 (for example the gvenzl/oracle-free
 * container; see docker-compose.yml). Without it these tests are skipped, because a stand-in cannot say what Oracle does.
 */
// connection rows encrypt the schema password; any key will do for a test
process.env.MASTER_KEY ??= randomBytes(32).toString("base64");
const url = process.env.ORACLE_TEST_ADMIN_URL;
const server = url ? oracleServerFromEnv({ ORACLE_ADMIN_URL: url } as NodeJS.ProcessEnv) : undefined;
const INSURANCE = readFileSync(resolve(import.meta.dirname, "../../../queryshift/domain/legacy_schema.sql"), "utf8");

describe.skipIf(!server)("Oracle schemas and SQL (real Oracle)", () => {
    // the body of a skipped describe still runs to collect its tests, so this must not throw when there is no Oracle
    const admin = server?.admin as NonNullable<typeof server>["admin"];
    const owner = "0a1b2c3d-0000-0000-0000-000000000000";
    const made: string[] = [];
    const schemaFor = (name: string) => {
        const schema = oracleSchemaName(owner, `${name}_${Math.random().toString(36).slice(2, 6)}`);
        made.push(schema);
        return schema;
    };
    const exists = (schema: string) => withOracle(admin, async (c) => ((await c.execute("SELECT count(*) FROM dba_users WHERE username = :n", { n: schema })).rows as number[][])[0][0] === 1);

    afterAll(async () => {
        for (const schema of made) await dropOracleSchema(admin, schema).catch(() => undefined);
    });

    it("creates a schema from the pasted Oracle DDL, and the tables belong to it", async () => {
        const schema = schemaFor("ins");
        const password = newSchemaPassword();
        const { statementsRun } = await createOracleSchema(admin, schema, password, INSURANCE);
        expect(statementsRun).toBe(3);
        const tables = await withOracle({ ...admin, user: schema, password }, async (c) => ((await c.execute("SELECT table_name FROM user_tables ORDER BY table_name")).rows as string[][]).map((r) => r[0]));
        expect(tables).toEqual(["CLM_DTL", "CUST_MST", "POLCY_HDR"]);
    });

    it("runs Oracle SQL through the SQL page's runner: results as text, NULL as null, dates with their time, numbers with a leading zero", async () => {
        const schema = schemaFor("run");
        const password = newSchemaPassword();
        await createOracleSchema(admin, schema, password, INSURANCE);
        const row = oracleConnectionRow(admin, schema, "run", password);

        const insert = await oracleSql.run(row, "sess-0001", "INSERT INTO cust_mst VALUES (1, 'Asha', NULL, 'RET', TIMESTAMP '2019-04-12 00:00:00');\nINSERT INTO cust_mst VALUES (2, 'Brightline', 'b@example.com', 'COM', DATE '2020-11-03');");
        expect(insert.ok).toBe(true);
        expect(insert.results.map((r) => [r.command, r.rowCount])).toEqual([["INSERT", 1], ["INSERT", 1]]);

        const select = await oracleSql.run(row, "sess-0001", "SELECT cust_id, cust_nm, cust_email, join_dt, cust_id / 4 AS quarter, TIMESTAMP '2026-03-31 16:45:00' AS ts FROM cust_mst ORDER BY cust_id;");
        expect(select.ok).toBe(true);
        const [result] = select.results;
        expect(result.columns.map((c) => c.name)).toEqual(["CUST_ID", "CUST_NM", "CUST_EMAIL", "JOIN_DT", "QUARTER", "TS"]);
        expect(result.columns.map((c) => c.dataType)).toEqual(["NUMBER", "VARCHAR2", "VARCHAR2", "DATE", "NUMBER", "TIMESTAMP"]);
        expect(result.rows).toEqual([
            ["1", "Asha", null, "2019-04-12 00:00:00", "0.25", "2026-03-31 16:45:00"],
            ["2", "Brightline", "b@example.com", "2020-11-03 00:00:00", "0.5", "2026-03-31 16:45:00"],
        ]);
        expect(result.command).toBe("SELECT");
        expect(result.rowCount).toBe(2);
        expect(select.transaction).toEqual({ open: false, hasChanges: false, startedAt: null });
        // each statement committed: a second connection sees the rows
        expect(await withOracle({ ...admin, user: schema, password }, async (c) => ((await c.execute("SELECT count(*) FROM cust_mst")).rows as number[][])[0][0])).toBe(2);
    });

    it("keeps Oracle's rule that '' is NULL, and does not lose a big number to a double", async () => {
        const schema = schemaFor("sem");
        const password = newSchemaPassword();
        await createOracleSchema(admin, schema, password, "CREATE TABLE t (a VARCHAR2(10), n NUMBER)");
        const row = oracleConnectionRow(admin, schema, "sem", password);
        await oracleSql.run(row, "sess-0002", "INSERT INTO t VALUES ('', 12345678901234567890.123)");
        const { results } = await oracleSql.run(row, "sess-0002", "SELECT a, n, nvl(a, 'was null') AS shown, 'x' || a || 'y' AS joined FROM t");
        expect(results[0].rows).toEqual([[null, "12345678901234567890.123", "was null", "xy"]]);
    });

    it("runs a script with a PL/SQL block and reports each statement", async () => {
        const schema = schemaFor("blk");
        const password = newSchemaPassword();
        await createOracleSchema(admin, schema, password, "CREATE TABLE t (id NUMBER)");
        const row = oracleConnectionRow(admin, schema, "blk", password);
        const script = "BEGIN\n  FOR i IN 1..3 LOOP INSERT INTO t VALUES (i); END LOOP;\nEND;\n/\nSELECT count(*) AS n FROM t;\nSELECT 1 FROM dual WHERE 1 = 0;";
        const outcome = await oracleSql.run(row, "sess-0003", script);
        expect(outcome.ok).toBe(true);
        expect(outcome.results.map((r) => r.command)).toEqual(["BEGIN", "SELECT", "SELECT"]);
        expect(outcome.results[1].rows).toEqual([["3"]]);
        expect(outcome.results[2].rows).toEqual([]);
    });

    it("stops at the first error with its ORA code and where it is in the script, and keeps what ran before it", async () => {
        const schema = schemaFor("err");
        const password = newSchemaPassword();
        await createOracleSchema(admin, schema, password, "CREATE TABLE t (id NUMBER)");
        const row = oracleConnectionRow(admin, schema, "err", password);
        const script = "INSERT INTO t VALUES (1);\nSELECT * FROM no_such_table;\nINSERT INTO t VALUES (2);";
        const outcome = await oracleSql.run(row, "sess-0004", script);
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.error.code).toBe("ORA-00942");
        expect(outcome.error.message).toMatch(/table or view/i);
        expect(script.slice(outcome.error.position! - 1)).toMatch(/^no_such_table/);
        expect(outcome.results).toHaveLength(1); // the first insert ran and committed
        const count = await oracleSql.run(row, "sess-0004", "SELECT count(*) FROM t");
        expect(count.ok && count.results[0].rows).toEqual([["1"]]);
    });

    it("cannot reach another schema or create users: it is a sandbox", async () => {
        const a = schemaFor("iso_a");
        const b = schemaFor("iso_b");
        const [pa, pb] = [newSchemaPassword(), newSchemaPassword()];
        await createOracleSchema(admin, a, pa, "CREATE TABLE secret (v NUMBER)");
        await createOracleSchema(admin, b, pb, "CREATE TABLE mine (v NUMBER)");
        const rowB = oracleConnectionRow(admin, b, "b", pb);
        const peek = await oracleSql.run(rowB, "sess-0005", `SELECT * FROM ${a}.secret`);
        expect(peek.ok).toBe(false);
        expect(!peek.ok && peek.error.code).toBe("ORA-00942");
        const makeUser = await oracleSql.run(rowB, "sess-0005", 'CREATE USER intruder IDENTIFIED BY "x"');
        expect(makeUser.ok).toBe(false);
        expect(!makeUser.ok && makeUser.error.code).toBe("ORA-01031");
        const dba = await oracleSql.run(rowB, "sess-0005", "SELECT * FROM dba_users");
        expect(dba.ok).toBe(false);
    });

    it("leaves nothing behind when the script fails, and says which statement", async () => {
        const schema = schemaFor("bad");
        await expect(createOracleSchema(admin, schema, newSchemaPassword(), "CREATE TABLE ok (id NUMBER);\nCREATE TABLE broken (id NOT_A_TYPE);")).rejects.toMatchObject({ kind: "schema", message: expect.stringMatching(/Statement 2 failed/) });
        expect(await exists(schema)).toBe(false);
    });

    it("refuses a name it did not make, and a name that is taken", async () => {
        await expect(createOracleSchema(admin, "SYSTEM", newSchemaPassword(), "SELECT 1 FROM dual")).rejects.toMatchObject({ kind: "schema" });
        await expect(dropOracleSchema(admin, "SYSTEM")).rejects.toThrow(/not a schema this app created/);
        await expect(dropOracleSchema(admin, 'GF_0A1B2C3D_X"; DROP USER SYSTEM; --')).rejects.toThrow(/not a schema this app created/);
        const schema = schemaFor("dup");
        await createOracleSchema(admin, schema, newSchemaPassword(), "CREATE TABLE t (id NUMBER)");
        await expect(createOracleSchema(admin, schema, newSchemaPassword(), "CREATE TABLE t (id NUMBER)")).rejects.toMatchObject({ kind: "exists" });
        expect(await exists(schema)).toBe(true); // the first one is untouched
    });

    it("drops a schema with its tables, even while it has a session open", async () => {
        const schema = schemaFor("drop");
        const password = newSchemaPassword();
        await createOracleSchema(admin, schema, password, "CREATE TABLE t (id NUMBER)");
        const open = await (await import("./oracle-client.js")).oracledb.getConnection({ user: schema, password, connectString: `${admin.host}:${admin.port}/${admin.database}` });
        await open.execute("SELECT 1 FROM dual");
        await dropOracleSchema(admin, schema);
        expect(await exists(schema)).toBe(false);
        await open.close().catch(() => undefined);
    });

    it("stops a statement that runs too long, and can be cancelled", async () => {
        const schema = schemaFor("slow");
        const password = newSchemaPassword();
        await createOracleSchema(admin, schema, password, "CREATE TABLE t (id NUMBER)");
        const row = oracleConnectionRow(admin, schema, "slow", password);
        const started = Date.now();
        const timedOut = await oracleSql.run(row, "sess-0006", "BEGIN DBMS_SESSION.SLEEP(20); END;\n/", { callTimeoutMs: 1500, admin });
        expect(timedOut.ok).toBe(false);
        expect(!timedOut.ok && timedOut.error).toMatchObject({ code: "timeout", message: expect.stringMatching(/ran longer than/) });
        expect(Date.now() - started).toBeLessThan(12_000);

        const pending = oracleSql.run(row, "sess-0007", "BEGIN DBMS_SESSION.SLEEP(20); END;\n/", { admin });
        await new Promise((done) => setTimeout(done, 1000));
        expect(await oracleSql.cancel(row.id, "sess-0007")).toEqual({ cancelled: true });
        const outcome = await pending;
        expect(outcome.ok).toBe(false);
        expect(!outcome.ok && outcome.error.code).toBe("cancelled");
        expect(Date.now() - started).toBeLessThan(30_000);
        expect(oracleConfigOf(row).user).toBe(schema);
    }, 60_000);
});

describe("oracle schema names", () => {
    it("are unique per account, at most 30 characters, and only ever our own shape", async () => {
        const { oracleSchemaName: name, isOracleSchemaName } = await import("./oracle-schemas.js");
        const schema = name("0a1b2c3d-4e5f-6789-abcd-ef0123456789", "My Shop (2026) — très long name here");
        expect(schema).toMatch(/^GF_0A1B2C3D_[A-Z0-9_]+$/);
        expect(schema.length).toBeLessThanOrEqual(30);
        expect(isOracleSchemaName(schema)).toBe(true);
        expect(name("0a1b2c3d-0000", "")).toBe("GF_0A1B2C3D_DATABASE");
        // the local owner is not an account id: it still gets a name this app recognises, and the same one every time
        expect(isOracleSchemaName(name("local", "demo"))).toBe(true);
        expect(name("local", "demo")).toBe(name("local", "demo"));
        expect(name("local", "demo")).not.toBe(name("0a1b2c3d-4e5f-6789-abcd-ef0123456789", "demo"));
        for (const bad of ["SYSTEM", "gf_0a1b2c3d_x", 'GF_0A1B2C3D_X"', "GF_0A1B2C3D_", "GF_0A1B2C3D_" + "X".repeat(19)]) expect(isOracleSchemaName(bad), bad).toBe(false);
        expect(name("0a1b2c3d", "a")).not.toBe(name("ffffffff", "a"));
    });

    it("are read from ORACLE_ADMIN_URL, and nothing is configured without it", () => {
        expect(oracleServerFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
        const parsed = oracleServerFromEnv({ ORACLE_ADMIN_URL: "oracle://system:p%40ss@db.example:1522/FREEPDB1", MAX_ORACLE_DATABASES_PER_USER: "3" } as NodeJS.ProcessEnv)!;
        expect(parsed.admin).toMatchObject({ host: "db.example", port: 1522, user: "system", password: "p@ss", database: "FREEPDB1" });
        expect(parsed.maxSchemasPerUser).toBe(3);
        expect(() => oracleServerFromEnv({ ORACLE_ADMIN_URL: "oracle://u:p@host" } as NodeJS.ProcessEnv)).toThrow(/must look like/);
    });
});
