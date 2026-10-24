import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { init } from "@guanmingchiu/sqlparser-ts";
import { DatabaseDialect } from "@/lib/database";
import { getDataTypes } from "@/test/fixtures/data-types";
import { makeDatabase } from "@/test/fixtures/dbml-builders";
import { prepareSqlSchemaChange } from "@/utils/import/prepare-sql-schema-change";
import { PAGE_CONNECTION_KEYS, SQL_CONNECTION_KEY, liveDatabaseCreatedText, oracleSchemaSql, rememberSqlConnection } from "./live-database";

const oracleTypes = getDataTypes(DatabaseDialect.ORACLE);
const INSURANCE = readFileSync(resolve(import.meta.dirname, "../../../queryshift/domain/legacy_schema.sql"), "utf8");

beforeAll(async () => {
    await init();
});

const diagram = async () => (await prepareSqlSchemaChange(INSURANCE, makeDatabase(DatabaseDialect.ORACLE, []), oracleTypes)).targetDatabase;

describe("the script for an Oracle database", () => {
    it("is the diagram's own Oracle DDL, nothing converted", async () => {
        const sql = await oracleSchemaSql(await diagram(), oracleTypes);
        expect(sql).toMatch(/CREATE TABLE CUST_MST/);
        expect(sql).toMatch(/CUST_ID NUMBER \(10\) PRIMARY KEY/);
        expect(sql).toMatch(/CUST_NM VARCHAR2 \(100\) NOT NULL/);
        expect(sql).toMatch(/ANNL_PREM NUMBER \(12, 2\) NULL/);
        expect(sql).toMatch(/JOIN_DT DATE NOT NULL/);
        expect(sql).toMatch(/ALTER TABLE POLCY_HDR ADD CONSTRAINT .* FOREIGN KEY \(CUST_ID\) REFERENCES CUST_MST \(CUST_ID\)/);
        expect(sql).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
    });

    it("refuses a diagram that is not Oracle", async () => {
        await expect(oracleSchemaSql(makeDatabase(DatabaseDialect.POSTGRES, []), getDataTypes(DatabaseDialect.POSTGRES))).rejects.toThrow(/Only an Oracle schema/);
    });
});

describe("what to tell the person", () => {
    it("says where an Oracle database shows up, which is the SQL page and nowhere else", () => {
        expect(liveDatabaseCreatedText({ name: "insurance", engine: "oracle" })).toBe('"insurance" is now an Oracle database. Open it under SQL to run Oracle queries.');
        expect(liveDatabaseCreatedText({ name: "shop", engine: "postgres" })).toBe('"shop" is now a live database under Data, Modernizer, Schema Change and SQL.');
        expect(liveDatabaseCreatedText({ name: "old" })).toMatch(/under Data, Modernizer, Schema Change and SQL/);
    });

    it("points only the SQL page at a new Oracle database", () => {
        const stored: Record<string, string> = {};
        rememberSqlConnection("conn-1", { setItem: (key, value) => void (stored[key] = value) });
        expect(stored).toEqual({ [SQL_CONNECTION_KEY]: "conn-1" });
        expect(PAGE_CONNECTION_KEYS).toContain(SQL_CONNECTION_KEY);
    });
});

/**
 * Against a real Oracle: set ORACLE_TEST_ADMIN_URL=oracle://system:password@127.0.0.1:1521/FREEPDB1 (see docker-compose.yml). The script the
 * app renders for the pasted diagram must really build in Oracle, and then a legacy Oracle query must really run on it.
 */
const url = process.env.ORACLE_TEST_ADMIN_URL;
describe.skipIf(!url)("the rendered script, on a real Oracle", () => {
    it("builds the pasted insurance diagram in a new schema, and a legacy query runs on it", async () => {
        const { oracleServerFromEnv, createOracleSchema, dropOracleSchema, oracleSchemaName, newSchemaPassword } = await import("../../../server/src/services/oracle-schemas");
        const { withOracle } = await import("../../../server/src/services/oracle-client");
        const server = oracleServerFromEnv({ ORACLE_ADMIN_URL: url } as NodeJS.ProcessEnv)!;
        const schema = oracleSchemaName("0a1b2c3d-0000-0000-0000-000000000000", `diagram_${Math.random().toString(36).slice(2, 6)}`);
        const password = newSchemaPassword();
        try {
            const { statementsRun } = await createOracleSchema(server.admin, schema, password, await oracleSchemaSql(await diagram(), oracleTypes));
            expect(statementsRun).toBe(5); // three tables and two foreign keys
            const rows = await withOracle({ ...server.admin, user: schema, password }, async (connection) => {
                await connection.execute("INSERT INTO cust_mst VALUES (1, 'Asha', NULL, 'RET', DATE '2019-04-12')");
                await connection.execute("INSERT INTO polcy_hdr VALUES (101, 1, 'AUTO', DATE '2026-01-01', DATE '2026-12-31', 1200, 'AC')");
                const result = await connection.execute("SELECT c.cust_nm, SUM(NVL(p.annl_prem, 0)) FROM cust_mst c, polcy_hdr p WHERE c.cust_id = p.cust_id(+) GROUP BY c.cust_nm");
                return result.rows;
            });
            expect(rows).toEqual([["Asha", 1200]]);
            await expect(withOracle({ ...server.admin, user: schema, password }, (connection) => connection.execute("INSERT INTO polcy_hdr VALUES (102, 99, 'AUTO', DATE '2026-01-01', DATE '2026-12-31', 1, 'AC')"))).rejects.toThrow(/ORA-02291/);
        } finally {
            await dropOracleSchema(server.admin, schema).catch(() => undefined);
        }
    }, 60_000);
});
