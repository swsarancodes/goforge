import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { withOracle } from "./oracle-client.js";
import { createOracleSchema, dropOracleSchema, newSchemaPassword, oracleConnectionRow, oracleSchemaName, oracleServerFromEnv } from "./oracle-schemas.js";
import { oracleSql } from "./oracle-sql.js";

/** Against a real Oracle (ORACLE_TEST_ADMIN_URL): the synthetic data script for the Oracle insurance schema. Skipped without it. */
process.env.MASTER_KEY ??= randomBytes(32).toString("base64");
const url = process.env.ORACLE_TEST_ADMIN_URL;
const server = url ? oracleServerFromEnv({ ORACLE_ADMIN_URL: url } as NodeJS.ProcessEnv) : undefined;
const domain = (file: string) => readFileSync(resolve(import.meta.dirname, "../../../queryshift/domain", file), "utf8");

describe.skipIf(!server)("generate_synthetic_data_oracle.sql (real Oracle)", () => {
    const admin = server?.admin as NonNullable<typeof server>["admin"];
    const made: string[] = [];
    afterAll(async () => {
        for (const schema of made) await dropOracleSchema(admin, schema).catch(() => undefined);
    });

    const fresh = async () => {
        const schema = oracleSchemaName("0a1b2c3d-0000-0000-0000-000000000000", `syn_${Math.random().toString(36).slice(2, 6)}`);
        made.push(schema);
        const password = newSchemaPassword();
        await createOracleSchema(admin, schema, password, domain("legacy_schema.sql"));
        return { schema, password, row: oracleConnectionRow(admin, schema, "syn", password) };
    };
    const one = (schema: string, password: string, sql: string) => withOracle({ ...admin, user: schema, password }, async (c) => Number(((await c.execute(sql)).rows as unknown[][])[0][0]));

    it("fills the empty schema, keeps every key valid and every date inside its policy's term, and prints a summary", async () => {
        const { schema, password, row } = await fresh();
        const outcome = await oracleSql.run(row, "syn-0001", domain("generate_synthetic_data_oracle.sql"));
        expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.error)).toBe(true);
        expect(outcome.results.map((r) => r.command)).toEqual(["DECLARE", "SELECT"]);
        expect(outcome.results[1].columns.map((c) => c.name)).toEqual(["CUSTOMERS", "CUSTOMERS_WITHOUT_EMAIL", "CUSTOMERS_WITHOUT_POLICY", "POLICIES", "LAPSED_POLICIES", "CLAIMS", "OPEN_CLAIMS"]);

        const q = (sql: string) => one(schema, password, sql);
        expect(await q("SELECT COUNT(*) FROM cust_mst")).toBe(200);
        const policies = await q("SELECT COUNT(*) FROM polcy_hdr");
        expect(policies).toBeGreaterThan(200);
        expect(policies).toBeLessThan(600);
        expect(await q("SELECT COUNT(*) FROM clm_dtl")).toBeGreaterThan(100);
        // dates: a claim is never before its policy starts nor after it ends, nor after 22 Oct 2026; a policy lasts a year
        expect(await q("SELECT COUNT(*) FROM clm_dtl k JOIN polcy_hdr p ON p.polcy_id = k.polcy_id WHERE k.clm_dt < p.eff_dt")).toBe(0);
        expect(await q("SELECT COUNT(*) FROM clm_dtl k JOIN polcy_hdr p ON p.polcy_id = k.polcy_id WHERE k.clm_dt >= p.exp_dt + 1")).toBe(0);
        expect(await q("SELECT COUNT(*) FROM clm_dtl WHERE clm_dt >= DATE '2026-10-23'")).toBe(0);
        expect(await q("SELECT COUNT(*) FROM polcy_hdr WHERE exp_dt <> ADD_MONTHS(eff_dt, 12) - 1")).toBe(0);
        // money and status
        expect(await q("SELECT COUNT(*) FROM clm_dtl WHERE clm_stat_cd = 'OP' AND paid_amt IS NOT NULL")).toBe(0);
        expect(await q("SELECT COUNT(*) FROM clm_dtl WHERE clm_stat_cd = 'CL' AND (paid_amt IS NULL OR paid_amt > clm_amt OR paid_amt < clm_amt * 0.59)")).toBe(0);
        expect(await q("SELECT COUNT(*) FROM clm_dtl WHERE clm_amt < 50 OR clm_amt > 20050")).toBe(0);
        // the awkward rows
        expect(await q("SELECT COUNT(*) FROM cust_mst WHERE cust_email IS NULL")).toBeGreaterThan(10);
        expect(await q("SELECT COUNT(*) FROM cust_mst c WHERE NOT EXISTS (SELECT 1 FROM polcy_hdr p WHERE p.cust_id = c.cust_id)")).toBeGreaterThan(5);
        expect(await q("SELECT COUNT(*) FROM polcy_hdr WHERE annl_prem IS NULL")).toBeGreaterThan(5);
        expect(await q("SELECT COUNT(*) FROM polcy_hdr WHERE eff_dt = LAST_DAY(eff_dt)")).toBeGreaterThan(10);
        expect(await q("SELECT COUNT(*) FROM clm_dtl WHERE clm_dt <> TRUNC(clm_dt)")).toBeGreaterThan(50); // a time of day
        expect(await q("SELECT COUNT(*) FROM clm_dtl WHERE adj_note IS NULL")).toBeGreaterThan(20);
    }, 120_000);

    it("gives the same data every time it runs on an empty schema", async () => {
        const first = await fresh();
        const second = await fresh();
        await oracleSql.run(first.row, "syn-0002", domain("generate_synthetic_data_oracle.sql"));
        await oracleSql.run(second.row, "syn-0003", domain("generate_synthetic_data_oracle.sql"));
        const digest = (s: { schema: string; password: string }) => one(s.schema, s.password, "SELECT ORA_HASH(LISTAGG(cust_id || cust_nm || NVL(cust_email, '-'), ',') WITHIN GROUP (ORDER BY cust_id)) FROM (SELECT * FROM cust_mst WHERE cust_id <= 50)");
        expect(await digest(first)).toBe(await digest(second));
    }, 120_000);

    it("can be run again: more customers, no key clashes, and no second helping of claims for a policy that has them", async () => {
        const { schema, password, row } = await fresh();
        await oracleSql.run(row, "syn-0004", domain("generate_synthetic_data_oracle.sql"));
        const claims = await one(schema, password, "SELECT COUNT(*) FROM clm_dtl");
        const again = await oracleSql.run(row, "syn-0004", domain("generate_synthetic_data_oracle.sql"));
        expect(again.ok).toBe(true);
        expect(await one(schema, password, "SELECT COUNT(*) FROM cust_mst")).toBe(400);
        expect(await one(schema, password, "SELECT COUNT(*) FROM clm_dtl")).toBeGreaterThanOrEqual(claims);
        expect(await one(schema, password, "SELECT COUNT(*) FROM (SELECT polcy_id FROM clm_dtl GROUP BY polcy_id HAVING COUNT(*) > 3)")).toBe(0);
    }, 120_000);
});
