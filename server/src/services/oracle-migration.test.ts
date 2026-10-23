import { describe, expect, it } from "vitest";
import { foldName, pgDefaultOf, pgTypeOf, planMigration, type OracleColumn, type OracleTable } from "./oracle-migration.js";

const col = (name: string, type: string, extra: Partial<OracleColumn> = {}): OracleColumn => ({ name, type, charLength: null, dataLength: null, precision: null, scale: null, nullable: true, defaultValue: null, ...extra });

describe("pgTypeOf", () => {
    const type = (column: OracleColumn) => {
        const result = pgTypeOf(column);
        return typeof result === "string" ? result : result.type;
    };

    it("maps NUMBER by precision and scale", () => {
        expect(type(col("a", "NUMBER", { precision: 3, scale: 0 }))).toBe("smallint");
        expect(type(col("a", "NUMBER", { precision: 4 }))).toBe("smallint");
        expect(type(col("a", "NUMBER", { precision: 9, scale: 0 }))).toBe("integer");
        expect(type(col("a", "NUMBER", { precision: 10, scale: 0 }))).toBe("bigint");
        expect(type(col("a", "NUMBER", { precision: 18, scale: 0 }))).toBe("bigint");
        expect(type(col("a", "NUMBER", { precision: 19, scale: 0 }))).toBe("numeric(19,0)");
        expect(type(col("a", "NUMBER", { precision: 12, scale: 2 }))).toBe("numeric(12,2)");
        expect(type(col("a", "NUMBER"))).toBe("numeric");
        expect(type(col("a", "NUMBER", { precision: 6, scale: -2 }))).toBe("numeric(6,0)");
    });

    it("maps text, binary, floating point and dates", () => {
        expect(type(col("a", "VARCHAR2", { charLength: 100, dataLength: 400 }))).toBe("varchar(100)");
        expect(type(col("a", "NVARCHAR2", { charLength: 20 }))).toBe("varchar(20)");
        expect(type(col("a", "CHAR", { charLength: 3 }))).toBe("char(3)");
        expect(type(col("a", "CLOB"))).toBe("text");
        expect(type(col("a", "BLOB"))).toBe("bytea");
        expect(type(col("a", "RAW", { dataLength: 16 }))).toBe("bytea");
        expect(type(col("a", "FLOAT", { precision: 126 }))).toBe("double precision");
        expect(type(col("a", "BINARY_FLOAT"))).toBe("real");
        expect(type(col("a", "BINARY_DOUBLE"))).toBe("double precision");
        expect(type(col("a", "DATE"))).toBe("timestamp(0)");
        expect(type(col("a", "TIMESTAMP(6)"))).toBe("timestamp(6)");
        expect(type(col("a", "TIMESTAMP(3)"))).toBe("timestamp(3)");
        expect(type(col("a", "TIMESTAMP(6) WITH TIME ZONE"))).toBe("timestamptz(6)");
        expect(type(col("a", "TIMESTAMP(6) WITH LOCAL TIME ZONE"))).toBe("timestamptz(6)");
        expect(type(col("a", "ROWID"))).toBe("text");
    });

    it("says why when there is no faithful type: nine fractional digits, intervals, XML, objects", () => {
        for (const odd of ["TIMESTAMP(9)", "INTERVAL DAY(2) TO SECOND(6)", "INTERVAL YEAR(2) TO MONTH", "XMLTYPE", "SDO_GEOMETRY", "LONG", "BFILE"]) {
            expect(type(col("a", odd)), odd).toMatch(/has no PostgreSQL type|more than PostgreSQL/);
        }
    });
});

describe("pgDefaultOf", () => {
    const of = (text: string | null) => pgDefaultOf(col("a", "DATE", { defaultValue: text }));
    it("carries over what means the same: SYSDATE, numbers, strings, NULL", () => {
        expect(of(null)).toEqual({ value: null });
        expect(of("SYSDATE")).toEqual({ value: "CURRENT_TIMESTAMP" });
        expect(of("sysdate")).toEqual({ value: "CURRENT_TIMESTAMP" });
        expect(of("SYSTIMESTAMP")).toEqual({ value: "CURRENT_TIMESTAMP" });
        expect(of("7")).toEqual({ value: "7" });
        expect(of("-1.5")).toEqual({ value: "-1.5" });
        expect(of("'AC'")).toEqual({ value: "'AC'" });
        expect(of("'it''s'")).toEqual({ value: "'it''s'" });
        expect(of("NULL")).toEqual({ value: null });
    });
    it("refuses Oracle code instead of dropping it", () => {
        for (const code of ["SYS_GUID()", "my_seq.NEXTVAL", "TO_DATE('2020-01-01','YYYY-MM-DD')", "USER", "UPPER('x')"]) expect(of(code), code).toMatch(/is Oracle code/);
    });
});

const insurance = (): OracleTable[] => [
    {
        name: "CUST_MST",
        columns: [col("CUST_ID", "NUMBER", { precision: 10, scale: 0, nullable: false }), col("CUST_NM", "VARCHAR2", { charLength: 100, nullable: false }), col("CUST_EMAIL", "VARCHAR2", { charLength: 120 })],
        primaryKey: { name: "SYS_C001", columns: ["CUST_ID"] },
        uniques: [],
        foreignKeys: [],
    },
    {
        name: "POLCY_HDR",
        columns: [col("POLCY_ID", "NUMBER", { precision: 10, scale: 0, nullable: false }), col("CUST_ID", "NUMBER", { precision: 10, scale: 0, nullable: false }), col("EFF_DT", "DATE", { nullable: false }), col("ANNL_PREM", "NUMBER", { precision: 12, scale: 2 }), col("STAT_CD", "VARCHAR2", { charLength: 2, nullable: false, defaultValue: "'AC'" })],
        primaryKey: { name: "SYS_C002", columns: ["POLCY_ID"] },
        uniques: [{ name: "UQ_POLCY", columns: ["CUST_ID", "EFF_DT"] }],
        foreignKeys: [{ name: "FK_POLCY_CUST", columns: ["CUST_ID"], refTable: "CUST_MST", refColumns: ["CUST_ID"] }],
    },
];

describe("planMigration", () => {
    it("writes lower-case PostgreSQL tables with their keys first, and the foreign keys apart, to run after the rows", () => {
        const plan = planMigration(insurance(), new Map([["CUST_MST", 3], ["POLCY_HDR", 5]]));
        expect(plan.problems).toEqual([]);
        expect(plan.createSql).toEqual([
            'CREATE TABLE "cust_mst" (\n  "cust_id" bigint NOT NULL,\n  "cust_nm" varchar(100) NOT NULL,\n  "cust_email" varchar(120),\n  PRIMARY KEY ("cust_id")\n)',
            'CREATE TABLE "polcy_hdr" (\n  "polcy_id" bigint NOT NULL,\n  "cust_id" bigint NOT NULL,\n  "eff_dt" timestamp(0) NOT NULL,\n  "annl_prem" numeric(12,2),\n  "stat_cd" varchar(2) NOT NULL DEFAULT \'AC\',\n  PRIMARY KEY ("polcy_id"),\n  CONSTRAINT "uq_polcy" UNIQUE ("cust_id", "eff_dt")\n)',
        ]);
        expect(plan.linkSql).toEqual(['ALTER TABLE "polcy_hdr" ADD CONSTRAINT "fk_polcy_cust" FOREIGN KEY ("cust_id") REFERENCES "cust_mst" ("cust_id")']);
        expect(plan.tables.map((table) => [table.oracleName, table.pgName, table.rows])).toEqual([["CUST_MST", "cust_mst", 3], ["POLCY_HDR", "polcy_hdr", 5]]);
        expect(plan.tables[1].columns.map((c) => [c.oracleName, c.pgName, c.kind])).toEqual([["POLCY_ID", "polcy_id", "number"], ["CUST_ID", "cust_id", "number"], ["EFF_DT", "eff_dt", "date"], ["ANNL_PREM", "annl_prem", "number"], ["STAT_CD", "stat_cd", "string"]]);
    });

    it("keeps a name that was quoted in mixed case, and quotes every name it writes", () => {
        const [table] = planMigration([{ name: "Order Lines", columns: [col("Line No", "NUMBER", { precision: 5, scale: 0, nullable: false }), col("SELECT", "VARCHAR2", { charLength: 5 })], primaryKey: undefined, uniques: [], foreignKeys: [] }], new Map()).createSql;
        expect(table).toBe('CREATE TABLE "Order Lines" (\n  "Line No" integer NOT NULL,\n  "select" varchar(5)\n)');
        expect(foldName("ORDERS")).toBe("orders");
        expect(foldName("Orders")).toBe("Orders");
        expect(foldName("A1")).toBe("a1");
        expect(foldName("_")).toBe("_");
    });

    it("handles composite keys, in the order Oracle lists their columns", () => {
        const tables: OracleTable[] = [
            { name: "A", columns: [col("X", "NUMBER", { precision: 4, nullable: false }), col("Y", "NUMBER", { precision: 4, nullable: false })], primaryKey: { name: "PK_A", columns: ["Y", "X"] }, uniques: [], foreignKeys: [] },
            { name: "B", columns: [col("P", "NUMBER", { precision: 4 }), col("Q", "NUMBER", { precision: 4 })], primaryKey: undefined, uniques: [], foreignKeys: [{ name: "FK_B", columns: ["Q", "P"], refTable: "A", refColumns: ["Y", "X"] }] },
        ];
        const plan = planMigration(tables, new Map());
        expect(plan.createSql[0]).toContain('PRIMARY KEY ("y", "x")');
        expect(plan.linkSql[0]).toContain('FOREIGN KEY ("q", "p") REFERENCES "a" ("y", "x")');
    });

    it("lists every column that cannot be migrated, and a foreign key that leaves the schema, instead of guessing", () => {
        const tables: OracleTable[] = [
            { name: "T", columns: [col("ID", "NUMBER", { precision: 5, nullable: false }), col("SPAN", "INTERVAL DAY(2) TO SECOND(6)"), col("G", "VARCHAR2", { charLength: 5, defaultValue: "SYS_GUID()" })], primaryKey: undefined, uniques: [], foreignKeys: [{ name: "FK_X", columns: ["ID"], refTable: "OTHER", refColumns: ["ID"] }] },
        ];
        const plan = planMigration(tables, new Map());
        expect(plan.problems).toEqual(["T.SPAN: INTERVAL DAY(2) TO SECOND(6) has no PostgreSQL type this migration creates.", "T.G: its default SYS_GUID() is Oracle code.", "T: the foreign key FK_X points at OTHER."]);
    });

    it("says an empty schema is a problem", () => {
        expect(planMigration([], new Map()).problems).toEqual(["The schema has no tables."]);
    });
});
