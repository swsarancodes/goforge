import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { adminConfigFromUrl } from "./cloud-databases.js";
import { withOracle } from "./oracle-client.js";
import { fetchOracleRows, loadOracleRelations } from "./oracle-data.js";
import { loadAndVerify, planOracleMigration } from "./oracle-migration.js";
import { createOracleSchema, dropOracleSchema, newSchemaPassword, oracleConnectionRow, oracleSchemaName, oracleServerFromEnv } from "./oracle-schemas.js";
import { oracleSql } from "./oracle-sql.js";
import { createDatabaseFromSql } from "./pg-create-database.js";
import { withPgClient } from "./pg-client.js";

/**
 * The 10-table legacy insurer in examples/oracle-insurance-10, on a real Oracle: the schema builds, the generator fills every table, it can be
 * run again, it is repeatable, the rows it makes hang together, and the result migrates to PostgreSQL and is proved equal.
 * ORACLE_TEST_ADMIN_URL=oracle://system:pw@127.0.0.1:1521/FREEPDB1 (and PG_TEST_ADMIN_URL for the migration). Skipped without it.
 */
process.env.MASTER_KEY ??= randomBytes(32).toString("base64");
const oracleUrl = process.env.ORACLE_TEST_ADMIN_URL;
const pgUrl = process.env.PG_TEST_ADMIN_URL;
const server = oracleUrl ? oracleServerFromEnv({ ORACLE_ADMIN_URL: oracleUrl } as NodeJS.ProcessEnv) : undefined;
const example = (file: string) => readFileSync(resolve(import.meta.dirname, "../../../examples/oracle-insurance-10", file), "utf8");

const TABLES = ["AGNT_MST", "PROD_MST", "ADJSTR_MST", "CUST_MST", "CUST_ADDR", "POLCY_HDR", "POLCY_COVG", "PREM_PMT", "CLM_DTL", "CLM_PYMT"];

describe.skipIf(!server)("the 10-table legacy insurer (real Oracle)", () => {
    const admin = server?.admin as NonNullable<typeof server>["admin"];
    const schemas: string[] = [];
    const databases: string[] = [];
    afterAll(async () => {
        for (const schema of schemas) await dropOracleSchema(admin, schema).catch(() => undefined);
        if (pgUrl) for (const database of databases) await withPgClient(adminConfigFromUrl(pgUrl), (client) => client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)).catch(() => undefined);
    });

    async function fresh() {
        const schema = oracleSchemaName("0a1b2c3d-0000-0000-0000-0000000000a1", `ins10_${Math.random().toString(36).slice(2, 6)}`);
        schemas.push(schema);
        const password = newSchemaPassword();
        const built = await createOracleSchema(admin, schema, password, example("schema_oracle.sql"));
        const row = oracleConnectionRow(admin, schema, "ins10", password);
        const run = (script: string) => oracleSql.run(row, `ins10-${Math.random().toString(36).slice(2, 8)}`, script);
        const config = { ...admin, user: schema, password };
        const one = async <T>(sql: string): Promise<T> => withOracle(config, async (c) => ((await c.execute(sql)).rows as unknown[][])[0][0] as T);
        // one connection at a time: an Oracle schema made here may only have a few sessions open
        const counts = async () => {
            const result: Record<string, number> = {};
            for (const table of TABLES) result[table] = Number(await one<number>(`SELECT COUNT(*) FROM ${table}`));
            return result;
        };
        return { schema, config, built, run, one, counts };
    }

    it("builds the ten tables, the keys, the indexes and the rules", async () => {
        const { built, one } = await fresh();
        expect(built.statementsRun).toBe(16);
        expect(await one<number>("SELECT COUNT(*) FROM user_tables")).toBe(10);
        expect(await one<number>("SELECT COUNT(*) FROM user_constraints WHERE constraint_type = 'R'")).toBe(10);
        expect(await one<number>("SELECT COUNT(*) FROM user_constraints WHERE constraint_type = 'C' AND constraint_name IN ('CK_POLCY_DATES', 'CK_CLM_AMT')")).toBe(2);
        expect(await one<number>("SELECT COUNT(*) FROM user_indexes WHERE index_name LIKE 'IX\\_%' ESCAPE '\\'")).toBe(4);
    });

    it("fills every table with rows that hang together, and the awkward values a migration has to carry", async () => {
        const { run, one, counts } = await fresh();
        const outcome = await run(example("generate_data_oracle.sql"));
        expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.error)).toBe(true);
        const c = await counts();
        expect(c).toMatchObject({ AGNT_MST: 12, PROD_MST: 8, ADJSTR_MST: 10, CUST_MST: 200 });
        for (const table of TABLES) expect(c[table], table).toBeGreaterThan(0);
        expect(c.POLCY_HDR).toBeGreaterThan(200);
        expect(c.POLCY_COVG).toBeGreaterThan(c.POLCY_HDR * 2 - 1);
        expect(c.CLM_PYMT).toBeGreaterThan(0);

        // a closed claim is paid in full by its payments, and every policy has coverages
        expect(await one<number>("SELECT COUNT(*) FROM clm_dtl d WHERE clm_stat_cd = 'CL' AND paid_amt > 0 AND paid_amt <> (SELECT NVL(SUM(pymt_amt), 0) FROM clm_pymt y WHERE y.clm_id = d.clm_id)")).toBe(0);
        expect(await one<number>("SELECT COUNT(*) FROM polcy_hdr h WHERE NOT EXISTS (SELECT 1 FROM polcy_covg v WHERE v.polcy_id = h.polcy_id)")).toBe(0);
        expect(await one<number>("SELECT COUNT(*) FROM clm_dtl WHERE clm_stat_cd <> 'CL' AND paid_amt IS NOT NULL")).toBe(0);
        // each policy's type is its product's, and claims fall in the policy's term and not after 22 Oct 2026
        expect(await one<number>("SELECT COUNT(*) FROM polcy_hdr h JOIN prod_mst p ON p.prod_id = h.prod_id WHERE p.polcy_typ_cd <> h.polcy_typ_cd")).toBe(0);
        expect(await one<number>("SELECT COUNT(*) FROM clm_dtl k JOIN polcy_hdr h ON h.polcy_id = k.polcy_id WHERE k.clm_dt < h.eff_dt OR k.clm_dt >= h.exp_dt + 1 OR k.clm_dt >= DATE '2026-10-23'")).toBe(0);

        // the awkward rows
        const awkward: [string, string][] = [
            ["customers without an email", "SELECT COUNT(*) FROM cust_mst WHERE cust_email IS NULL"],
            ["customers without a policy", "SELECT COUNT(*) FROM cust_mst c WHERE NOT EXISTS (SELECT 1 FROM polcy_hdr p WHERE p.cust_id = c.cust_id)"],
            ["policies without a premium", "SELECT COUNT(*) FROM polcy_hdr WHERE annl_prem IS NULL"],
            ["policies sold direct", "SELECT COUNT(*) FROM polcy_hdr WHERE agnt_id IS NULL"],
            ["policies starting on a month end", "SELECT COUNT(*) FROM polcy_hdr WHERE eff_dt = LAST_DAY(eff_dt)"],
            ["lapsed policies", "SELECT COUNT(*) FROM polcy_hdr WHERE stat_cd = 'LP'"],
            ["open claims", "SELECT COUNT(*) FROM clm_dtl WHERE clm_stat_cd = 'OP'"],
            ["denied claims", "SELECT COUNT(*) FROM clm_dtl WHERE clm_stat_cd = 'DN'"],
            ["claims with a time of day", "SELECT COUNT(*) FROM clm_dtl WHERE clm_dt <> TRUNC(clm_dt)"],
            ["claims without a note", "SELECT COUNT(*) FROM clm_dtl WHERE adj_note IS NULL"],
            ["claims with no adjuster", "SELECT COUNT(*) FROM clm_dtl WHERE adjstr_id IS NULL"],
            ["zip codes starting with 0", "SELECT COUNT(*) FROM cust_addr WHERE pstl_cd LIKE '0%'"],
            ["zip codes missing", "SELECT COUNT(*) FROM cust_addr WHERE pstl_cd IS NULL"],
            ["names with an apostrophe", "SELECT COUNT(*) FROM cust_mst WHERE cust_nm LIKE '%''%'"],
            ["names with an accent", "SELECT COUNT(*) FROM cust_mst WHERE cust_nm LIKE '%ü%'"],
            ["long product descriptions", "SELECT COUNT(*) FROM prod_mst WHERE DBMS_LOB.GETLENGTH(prod_desc) > 4000"],
            ["products without a description", "SELECT COUNT(*) FROM prod_mst WHERE prod_desc IS NULL"],
            ["payments with milliseconds", "SELECT COUNT(*) FROM prem_pmt WHERE EXTRACT(SECOND FROM pmt_ts) <> TRUNC(EXTRACT(SECOND FROM pmt_ts))"],
            ["failed payments", "SELECT COUNT(*) FROM prem_pmt WHERE pmt_stat_cd = 'FL'"],
            ["partial claim payments", "SELECT COUNT(*) FROM clm_pymt WHERE pymt_typ_cd = 'PRT'"],
        ];
        for (const [what, sql] of awkward) expect(await one<number>(sql), what).toBeGreaterThan(0);
    }, 180_000);

    it("can be read table by table by the Data page, the long product description included", async () => {
        const { run, config, counts } = await fresh();
        await run(example("generate_data_oracle.sql"));
        const have = await counts();
        const relations = await withOracle(config, loadOracleRelations);
        expect(relations.map((relation) => relation.name).sort()).toEqual([...TABLES].sort());
        for (const relation of relations) {
            const page = await withOracle(config, (c) => fetchOracleRows(c, { schema: relation.schema, table: relation.name, exactCount: true }));
            expect(page.exactTotal, relation.name).toBe(have[relation.name]);
            expect(page.rows.length, relation.name).toBe(Math.min(100, have[relation.name]));
            expect(page.columns.length, relation.name).toBe(relation.columns.length);
            // the description of thousands of characters is shown as its first 4000, and marked as cut
            if (relation.name === "PROD_MST") {
                const column = page.columns.findIndex((entry) => entry.name === "PROD_DESC");
                expect(page.rows.map((row) => row[column]?.length ?? 0)).toContain(4000);
                expect(page.truncatedCells).toEqual([[3, column]]);
            }
        }
    }, 240_000);

    it("can be run again: more customers and their rows, no duplicate reference rows, nothing broken", async () => {
        const { run, counts } = await fresh();
        await run(example("generate_data_oracle.sql"));
        const first = await counts();
        const again = await run(example("generate_data_oracle.sql"));
        expect(again.ok, JSON.stringify(!again.ok && again.error)).toBe(true);
        const second = await counts();
        expect(second).toMatchObject({ AGNT_MST: 12, PROD_MST: 8, ADJSTR_MST: 10, CUST_MST: 400 });
        for (const table of ["CUST_ADDR", "POLCY_HDR", "POLCY_COVG", "PREM_PMT", "CLM_DTL", "CLM_PYMT"]) expect(second[table], table).toBeGreaterThan(first[table]);
    }, 240_000);

    it("gives the same data every time on an empty database", async () => {
        const [a, b] = [await fresh(), await fresh()];
        await a.run(example("generate_data_oracle.sql"));
        await b.run(example("generate_data_oracle.sql"));
        expect(await a.counts()).toEqual(await b.counts());
        const sums = "SELECT (SELECT SUM(NVL(annl_prem, 0)) FROM polcy_hdr) + (SELECT SUM(clm_amt) FROM clm_dtl) + (SELECT SUM(pmt_amt) FROM prem_pmt) FROM dual";
        expect(await a.one(sums)).toEqual(await b.one(sums));
    }, 240_000);

    it.skipIf(!pgUrl)("migrates to PostgreSQL, says what it leaves behind, and is proved equal table by table", async () => {
        const { run, config } = await fresh();
        await run(example("generate_data_oracle.sql"));
        const plan = await withOracle(config, (c) => planOracleMigration(c));
        expect(plan.problems).toEqual([]);
        expect(plan.tables).toHaveLength(10);
        const left = plan.notCarried.map((entry) => `${entry.kind}:${entry.name}`).sort();
        expect(left).toEqual(["check constraint:CK_CLM_AMT", "check constraint:CK_POLCY_DATES", "index:IX_CLM_POLCY", "index:IX_PMT_POLCY", "index:IX_POLCY_AGNT", "index:IX_POLCY_CUST"]);

        const pgAdmin = adminConfigFromUrl(pgUrl!);
        const database = `ins10_test_${Math.random().toString(36).slice(2, 8)}`;
        databases.push(database);
        await createDatabaseFromSql(pgAdmin, database, plan.createSql.join(";\n"));
        const result = await withOracle(config, (oracle) => withPgClient({ ...pgAdmin, database }, (pg) => loadAndVerify(oracle, pg, plan)));
        expect(result.tables).toHaveLength(10);
        expect(result.verification.every((v) => v.mismatches.length === 0)).toBe(true);
        expect(result.verification.every((v) => v.oracleRows === v.postgresRows && v.oracleRows > 0)).toBe(true);
    }, 300_000);
});
