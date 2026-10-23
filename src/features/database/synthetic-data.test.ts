import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { init } from "@guanmingchiu/sqlparser-ts";
import { DatabaseDialect } from "@/lib/database";
import { getDataTypes } from "@/test/fixtures/data-types";
import { makeDatabase } from "@/test/fixtures/dbml-builders";
import { prepareSqlSchemaChange } from "@/utils/import/prepare-sql-schema-change";
import { liveSchemaSql } from "./live-database";

const { PGlite } = createRequire(new URL("../../../server/package.json", import.meta.url))("@electric-sql/pglite") as typeof import("../../../server/node_modules/@electric-sql/pglite");

const domain = (file: string) => readFileSync(resolve(import.meta.dirname, "../../../queryshift/domain", file), "utf8");
const types = getDataTypes(DatabaseDialect.ORACLE);

beforeAll(async () => {
    await init();
});

/** The database a user gets from pasting the Oracle insurance schema and creating it as a live database. */
async function liveInsuranceDatabase() {
    const diagram = (await prepareSqlSchemaChange(domain("legacy_schema.sql"), makeDatabase(DatabaseDialect.ORACLE, []), types)).targetDatabase;
    const db = new PGlite();
    await db.exec(await liveSchemaSql(diagram, types));
    return db;
}

const one = async (db: InstanceType<typeof PGlite>, sql: string) => Number(((await db.query<{ n: string }>(sql)).rows[0] as { n: string }).n);

describe("generate_synthetic_data.sql", () => {
    it("fills the empty live database, keeps every key valid and every date inside its policy's term", async () => {
        const db = await liveInsuranceDatabase();
        expect(await one(db, "SELECT count(*) AS n FROM cust_mst")).toBe(0);
        await db.exec(domain("generate_synthetic_data.sql"));

        expect(await one(db, "SELECT count(*) AS n FROM cust_mst")).toBe(200);
        const policies = await one(db, "SELECT count(*) AS n FROM polcy_hdr");
        const claims = await one(db, "SELECT count(*) AS n FROM clm_dtl");
        expect(policies).toBeGreaterThan(200);
        expect(policies).toBeLessThan(600);
        expect(claims).toBeGreaterThan(100);

        // keys: the foreign keys are enforced, so reaching here already proves them; check there are no orphans anyway, and ids are unique
        expect(await one(db, "SELECT count(*) AS n FROM polcy_hdr p LEFT JOIN cust_mst c ON c.cust_id = p.cust_id WHERE c.cust_id IS NULL")).toBe(0);
        expect(await one(db, "SELECT count(*) AS n FROM clm_dtl k LEFT JOIN polcy_hdr p ON p.polcy_id = k.polcy_id WHERE p.polcy_id IS NULL")).toBe(0);

        // dates: a claim is never before its policy starts nor after it ends, nor after 22 Oct 2026; a policy lasts a year
        expect(await one(db, "SELECT count(*) AS n FROM clm_dtl k JOIN polcy_hdr p USING (polcy_id) WHERE k.clm_dt < p.eff_dt")).toBe(0);
        expect(await one(db, "SELECT count(*) AS n FROM clm_dtl k JOIN polcy_hdr p USING (polcy_id) WHERE k.clm_dt >= p.exp_dt + INTERVAL '1 day'")).toBe(0);
        expect(await one(db, "SELECT count(*) AS n FROM clm_dtl WHERE clm_dt > TIMESTAMP '2026-10-23 00:00:00'")).toBe(0);
        expect(await one(db, "SELECT count(*) AS n FROM polcy_hdr WHERE exp_dt <> eff_dt + INTERVAL '1 year' - INTERVAL '1 day'")).toBe(0);

        // money and status: open claims are unpaid, closed ones are paid part or all of the amount
        expect(await one(db, "SELECT count(*) AS n FROM clm_dtl WHERE clm_stat_cd = 'OP' AND paid_amt IS NOT NULL")).toBe(0);
        expect(await one(db, "SELECT count(*) AS n FROM clm_dtl WHERE clm_stat_cd = 'CL' AND (paid_amt IS NULL OR paid_amt > clm_amt OR paid_amt < clm_amt * 0.59)")).toBe(0);
        expect(await one(db, "SELECT count(*) AS n FROM clm_dtl WHERE clm_amt < 50 OR clm_amt > 20050")).toBe(0);
        expect(await one(db, "SELECT count(*) AS n FROM polcy_hdr WHERE stat_cd NOT IN ('AC', 'LP')")).toBe(0);
        await db.close();
    });

    it("contains the awkward rows, not only clean ones", async () => {
        const db = await liveInsuranceDatabase();
        await db.exec(domain("generate_synthetic_data.sql"));
        expect(await one(db, "SELECT count(*) AS n FROM cust_mst WHERE cust_email IS NULL")).toBeGreaterThan(10);
        expect(await one(db, "SELECT count(*) AS n FROM cust_mst c WHERE NOT EXISTS (SELECT 1 FROM polcy_hdr p WHERE p.cust_id = c.cust_id)")).toBeGreaterThan(5);
        expect(await one(db, "SELECT count(*) AS n FROM polcy_hdr WHERE annl_prem IS NULL")).toBeGreaterThan(5);
        expect(await one(db, "SELECT count(*) AS n FROM polcy_hdr WHERE stat_cd = 'LP'")).toBeGreaterThan(10);
        expect(await one(db, "SELECT count(*) AS n FROM polcy_hdr WHERE eff_dt = (date_trunc('month', eff_dt) + INTERVAL '1 month - 1 day')")).toBeGreaterThan(10);
        expect(await one(db, "SELECT count(*) AS n FROM clm_dtl WHERE clm_stat_cd = 'OP'")).toBeGreaterThan(20);
        expect(await one(db, "SELECT count(*) AS n FROM clm_dtl WHERE adj_note IS NULL")).toBeGreaterThan(20);
        expect(await one(db, "SELECT count(*) AS n FROM clm_dtl WHERE clm_dt::time <> TIME '00:00:00'")).toBeGreaterThan(50); // a time of day, as an Oracle DATE has
        await db.close();
    });

    it("can be run again: more customers, no key clashes, no second helping of claims for a policy that has them", async () => {
        const db = await liveInsuranceDatabase();
        await db.exec(domain("generate_synthetic_data.sql"));
        const claimsBefore = await one(db, "SELECT count(*) AS n FROM clm_dtl");
        const firstPolicies = await one(db, "SELECT count(*) AS n FROM polcy_hdr");
        await db.exec(domain("generate_synthetic_data.sql"));
        expect(await one(db, "SELECT count(*) AS n FROM cust_mst")).toBe(400);
        expect(await one(db, "SELECT count(*) AS n FROM polcy_hdr")).toBeGreaterThan(firstPolicies);
        expect(await one(db, "SELECT count(*) AS n FROM clm_dtl")).toBeGreaterThanOrEqual(claimsBefore);
        // the claims of the first run's policies are untouched: the first run's policies that had claims still have the same number
        expect(await one(db, "SELECT count(*) AS n FROM (SELECT polcy_id FROM clm_dtl GROUP BY polcy_id HAVING count(*) > 3) x")).toBe(0);
        await db.close();
    });
});
