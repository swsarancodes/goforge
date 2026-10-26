import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { adminConfigFromUrl } from "./cloud-databases.js";
import { withOracle } from "./oracle-client.js";
import { copyTable, failedChecks, loadAndVerify, planOracleMigration, verifyTable, type MigrationEdits } from "./oracle-migration.js";
import { createOracleSchema, dropOracleSchema, newSchemaPassword, oracleSchemaName, oracleServerFromEnv } from "./oracle-schemas.js";
import { oracleSql } from "./oracle-sql.js";
import { oracleConnectionRow } from "./oracle-schemas.js";
import { createDatabaseFromSql } from "./pg-create-database.js";
import { withPgClient } from "./pg-client.js";

/**
 * Against a real Oracle AND a real PostgreSQL: ORACLE_TEST_ADMIN_URL=oracle://system:pw@127.0.0.1:1521/FREEPDB1 and
 * PG_TEST_ADMIN_URL=postgres://postgres:pw@127.0.0.1:54330/postgres (a role that may create databases). Skipped without both.
 */
process.env.MASTER_KEY ??= randomBytes(32).toString("base64");
const oracleUrl = process.env.ORACLE_TEST_ADMIN_URL;
const pgUrl = process.env.PG_TEST_ADMIN_URL;
const server = oracleUrl ? oracleServerFromEnv({ ORACLE_ADMIN_URL: oracleUrl } as NodeJS.ProcessEnv) : undefined;
const domain = (file: string) => readFileSync(resolve(import.meta.dirname, "../../../queryshift/domain", file), "utf8");

// every Oracle type the migration supports, with awkward values
const EXTRA = `CREATE TABLE extra_types (
    id NUMBER(5) PRIMARY KEY,
    small NUMBER(3),
    money NUMBER(12,2),
    huge NUMBER(25,0),
    plain NUMBER,
    f FLOAT,
    bf BINARY_FLOAT,
    bd BINARY_DOUBLE,
    v VARCHAR2(20 CHAR),
    c CHAR(3),
    cl CLOB,
    bl BLOB,
    r RAW(4),
    d DATE,
    ts TIMESTAMP(3),
    tz TIMESTAMP WITH TIME ZONE,
    dflt NUMBER DEFAULT 7 NOT NULL,
    label VARCHAR2(10) DEFAULT 'new' NOT NULL,
    made DATE DEFAULT SYSDATE,
    CONSTRAINT extra_uq UNIQUE (v)
)`;

describe.skipIf(!server || !pgUrl)("Oracle to PostgreSQL migration (real Oracle, real PostgreSQL)", () => {
    const oracleAdmin = server?.admin as NonNullable<typeof server>["admin"];
    const pgAdmin = adminConfigFromUrl(pgUrl ?? "postgres://x:y@127.0.0.1/postgres");
    const schemas: string[] = [];
    const databases: string[] = [];
    afterAll(async () => {
        for (const schema of schemas) await dropOracleSchema(oracleAdmin, schema).catch(() => undefined);
        for (const database of databases) await withPgClient(pgAdmin, (client) => client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)).catch(() => undefined);
    });

    async function oracleWith(ddl: string, scripts: string[]) {
        const schema = oracleSchemaName("0a1b2c3d-0000-0000-0000-000000000000", `mig_${Math.random().toString(36).slice(2, 6)}`);
        schemas.push(schema);
        const password = newSchemaPassword();
        await createOracleSchema(oracleAdmin, schema, password, ddl);
        const row = oracleConnectionRow(oracleAdmin, schema, "mig", password);
        for (const script of scripts) {
            const outcome = await oracleSql.run(row, "mig-0001", script);
            expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.error)).toBe(true);
        }
        return { schema, config: { ...oracleAdmin, user: schema, password } };
    }
    const newDatabase = () => {
        const name = `mig_test_${Math.random().toString(36).slice(2, 8)}`;
        databases.push(name);
        return name;
    };

    it("migrates the insurance schema with 200 synthetic customers: same tables, keys, rows and totals", async () => {
        const { config } = await oracleWith(domain("legacy_schema.sql"), [domain("generate_synthetic_data_oracle.sql")]);
        const plan = await withOracle(config, planOracleMigration);
        expect(plan.problems).toEqual([]);
        expect(plan.tables.map((t) => t.pgName)).toEqual(["clm_dtl", "coverage", "cust_mst", "polcy_hdr"]);
        expect(plan.tables.find((t) => t.pgName === "cust_mst")?.rows).toBe(200);

        const database = newDatabase();
        await createDatabaseFromSql(pgAdmin, database, plan.createSql.join(";\n"));
        const result = await withOracle(config, (oracle) => withPgClient({ ...pgAdmin, database }, (pg) => loadAndVerify(oracle, pg, plan)));
        expect(result.tables.map((t) => [t.name, t.rows])).toEqual(plan.tables.map((t) => [t.pgName, t.rows]));
        expect(result.verification.every((v) => v.mismatches.length === 0)).toBe(true);
        expect(result.verification.find((v) => v.table === "clm_dtl")?.checks).toBeGreaterThan(5);

        await withPgClient({ ...pgAdmin, database }, async (pg) => {
            const type = async (table: string, column: string) => (await pg.query("SELECT data_type, numeric_precision, numeric_scale, datetime_precision FROM information_schema.columns WHERE table_name = $1 AND column_name = $2", [table, column])).rows[0];
            expect(await type("cust_mst", "cust_id")).toMatchObject({ data_type: "bigint" });
            expect(await type("polcy_hdr", "annl_prem")).toMatchObject({ data_type: "numeric", numeric_precision: 12, numeric_scale: 2 });
            expect(await type("clm_dtl", "clm_dt")).toMatchObject({ data_type: "timestamp without time zone", datetime_precision: 0 });
            const constraints = (await pg.query("SELECT constraint_type, count(*)::int AS n FROM information_schema.table_constraints WHERE table_schema = 'public' AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY') GROUP BY 1 ORDER BY 1")).rows;
            expect(constraints).toEqual([{ constraint_type: "FOREIGN KEY", n: 3 }, { constraint_type: "PRIMARY KEY", n: 4 }]);
            // the keys are enforced in the copy
            await expect(pg.query("INSERT INTO polcy_hdr VALUES (999999, 999999, 'AUTO', now(), now(), 1, 'AC')")).rejects.toThrow(/foreign key/i);
        });
    }, 180_000);

    it("carries every supported type, awkward values included, exactly", async () => {
        const inserts = `
            INSERT INTO extra_types (id, small, money, huge, plain, f, bf, bd, v, c, cl, bl, r, d, ts, tz) VALUES
              (1, -7, 1234567890.12, 1234567890123456789012345, 0.5, 3.14159, 1.5, 2.718281828459045, 'héllo wörld ünï', 'ab', 'short clob', HEXTORAW('00FF10'), HEXTORAW('DEADBEEF'),
               TIMESTAMP '2026-03-31 16:45:00', TIMESTAMP '2026-03-31 16:45:00.123', TIMESTAMP '2026-03-31 16:45:00.5 +05:30');
            INSERT INTO extra_types (id) VALUES (2);
            INSERT INTO extra_types (id, small, plain, v) VALUES (3, 999, -0.000001, 'O''Brien "quoted"');
            INSERT INTO extra_types (id, plain, d) VALUES (4, 100, DATE '0001-01-01');
        `;
        const { config } = await oracleWith(EXTRA, [inserts]);
        // a CLOB much bigger than a VARCHAR2 can hold
        await withOracle(config, async (c) => {
            await c.execute("UPDATE extra_types SET cl = :big WHERE id = 3", { big: { val: "x".repeat(200_000), type: (await import("./oracle-client.js")).oracledb.DB_TYPE_CLOB } }, { autoCommit: true });
        });

        const plan = await withOracle(config, planOracleMigration);
        expect(plan.problems).toEqual([]);
        expect(plan.createSql[0]).toContain('"dflt" numeric NOT NULL DEFAULT 7');
        expect(plan.createSql[0]).toContain(`"label" varchar(10) NOT NULL DEFAULT 'new'`);
        expect(plan.createSql[0]).toContain('"made" timestamp(0) DEFAULT CURRENT_TIMESTAMP');
        expect(plan.createSql[0]).toContain('CONSTRAINT "extra_uq" UNIQUE ("v")');
        expect(plan.createSql[0]).toContain('"tz" timestamptz(6)');

        const database = newDatabase();
        await createDatabaseFromSql(pgAdmin, database, plan.createSql.join(";\n"));
        await withOracle(config, (oracle) => withPgClient({ ...pgAdmin, database }, async (pg) => {
            const result = await loadAndVerify(oracle, pg, plan);
            expect(result.tables).toEqual([{ name: "extra_types", rows: 4 }]);
            const rows = (await pg.query("SELECT id, small, money::text, huge::text, plain::text, f, bf, bd, v, c, length(cl) AS cl_len, encode(bl, 'hex') AS bl, encode(r, 'hex') AS r, d::text, ts::text, to_char(tz AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS tz_utc, dflt::text, label, made IS NOT NULL AS made FROM extra_types ORDER BY id")).rows;
            expect(rows[0]).toMatchObject({ id: 1, small: -7, money: "1234567890.12", huge: "1234567890123456789012345", plain: "0.5", v: "héllo wörld ünï", c: "ab ", cl_len: 10, bl: "00ff10", r: "deadbeef", d: "2026-03-31 16:45:00", ts: "2026-03-31 16:45:00.123", dflt: "7", label: "new", made: true });
            expect(rows[0].f).toBeCloseTo(3.14159, 10);
            expect(rows[0].bf).toBe(1.5);
            expect(rows[0].bd).toBeCloseTo(2.718281828459045, 14);
            expect(rows[0].tz_utc).toBe("2026-03-31 11:15:00.500"); // the same instant, in UTC: 16:45 at +05:30
            expect(rows[1]).toMatchObject({ id: 2, small: null, money: null, v: null, cl_len: null, bl: null, d: null, tz_utc: null });
            expect(rows[2]).toMatchObject({ small: 999, plain: "-0.000001", v: 'O\'Brien "quoted"', cl_len: 200_000 });
            expect(rows[3]).toMatchObject({ plain: "100", d: "0001-01-01 00:00:00" });
        }));
    }, 180_000);

    it("keeps nothing when the copy does not match: a tampered target is caught and rolled back", async () => {
        const { config } = await oracleWith(domain("legacy_schema.sql"), [domain("generate_synthetic_data_oracle.sql")]);
        const plan = await withOracle(config, planOracleMigration);
        const database = newDatabase();
        await createDatabaseFromSql(pgAdmin, database, plan.createSql.join(";\n"));
        await withOracle(config, (oracle) => withPgClient({ ...pgAdmin, database }, async (pg) => {
            // a trigger that quietly changes every claim amount on the way in: the totals can no longer match
            await pg.query(`CREATE FUNCTION skew() RETURNS trigger AS $$ BEGIN NEW.clm_amt := NEW.clm_amt + 1; RETURN NEW; END $$ LANGUAGE plpgsql`);
            await pg.query("CREATE TRIGGER skew BEFORE INSERT ON clm_dtl FOR EACH ROW EXECUTE FUNCTION skew()");
            await expect(loadAndVerify(oracle, pg, plan)).rejects.toThrow(/does not match Oracle: clm_dtl \(sum of clm_amt/);
            const left = await pg.query("SELECT (SELECT count(*) FROM cust_mst)::int AS c, (SELECT count(*) FROM clm_dtl)::int AS k");
            expect(left.rows[0]).toEqual({ c: 0, k: 0 });
        }));
    }, 180_000);

    it("refuses a schema it cannot migrate faithfully, naming the column", async () => {
        const { config } = await oracleWith("CREATE TABLE odd (id NUMBER(5) PRIMARY KEY, span INTERVAL DAY TO SECOND, g VARCHAR2(40) DEFAULT SYS_GUID())", []);
        const plan = await withOracle(config, planOracleMigration);
        expect(plan.problems.join(" ")).toMatch(/ODD\.SPAN: INTERVAL DAY\(2\) TO SECOND\(6\) has no PostgreSQL type/);
        expect(plan.problems.join(" ")).toMatch(/ODD\.G: its default SYS_GUID\(\) is Oracle code/);
    });

    it("can verify a single table and copy it on its own", async () => {
        const { config } = await oracleWith(domain("legacy_schema.sql"), [domain("generate_synthetic_data_oracle.sql")]);
        const plan = await withOracle(config, planOracleMigration);
        const database = newDatabase();
        await createDatabaseFromSql(pgAdmin, database, plan.createSql.join(";\n"));
        const customers = plan.tables.find((t) => t.pgName === "cust_mst")!;
        await withOracle(config, (oracle) => withPgClient({ ...pgAdmin, database }, async (pg) => {
            expect(await copyTable(oracle, pg, customers)).toBe(200);
            const verified = await verifyTable(oracle, pg, customers);
            expect(verified).toMatchObject({ table: "cust_mst", oracleRows: 200, postgresRows: 200, mismatches: [] });
        }));
    }, 120_000);

    it("says what it will not carry over and how each column fares, before anything runs", async () => {
        const { config } = await oracleWith(
            `CREATE TABLE notes (id NUMBER(6) PRIMARY KEY, qty NUMBER(3) CHECK (qty > 0), name VARCHAR2(20), f FLOAT, tz TIMESTAMP WITH TIME ZONE, made DATE);
             CREATE INDEX notes_name_ix ON notes (name);
             CREATE SEQUENCE notes_seq;
             CREATE VIEW notes_v AS SELECT id, name FROM notes`,
            [],
        );
        const plan = await withOracle(config, planOracleMigration);
        expect(plan.problems).toEqual([]);
        const left = plan.notCarried.map((entry) => `${entry.kind}:${entry.name}`).sort();
        expect(left).toEqual(["check constraint:" + left.find((l) => l.startsWith("check constraint:"))!.split(":")[1], "index:NOTES_NAME_IX", "sequence:NOTES_SEQ", "view:NOTES_V"].sort());
        expect(plan.notCarried.find((entry) => entry.kind === "check constraint")?.detail).toMatch(/on NOTES: qty > 0/i);
        // the primary key's own index is carried, so it is not listed as left behind
        expect(left.some((entry) => /NOTES_PK|SYS_C/.test(entry) && entry.startsWith("index:"))).toBe(false);
        const status = (name: string) => plan.tables[0].columns.find((c) => c.oracleName === name)!.note.status;
        expect([status("ID"), status("F"), status("TZ"), status("MADE")]).toEqual(["exact", "risk", "risk", "changed"]);
    });

    it("proves a migration by queries on both sides: every comparison with its expression and both answers, and the first rows side by side", async () => {
        const { config } = await oracleWith(domain("legacy_schema.sql"), [domain("generate_synthetic_data_oracle.sql")]);
        const plan = await withOracle(config, planOracleMigration);
        const database = newDatabase();
        await createDatabaseFromSql(pgAdmin, database, plan.createSql.join(";\n"));
        const result = await withOracle(config, (oracle) => withPgClient({ ...pgAdmin, database }, (pg) => loadAndVerify(oracle, pg, plan)));
        const customers = result.verification.find((v) => v.table === "cust_mst")!;

        const rows = customers.proof.checks.find((check) => check.label === "rows")!;
        expect(rows).toMatchObject({ oracleExpression: "COUNT(*)", oracle: "200", postgres: "200", match: true });
        expect(customers.proof.checks.map((check) => check.label)).toEqual(expect.arrayContaining(["NULLs in cust_email", "sum of cust_id", "first join_dt", "last join_dt", "total length of cust_nm"]));
        expect(customers.proof.checks.every((check) => check.match)).toBe(true);
        expect(customers.proof.oracleSql).toMatch(/^SELECT COUNT\(\*\), COUNT\(CASE WHEN "CUST_ID" IS NULL THEN 1 END\)/);
        expect(customers.proof.postgresSql).toContain("FROM \"cust_mst\"");

        const sample = customers.proof.sample!;
        expect(sample.oracleSql).toContain("ORDER BY \"CUST_ID\" FETCH FIRST 5 ROWS ONLY");
        expect(sample.postgresSql).toContain("ORDER BY \"cust_id\" LIMIT 5");
        expect(sample.oracleRows).toHaveLength(5);
        expect(sample.oracleRows.map((row) => row[0])).toEqual(["1", "2", "3", "4", "5"]);
        expect(sample.postgresRows.map((row) => row[0])).toEqual(["1", "2", "3", "4", "5"]);
        expect(sample.match).toBe(true);
        expect(customers.checks).toBe(customers.proof.checks.length + 1);

        // the same proof, run again on its own against the database that now exists
        await withOracle(config, (oracle) => withPgClient({ ...pgAdmin, database }, async (pg) => {
            const again = await verifyTable(oracle, pg, plan.tables.find((t) => t.pgName === "cust_mst")!);
            expect(again.mismatches).toEqual([]);
            expect(again.proof.checks.map((check) => check.postgres)).toEqual(customers.proof.checks.map((check) => check.postgres));
        }));
    }, 180_000);

    describe("with the person's edits", () => {
        const DDL = `CREATE TABLE pol (id NUMBER(6) PRIMARY KEY, started DATE NOT NULL, ended DATE, active NUMBER(1) DEFAULT 1, qty VARCHAR2(10), label VARCHAR2(30), price NUMBER(10,2));
            CREATE TABLE ev (ev_id NUMBER(6) PRIMARY KEY, pol_id NUMBER(6) REFERENCES pol (id), happened TIMESTAMP(3))`;
        const ROWS = `
            INSERT INTO pol VALUES (1, DATE '2026-01-01', DATE '2026-12-31', 1, '7', 'alpha', 10.50);
            INSERT INTO pol VALUES (2, TO_DATE('2026-03-04 09:30:00', 'YYYY-MM-DD HH24:MI:SS'), NULL, 0, '12', NULL, 99.99);
            INSERT INTO pol VALUES (3, DATE '2026-05-05', DATE '2027-05-05', 1, 'x', 'gamma', 1);
            INSERT INTO ev VALUES (10, 1, TIMESTAMP '2026-01-02 03:04:05.678');
            INSERT INTO ev VALUES (11, 3, NULL);
        `;
        const edits: MigrationEdits = {
            tables: { POL: { pgName: "policy" }, EV: { pgName: "event" } },
            columns: {
                "POL.ID": { pgName: "policy_id" },
                "EV.POL_ID": { pgName: "policy_id" },
                "POL.STARTED": { pgType: "date" },
                "POL.ENDED": { pgType: "date" },
                "POL.ACTIVE": { pgType: "boolean" },
                "POL.QTY": { pgType: "integer" },
            },
        };

        it("counts, on the Oracle data, what each change would lose, before anything is migrated", async () => {
            const { config } = await oracleWith(DDL, [ROWS]);
            const plan = await withOracle(config, (c) => planOracleMigration(c, edits));
            expect(plan.problems).toEqual([]);
            expect(plan.editProblems).toEqual([]);
            const pol = plan.tables.find((t) => t.oracleName === "POL")!;
            const counts = Object.fromEntries(pol.columns.flatMap((c) => (c.check ? [[c.oracleName, c.check.count]] : [])));
            expect(counts).toEqual({ STARTED: 1, ENDED: 0, ACTIVE: 0, QTY: 1 });
            expect(failedChecks(plan).map((f) => `${f.table}.${f.column}`)).toEqual(["policy.started", "policy.qty"]);
            const started = pol.columns.find((c) => c.oracleName === "STARTED")!;
            expect(started.check?.sql).toBe('SELECT COUNT(*) FROM "POL" WHERE "STARTED" <> TRUNC("STARTED")');
            expect(started.note).toMatchObject({ status: "risk", text: expect.stringContaining("1 value would be affected (values with a time of day, which a date does not keep)") });
            expect(pol.columns.find((c) => c.oracleName === "ENDED")!.note.status).toBe("changed");
            // with no edits there is nothing to count here
            const plain = await withOracle(config, (c) => planOracleMigration(c));
            expect(failedChecks(plain)).toEqual([]);
        });

        it("migrates under the new names and types, and the proof still compares every table", async () => {
            const { config } = await oracleWith(DDL, [ROWS]);
            const passing: MigrationEdits = { ...edits, columns: { ...edits.columns, "POL.QTY": undefined as never } };
            delete passing.columns!["POL.QTY"];
            const plan = await withOracle(config, (c) => planOracleMigration(c, passing));
            const database = newDatabase();
            await createDatabaseFromSql(pgAdmin, database, plan.createSql.join(";\n"));
            const result = await withOracle(config, (oracle) => withPgClient({ ...pgAdmin, database }, (pg) => loadAndVerify(oracle, pg, plan)));
            expect(result.tables).toEqual([{ name: "event", rows: 2 }, { name: "policy", rows: 3 }]);
            expect(result.verification.every((v) => v.mismatches.length === 0)).toBe(true);

            const policy = result.verification.find((v) => v.table === "policy")!;
            // a date column is compared by its day: the Oracle side is cut to the day too
            const first = policy.proof.checks.find((c) => c.label === "first started")!;
            expect(first).toMatchObject({ oracle: "2026-01-01", postgres: "2026-01-01", match: true });
            expect(first.oracleExpression).toBe(`TO_CHAR(TRUNC(MIN("STARTED")), 'YYYY-MM-DD')`);
            expect(policy.proof.sample?.match).toBe(true);

            await withPgClient({ ...pgAdmin, database }, async (pg) => {
                const types = (await pg.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'policy' ORDER BY ordinal_position")).rows;
                expect(types).toEqual([
                    { column_name: "policy_id", data_type: "integer" },
                    { column_name: "started", data_type: "date" },
                    { column_name: "ended", data_type: "date" },
                    { column_name: "active", data_type: "boolean" },
                    { column_name: "qty", data_type: "character varying" },
                    { column_name: "label", data_type: "character varying" },
                    { column_name: "price", data_type: "numeric" },
                ]);
                const rows = (await pg.query("SELECT policy_id, started::text AS started, active FROM policy ORDER BY policy_id")).rows;
                expect(rows).toEqual([{ policy_id: 1, started: "2026-01-01", active: true }, { policy_id: 2, started: "2026-03-04", active: false }, { policy_id: 3, started: "2026-05-05", active: true }]);
                expect((await pg.query("SELECT conname FROM pg_constraint WHERE contype = 'f'")).rows).toHaveLength(1);
                await expect(pg.query("INSERT INTO event VALUES (99, 12345, now())")).rejects.toThrow(/foreign key/i);
            });
        });

        it("keeps nothing when a change turns out not to fit the data: text that is not a number going into an integer", async () => {
            const { config } = await oracleWith(DDL, [ROWS]);
            const plan = await withOracle(config, (c) => planOracleMigration(c, edits));
            const database = newDatabase();
            await createDatabaseFromSql(pgAdmin, database, plan.createSql.join(";\n"));
            await withOracle(config, (oracle) =>
                withPgClient({ ...pgAdmin, database }, async (pg) => {
                    await expect(loadAndVerify(oracle, pg, plan)).rejects.toThrow(/invalid input syntax for type integer/);
                    expect((await pg.query("SELECT (SELECT count(*) FROM policy)::int AS p, (SELECT count(*) FROM event)::int AS e")).rows[0]).toEqual({ p: 0, e: 0 });
                }),
            );
        });
    });
});
