import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { oracleConfigOf, withOracle } from "./oracle-client.js";
import { isOracleReadQuery, previewOracleQuery, type OracleReader } from "./oracle-preview.js";
import { createOracleSchema, dropOracleSchema, newSchemaPassword, oracleConnectionRow, oracleSchemaName, oracleServerFromEnv } from "./oracle-schemas.js";
import { oracleSql } from "./oracle-sql.js";

/** Against a real Oracle: set ORACLE_TEST_ADMIN_URL (see oracle.integration.test.ts). Without it these tests are skipped. */
process.env.MASTER_KEY ??= randomBytes(32).toString("base64");
const url = process.env.ORACLE_TEST_ADMIN_URL;
const server = url ? oracleServerFromEnv({ ORACLE_ADMIN_URL: url } as NodeJS.ProcessEnv) : undefined;
const INSURANCE = readFileSync(resolve(import.meta.dirname, "../../../queryshift/domain/legacy_schema.sql"), "utf8");

describe.skipIf(!server)("the Oracle preview (real Oracle)", () => {
    const admin = server?.admin as NonNullable<typeof server>["admin"];
    const made: string[] = [];
    afterAll(async () => {
        for (const schema of made) await dropOracleSchema(admin, schema).catch(() => undefined);
    });

    async function schemaWithCustomers() {
        const schema = oracleSchemaName("0a1b2c3d-0000-0000-0000-000000000001", `prev_${Math.random().toString(36).slice(2, 6)}`);
        made.push(schema);
        const password = newSchemaPassword();
        await createOracleSchema(admin, schema, password, INSURANCE);
        const row = oracleConnectionRow(admin, schema, "preview", password);
        const loaded = await oracleSql.run(row, "sess-prev", "INSERT INTO cust_mst VALUES (1, 'Asha', NULL, 'RET', TIMESTAMP '2019-04-12 00:00:00');\nINSERT INTO cust_mst VALUES (2, 'Brightline', 'b@example.com', 'COM', DATE '2020-11-03');");
        expect(loaded.ok).toBe(true);
        const run = <T>(fn: (connection: OracleReader) => Promise<T>) => withOracle(oracleConfigOf(row), (connection) => fn(connection as unknown as OracleReader), { callTimeoutMs: 15_000 });
        return { run, count: () => withOracle(oracleConfigOf(row), async (c) => ((await c.execute("SELECT count(*) FROM cust_mst")).rows as number[][])[0][0]) };
    }

    it("returns what the query returns, as text: NULL as null, a date with its time, a number with its leading zero", async () => {
        const { run } = await schemaWithCustomers();
        const outcome = await previewOracleQuery("SELECT cust_id, cust_email, join_dt, cust_id / 4 AS quarter FROM cust_mst ORDER BY cust_id;", run);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.result.columns.map((c) => c.name)).toEqual(["CUST_ID", "CUST_EMAIL", "JOIN_DT", "QUARTER"]);
        expect(outcome.result.rows).toEqual([
            ["1", null, "2019-04-12 00:00:00", "0.25"],
            ["2", "b@example.com", "2020-11-03 00:00:00", "0.5"],
        ]);
    });

    it("cannot change anything: Oracle refuses a write in the read-only transaction, and the rows are still there", async () => {
        const { run, count } = await schemaWithCustomers();
        // the route's guard would stop these before they got here; this is the second layer, with the guard out of the way
        for (const statement of ["DELETE FROM cust_mst", "UPDATE cust_mst SET cust_nm = 'x'", "INSERT INTO cust_mst VALUES (3, 'Eli', NULL, 'RET', DATE '2024-02-29')"]) {
            const outcome = await previewOracleQuery(statement, run);
            expect(outcome, statement).toMatchObject({ ok: false, error: { code: "ORA-01456" } });
        }
        expect(await count()).toBe(2);
    });

    it("reports an error in the query with its ORA- code", async () => {
        const { run } = await schemaWithCustomers();
        const outcome = await previewOracleQuery("SELECT * FROM no_such_table", run);
        expect(outcome).toMatchObject({ ok: false, error: { code: "ORA-00942" } });
    });

    it("the guard turns away everything but one SELECT", () => {
        expect(isOracleReadQuery("SELECT * FROM cust_mst")).toBe(true);
        expect(isOracleReadQuery("DELETE FROM cust_mst")).toBe(false);
    });
});
