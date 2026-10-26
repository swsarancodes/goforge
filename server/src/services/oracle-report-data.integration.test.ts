import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminConfigFromUrl } from "./cloud-databases.js";
import { buildReport } from "./migration-report.js";
import { withOracle } from "./oracle-client.js";
import { loadAndVerify, planOracleMigration, sameDateText, type PlannedColumn } from "./oracle-migration.js";
import { oracleDisplayExpression, readDataFacts, readSamples } from "./oracle-report-data.js";
import { createOracleSchema, dropOracleSchema, newSchemaPassword, oracleConnectionRow, oracleSchemaName, oracleServerFromEnv } from "./oracle-schemas.js";
import { oracleSql } from "./oracle-sql.js";
import { oracleFamily } from "./oracle-type-edits.js";
import { createDatabaseFromSql } from "./pg-create-database.js";
import { withPgClient } from "./pg-client.js";

/**
 * The part of the report that reads the data, on a real Oracle and PostgreSQL: the counts, the samples before and after, and the check
 * that every sample row is what the copy writes later. ORACLE_TEST_ADMIN_URL and PG_TEST_ADMIN_URL; skipped without them.
 */
process.env.MASTER_KEY ??= randomBytes(32).toString("base64");
const oracleUrl = process.env.ORACLE_TEST_ADMIN_URL;
const pgUrl = process.env.PG_TEST_ADMIN_URL;
const server = oracleUrl ? oracleServerFromEnv({ ORACLE_ADMIN_URL: oracleUrl } as NodeJS.ProcessEnv) : undefined;

const DDL = `CREATE TABLE extra_types (
    id NUMBER(5) PRIMARY KEY, small NUMBER(3), money NUMBER(12,2), huge NUMBER(25,0), plain NUMBER, f FLOAT, bf BINARY_FLOAT, bd BINARY_DOUBLE,
    v VARCHAR2(20 CHAR), c CHAR(3), cl CLOB, bl BLOB, r RAW(4), d DATE, ts TIMESTAMP(3), tz TIMESTAMP WITH TIME ZONE,
    dflt NUMBER DEFAULT 7 NOT NULL, label VARCHAR2(10) DEFAULT 'new' NOT NULL, made DATE DEFAULT SYSDATE
);
CREATE TABLE keyless (a NUMBER(3), b VARCHAR2(10))`;
const ROWS = `
    INSERT INTO extra_types (id, small, money, huge, plain, f, bf, bd, v, c, cl, bl, r, d, ts, tz, made) VALUES
      (1, -7, 1234567890.12, 1234567890123456789012345, 0.5, 3.14159, 1.5, 2.718281828459045, 'héllo wörld ünï', 'ab', 'short clob', HEXTORAW('00FF10'), HEXTORAW('DEADBEEF'),
       TO_DATE('2026-03-31 16:45:09', 'YYYY-MM-DD HH24:MI:SS'), TIMESTAMP '2026-03-31 16:45:00.120', TIMESTAMP '2026-03-31 16:45:00.5 +05:30', DATE '2026-01-01');
    INSERT INTO extra_types (id) VALUES (2);
    INSERT INTO extra_types (id, small, plain, v, tz, d) VALUES (3, 999, -0.000001, 'O''Brien "quoted"', TIMESTAMP '2026-06-01 00:00:00 +00:00', DATE '2026-02-02');
    INSERT INTO extra_types (id, plain, d, tz) VALUES (4, 100, DATE '0001-01-01', TIMESTAMP '2026-12-31 23:59:59.999 -08:00');
    INSERT INTO extra_types (id, cl, bl) VALUES (5, TO_CLOB(RPAD('x', 3000, 'x')) || TO_CLOB(RPAD('y', 3000, 'y')), TO_BLOB(UTL_RAW.CAST_TO_RAW(RPAD('b', 100, 'b'))));
    INSERT INTO keyless VALUES (1, 'one');
    INSERT INTO keyless VALUES (2, NULL);
`;

describe.skipIf(!server)("reading the data for the report (real Oracle)", () => {
    const admin = server?.admin as NonNullable<typeof server>["admin"];
    const schemas: string[] = [];
    const databases: string[] = [];
    afterAll(async () => {
        for (const schema of schemas) await dropOracleSchema(admin, schema).catch(() => undefined);
        if (pgUrl) for (const database of databases) await withPgClient(adminConfigFromUrl(pgUrl), (client) => client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)).catch(() => undefined);
    });

    async function fresh() {
        const schema = oracleSchemaName("0a1b2c3d-0000-0000-0000-0000000000c3", `rep_${Math.random().toString(36).slice(2, 6)}`);
        schemas.push(schema);
        const password = newSchemaPassword();
        await createOracleSchema(admin, schema, password, DDL);
        const row = oracleConnectionRow(admin, schema, "rep", password);
        const ran = await oracleSql.run(row, "rep-0001", ROWS);
        expect(ran.ok, JSON.stringify(!ran.ok && ran.error)).toBe(true);
        const config = { ...admin, user: schema, password };
        const plan = await withOracle(config, (c) => planOracleMigration(c));
        return { config, plan };
    }

    it("counts the NULLs of every column, and the values the copy changes", async () => {
        const { config, plan } = await fresh();
        const facts = await withOracle(config, (c) => readDataFacts(c, plan));
        const f = (column: string) => facts[`EXTRA_TYPES.${column}`];
        // five rows: ids 1 to 5
        expect(f("ID")).toMatchObject({ nulls: 0, values: 5 });
        expect(f("V")).toMatchObject({ nulls: 3, values: 2 });
        expect(f("TZ")).toMatchObject({ nulls: 2, values: 3 });
        expect(f("CL")).toMatchObject({ nulls: 3, values: 2 });
        expect(Object.keys(facts).filter((key) => key.startsWith("EXTRA_TYPES.")).length).toBe(19);

        const affected = (column: string) => f(column).affected.map((entry) => [entry.label, entry.count]);
        // the time zone: two of the three values were written in an offset other than UTC, and the copy keeps only the instant
        expect(affected("TZ")).toEqual([["values written in an offset other than UTC, which is not kept", 2]]);
        // dates: row 1 has a time of day; the other DATE values are at midnight
        expect(affected("D")).toEqual([["values with a time of day, which is kept", 1]]);
        expect(affected("TS")).toEqual([["values with a time of day, which is kept", 1]]);
        // numbers between -1 and 1: 0.5 and -0.000001 (and BINARY_FLOAT or BINARY_DOUBLE do not count: both are 1.5 and 2.7)
        expect(affected("PLAIN")).toEqual([["values between -1 and 1, whose leading 0 the copy adds", 2]]);
        expect(f("V").affected).toEqual([]);
        // every count carries the query that made it
        expect(f("TZ").affected[0].sql).toBe('SELECT COUNT(*) FROM "EXTRA_TYPES" WHERE EXTRACT(TIMEZONE_HOUR FROM "TZ") <> 0 OR EXTRACT(TIMEZONE_MINUTE FROM "TZ") <> 0');
        expect(await withOracle(config, async (c) => Number(((await c.execute(f("TZ").affected[0].sql)).rows as unknown[][])[0][0]))).toBe(2);
    });

    it("counts the time of day a date would drop, once the person chose a date", async () => {
        const { config } = await fresh();
        const plan = await withOracle(config, (c) => planOracleMigration(c, { columns: { "EXTRA_TYPES.D": { pgType: "date" } } }));
        const facts = await withOracle(config, (c) => readDataFacts(c, plan));
        expect(facts["EXTRA_TYPES.D"].affected).toEqual([{ label: "values with a time of day, which the date drops", count: 1, sql: 'SELECT COUNT(*) FROM "EXTRA_TYPES" WHERE "D" <> TRUNC("D")' }]);
    });

    it("shows a value as Oracle writes it beside the value PostgreSQL will receive", async () => {
        const { config, plan } = await fresh();
        const samples = await withOracle(config, (c) => readSamples(c, plan));
        const sample = samples.EXTRA_TYPES;
        expect(sample.ordered).toBe(true);
        expect(sample.oracle).toHaveLength(5);
        const at = (name: string) => sample.columns.indexOf(name);
        const first = (view: "oracle" | "postgres", name: string) => sample[view][0][at(name)];

        // a number: Oracle prints .5, the copy sends 0.5
        expect([first("oracle", "plain"), first("postgres", "plain")]).toEqual([".5", "0.5"]);
        expect([sample.oracle[2][at("plain")], sample.postgres[2][at("plain")]]).toEqual(["-.000001", "-0.000001"]);
        // a DATE keeps its time of day
        expect([first("oracle", "d"), first("postgres", "d")]).toEqual(["2026-03-31 16:45:09", "2026-03-31 16:45:09"]);
        // a time zone: Oracle shows the offset it was written with, the copy sends the same instant in UTC
        expect([first("oracle", "tz"), first("postgres", "tz")]).toEqual(["2026-03-31 16:45:00.500000 +05:30", "2026-03-31 11:15:00.500000+00"]);
        expect([sample.oracle[3][at("tz")], sample.postgres[3][at("tz")]]).toEqual(["2026-12-31 23:59:59.999000 -08:00", "2027-01-01 07:59:59.999000+00"]);
        // bytes and text
        expect([first("oracle", "r"), first("postgres", "r")]).toEqual(["DEADBEEF", "\\xdeadbeef"]);
        expect(first("postgres", "v")).toBe("héllo wörld ünï");
        // NULL stays NULL on both sides
        expect([sample.oracle[1][at("tz")], sample.postgres[1][at("tz")]]).toEqual([null, null]);
        // a long CLOB and a long BLOB are shown short on both sides, and say so
        expect(sample.oracle[4][at("cl")]?.length).toBe(200);
        expect(sample.postgres[4][at("cl")]).toBe("x".repeat(200) + "…");
        expect(sample.postgres[4][at("bl")]).toMatch(/^\\x(62){32}…$/);
        // both views come from one query, so they are the same rows
        expect(sample.sql).toContain('FROM "EXTRA_TYPES" ORDER BY "ID" FETCH FIRST 5 ROWS ONLY');
    });

    it("says so for a table with no key, whose rows are simply the first the database returned", async () => {
        const { config, plan } = await fresh();
        const samples = await withOracle(config, (c) => readSamples(c, plan));
        expect(samples.KEYLESS.ordered).toBe(false);
        expect(samples.KEYLESS.sql).not.toContain("ORDER BY");
        expect(samples.KEYLESS.oracle.map((row) => row[0]).sort()).toEqual(["1", "2"]);
        expect(samples.KEYLESS.oracle.every((row, index) => row[0] === samples.KEYLESS.postgres[index][0])).toBe(true);
    });

    it("shows an Oracle value the way Oracle writes it, whatever the target type", () => {
        expect(oracleDisplayExpression({ oracleName: "D", oracleType: "DATE", pgType: "date" })).toBe(`TO_CHAR("D", 'YYYY-MM-DD HH24:MI:SS')`);
        expect(oracleDisplayExpression({ oracleName: "T", oracleType: "TIMESTAMP(6) WITH TIME ZONE", pgType: "timestamptz(6)" })).toContain("TZH:TZM");
        expect(oracleDisplayExpression({ oracleName: "N", oracleType: "NUMBER", pgType: "numeric" })).toBe('TO_CHAR("N")');
    });

    it.skipIf(!pgUrl)("builds the whole report from a real Oracle, and every sample row is what the copy later writes", async () => {
        const { config, plan } = await fresh();
        const { facts, samples } = await withOracle(config, async (c) => ({ facts: await readDataFacts(c, plan), samples: await readSamples(c, plan) }));
        const report = buildReport(plan, { source: "rep", facts, samples });
        expect(report.dataRead).toBe(true);
        expect(report.tables.map((t) => t.sample !== undefined)).toEqual([true, true]);

        const pgAdmin = adminConfigFromUrl(pgUrl!);
        const database = `rep_test_${Math.random().toString(36).slice(2, 8)}`;
        databases.push(database);
        await createDatabaseFromSql(pgAdmin, database, plan.createSql.join(";\n"));
        await withOracle(config, (oracle) => withPgClient({ ...pgAdmin, database }, (pg) => loadAndVerify(oracle, pg, plan)));

        const sameNumber = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Math.abs(Number(a) - Number(b)) <= 1e-9 * Math.max(1, Math.abs(Number(a)), Math.abs(Number(b))));
        // what the stored value looks like, on the same footing as what was received: an instant in UTC, bytes in hex, long text cut where the sample cuts it
        const stored = (column: PlannedColumn): string => {
            const name = `"${column.pgName}"`;
            const family = oracleFamily({ type: column.oracleType });
            if (family === "timestamptz") return `to_char(${name} at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`;
            if (family === "binary") return `'\\x' || encode(substring(${name} from 1 for 32), 'hex') || CASE WHEN length(${name}) > 32 THEN '…' ELSE '' END`;
            if (family === "clob" || family === "string") return `CASE WHEN length(${name}) > 200 THEN substring(${name} from 1 for 200) || '…' ELSE ${name}::text END`;
            return `${name}::text`;
        };

        let compared = 0;
        await withPgClient({ ...pgAdmin, database }, async (pg) => {
            for (const table of plan.tables.filter((t) => t.oraclePrimaryKey.length > 0)) {
                const sample = samples[table.oracleName];
                const keyAt = sample.columns.indexOf(table.pgPrimaryKey[0]);
                for (const received of sample.postgres) {
                    const key = received[keyAt]!;
                    const row = (await pg.query({ text: `SELECT ${table.columns.map((c, i) => `${stored(c)} AS c${i}`).join(", ")} FROM "${table.pgName}" WHERE "${table.pgPrimaryKey[0]}" = $1`, values: [key], rowMode: "array" })).rows[0] as (string | null)[];
                    expect(row, `${table.pgName} ${key}`).toBeDefined();
                    table.columns.forEach((column, index) => {
                        const want = received[index];
                        const have = row[index];
                        const family = oracleFamily({ type: column.oracleType });
                        const where = `${table.pgName}.${column.pgName} of row ${key}`;
                        if (family === "number" || family === "float") expect(sameNumber(want, have), `${where}: sent ${want}, stored ${have}`).toBe(true);
                        else if (column.kind === "date" || family === "timestamptz") expect(sameDateText(want?.replace(/\+00$/, "") ?? null, have?.replace(/\+00$/, "") ?? null), `${where}: sent ${want}, stored ${have}`).toBe(true);
                        // a CHAR is blank-padded when it is sent, and PostgreSQL prints a char(n) without the trailing blanks
                        else if (/^N?CHAR/i.test(column.oracleType)) expect(have, where).toBe(want?.trimEnd() ?? null);
                        else expect(have, where).toBe(want);
                        compared++;
                    });
                }
            }
        });
        // five rows of extra_types with 19 columns each: every cell of every keyed sample row was compared
        expect(compared).toBe(5 * 19);
    }, 240_000);
});
