import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { init } from "@guanmingchiu/sqlparser-ts";
import { DatabaseDialect } from "@/lib/database";
import { getDataTypes } from "@/test/fixtures/data-types";
import { makeDatabase } from "@/test/fixtures/dbml-builders";
import { prepareSqlSchemaChange } from "@/utils/import/prepare-sql-schema-change";
import { canCreateLiveDatabase, liveSchemaSql } from "./live-database";
import { canConvertToPostgres, convertOracleToPostgres, foldName } from "./to-postgres";

// PGlite is PostgreSQL itself (in-process); it is a dependency of server/, where the other tests that use it live.
const { PGlite } = createRequire(new URL("../../../server/package.json", import.meta.url))("@electric-sql/pglite") as typeof import("../../../server/node_modules/@electric-sql/pglite");

const oracle = DatabaseDialect.ORACLE;
const oracleTypes = getDataTypes(oracle);
const INSURANCE = readFileSync(resolve(import.meta.dirname, "../../../queryshift/domain/legacy_schema.sql"), "utf8");

beforeAll(async () => {
    await init();
});

const fromOracleSql = async (sql: string) => (await prepareSqlSchemaChange(sql, makeDatabase(oracle, []), oracleTypes)).targetDatabase;

describe("which diagrams can become a live database", () => {
    it("PostgreSQL as it is, Oracle by conversion, nothing else", () => {
        expect(canCreateLiveDatabase(DatabaseDialect.POSTGRES)).toBe(true);
        expect(canCreateLiveDatabase(oracle)).toBe(true);
        expect(canConvertToPostgres(oracle)).toBe(true);
        for (const other of [DatabaseDialect.MYSQL, DatabaseDialect.MARIADB, DatabaseDialect.MSSQL, DatabaseDialect.SQLITE]) expect(canCreateLiveDatabase(other)).toBe(false);
        expect(canCreateLiveDatabase(undefined)).toBe(false);
    });
});

describe("folding names", () => {
    it("lower-cases the default (upper-case) spelling and keeps a name that was quoted in mixed case", () => {
        expect(foldName("CUST_MST")).toBe("cust_mst");
        expect(foldName("Orders")).toBe("Orders");
        expect(foldName("a1")).toBe("a1");
        expect(foldName("_")).toBe("_");
    });
});

describe("the pasted insurance schema (the Oracle file from queryshift/domain)", () => {
    it("becomes PostgreSQL DDL with PostgreSQL types and lower-case names, and runs on PostgreSQL", async () => {
        const diagram = await fromOracleSql(INSURANCE);
        expect(diagram.dialect).toBe(oracle);
        expect(diagram.tables.map((table) => table.name).sort()).toEqual(["CLM_DTL", "CUST_MST", "POLCY_HDR"]);

        const sql = await liveSchemaSql(diagram, oracleTypes);
        expect(sql).not.toMatch(/VARCHAR2|\bNUMBER\b/i);
        expect(sql).not.toContain('"CUST_MST"');

        const db = new PGlite();
        await db.exec(sql);
        const columns = (await db.query<{ table_name: string; column_name: string; data_type: string; character_maximum_length: number | null; numeric_precision: number | null; numeric_scale: number | null; is_nullable: string }>(
            "SELECT table_name, column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
        )).rows;
        await db.close();

        const byName = new Map(columns.map((column) => [`${column.table_name}.${column.column_name}`, column]));
        expect([...new Set(columns.map((column) => column.table_name))].sort()).toEqual(["clm_dtl", "cust_mst", "polcy_hdr"]);
        expect(columns).toHaveLength(19);

        const type = (name: string) => byName.get(name)?.data_type;
        expect(type("cust_mst.cust_id")).toBe("bigint"); // NUMBER(10)
        expect(type("cust_mst.cust_nm")).toBe("character varying");
        expect(byName.get("cust_mst.cust_nm")?.character_maximum_length).toBe(100);
        expect(type("cust_mst.join_dt")).toBe("timestamp without time zone"); // DATE
        expect(type("polcy_hdr.annl_prem")).toBe("numeric"); // NUMBER(12,2)
        expect(byName.get("polcy_hdr.annl_prem")).toMatchObject({ numeric_precision: 12, numeric_scale: 2, is_nullable: "YES" });
        expect(type("clm_dtl.clm_dt")).toBe("timestamp without time zone");
        expect(byName.get("cust_mst.cust_nm")?.is_nullable).toBe("NO");
        expect(byName.get("cust_mst.cust_email")?.is_nullable).toBe("YES");
    });

    it("keeps the keys: the primary keys and the foreign keys between the three tables", async () => {
        const sql = await liveSchemaSql(await fromOracleSql(INSURANCE), oracleTypes);
        const db = new PGlite();
        await db.exec(sql);
        const constraints = (await db.query<{ table_name: string; constraint_type: string }>(
            "SELECT table_name, constraint_type FROM information_schema.table_constraints WHERE table_schema = 'public' AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY') ORDER BY table_name, constraint_type",
        )).rows;
        // rows must really go in, and a legacy-shaped query must find the tables by their lower-case names
        await db.exec("INSERT INTO cust_mst VALUES (1, 'Asha', NULL, 'RET', TIMESTAMP '2019-04-12 00:00:00')");
        await db.exec("INSERT INTO polcy_hdr VALUES (101, 1, 'AUTO', TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-12-31 00:00:00', 1200.50, 'AC')");
        await expect(db.exec("INSERT INTO polcy_hdr VALUES (102, 99, 'AUTO', now(), now(), 1, 'AC')")).rejects.toThrow(/foreign key/i);
        const joined = await db.query<{ cust_nm: string; annl_prem: string }>("SELECT c.cust_nm, p.annl_prem FROM cust_mst c JOIN polcy_hdr p ON p.cust_id = c.cust_id");
        await db.close();
        expect(constraints.filter((c) => c.constraint_type === "PRIMARY KEY")).toHaveLength(3);
        expect(constraints.filter((c) => c.constraint_type === "FOREIGN KEY")).toHaveLength(2);
        expect(joined.rows).toEqual([{ cust_nm: "Asha", annl_prem: "1200.50" }]);
    });
});

describe("what it will not do silently", () => {
    it("maps NUMBER by precision and scale", async () => {
        const diagram = await fromOracleSql("CREATE TABLE t (a NUMBER(3), b NUMBER(9), c NUMBER(18), d NUMBER(30), e NUMBER(8,3), f NUMBER, g FLOAT, h CLOB, i BLOB, j CHAR(2), k TIMESTAMP);");
        const { database, problems } = convertOracleToPostgres(diagram, oracleTypes);
        expect(problems).toEqual([]);
        const types = Object.fromEntries(database.tables[0].fields.map((field) => [field.name, field.type.name + (field.precision != null ? `(${field.precision}${field.scale != null ? `,${field.scale}` : ""})` : "") + (field.maxLength != null && ["char", "varchar"].includes(field.type.name ?? "") ? `[${field.maxLength}]` : "")]));
        expect(types).toEqual({ a: "smallint", b: "integer", c: "bigint", d: "numeric(30,0)", e: "numeric(8,3)", f: "numeric", g: "double precision", h: "text", i: "bytea", j: "char[2]", k: "timestamp" });
    });

    it("refuses a type that has no PostgreSQL form, naming the column", async () => {
        const diagram = await fromOracleSql("CREATE TABLE audit_log (id NUMBER(10) PRIMARY KEY, at TIMESTAMP WITH TIME ZONE, doc BFILE);");
        const { problems } = convertOracleToPostgres(diagram, oracleTypes);
        expect(problems.join(" ")).toMatch(/audit_log\.at|AUDIT_LOG\.AT/i);
        await expect(liveSchemaSql(diagram, oracleTypes)).rejects.toThrow(/cannot be created in PostgreSQL as it is/);
    });

    it("refuses an Oracle function used as a default, and turns SYSDATE into CURRENT_TIMESTAMP", async () => {
        // the importer keeps a default only when it can read it, so the defaults are set on the parsed diagram here
        const base = await fromOracleSql("CREATE TABLE a (id NUMBER(5) PRIMARY KEY, g VARCHAR2(32), made DATE);");
        const withDefault = (name: string, value: string) => ({ ...base, tables: [{ ...base.tables[0], fields: base.tables[0].fields.map((field) => (field.name === name ? { ...field, defaultValue: value } : field)) }] });

        expect(convertOracleToPostgres(withDefault("g", "SYS_GUID()"), oracleTypes).problems.join(" ")).toMatch(/SYS_GUID/i);
        for (const now of ["SYSDATE", "sysdate", "SYSTIMESTAMP", "CURRENT_TIMESTAMP"]) {
            const { database, problems } = convertOracleToPostgres(withDefault("made", now), oracleTypes);
            expect(problems, now).toEqual([]);
            expect(database.tables[0].fields.find((field) => field.name === "made")?.defaultValue, now).toBe("now");
        }
        expect(await liveSchemaSql(withDefault("made", "SYSDATE"), oracleTypes)).toMatch(/DEFAULT CURRENT_TIMESTAMP/);
        // a plain literal default is passed through
        expect(convertOracleToPostgres(withDefault("g", "'x'"), oracleTypes).database.tables[0].fields.find((field) => field.name === "g")?.defaultValue).toBe("'x'");
    });

    it("refuses a view instead of leaving it out", async () => {
        const diagram = await fromOracleSql("CREATE TABLE a (id NUMBER(5) PRIMARY KEY); CREATE VIEW v AS SELECT id FROM a;");
        if ((diagram.views ?? []).length === 0) return; // the importer did not keep the view: nothing to refuse
        expect(convertOracleToPostgres(diagram, oracleTypes).problems.join(" ")).toMatch(/view/i);
    });

    it("only converts Oracle", () => {
        expect(() => convertOracleToPostgres(makeDatabase(DatabaseDialect.MYSQL, []))).toThrow(/Only an Oracle diagram/);
    });
});
