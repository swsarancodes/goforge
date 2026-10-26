import { describe, expect, it } from "vitest";
import { planMigration, type OracleColumn, type OracleTable } from "./oracle-migration.js";
import { allowedPgTypes, applyOperations, dataCheckFor, parsePgType, resolveName, resolvePgType, type MigrationEdits } from "./oracle-type-edits.js";

const column = (name: string, type: string, extra: Partial<OracleColumn> = {}): OracleColumn => ({ name, type, charLength: null, dataLength: null, precision: null, scale: null, nullable: true, defaultValue: null, ...extra });
const tables: OracleTable[] = [
    {
        name: "CLM",
        columns: [
            column("ID", "NUMBER", { precision: 10, scale: 0, nullable: false }),
            column("CLM_DT", "DATE", { nullable: false }),
            column("AMT", "NUMBER", { precision: 12, scale: 2 }),
            column("FLAG", "NUMBER", { precision: 1, scale: 0, defaultValue: "0" }),
            column("NOTE", "VARCHAR2", { charLength: 200, dataLength: 200 }),
            column("STATUS", "VARCHAR2", { charLength: 5, dataLength: 5, defaultValue: "'OP'" }),
            column("GUID", "VARCHAR2", { charLength: 40, dataLength: 40, defaultValue: "SYS_GUID()" }),
        ],
        primaryKey: { name: "CLM_PK", columns: ["ID"] },
        uniques: [],
        foreignKeys: [],
    },
    { name: "OWNER", columns: [column("OWNER_ID", "NUMBER", { precision: 5, scale: 0, nullable: false })], primaryKey: { name: "OWNER_PK", columns: ["OWNER_ID"] }, uniques: [], foreignKeys: [] },
];
const plan = (edits: MigrationEdits = {}) => planMigration(tables, new Map(), edits);
const clm = (edits: MigrationEdits = {}) => plan(edits).tables[0];
const col = (edits: MigrationEdits, name: string) => clm(edits).columns.find((c) => c.oracleName === name)!;

describe("PostgreSQL types a person may ask for", () => {
    it("reads the common spellings into one", () => {
        expect(parsePgType("INT")?.canonical).toBe("integer");
        expect(parsePgType("Character Varying (40)".replace(" (", "("))?.canonical).toBe("varchar(40)");
        expect(parsePgType("timestamp with time zone")?.canonical).toBe("timestamptz(6)");
        expect(parsePgType("decimal(10, 2)")?.canonical).toBe("numeric(10,2)");
        expect(parsePgType("bool")?.canonical).toBe("boolean");
    });

    it("refuses what is not a type the migration knows, and sizes that cannot exist", () => {
        for (const text of ["money", "jsonb", "varchar", "numeric(3,5)", "timestamp(9)", "varchar(0)", "integer; drop table x", "numeric(5,2) default 1"]) expect(parsePgType(text), text).toBeUndefined();
    });

    it("lists, for each Oracle type, only the types that can hold its values", () => {
        expect(allowedPgTypes({ type: "DATE" })).toEqual(["timestamp(n)", "date", "text"]);
        expect(allowedPgTypes({ type: "BLOB" })).toEqual(["bytea"]);
        expect(allowedPgTypes({ type: "XMLTYPE" })).toEqual([]);
        expect(allowedPgTypes({ type: "TIMESTAMP(6) WITH TIME ZONE" })).toEqual(["timestamptz(n)", "text"]);
    });

    it("says why a column cannot become a type", () => {
        const date = tables[0].columns[1];
        expect(resolvePgType(date, "integer")).toMatch(/DATE cannot become integer here/);
        expect(resolvePgType(date, "date")).toMatchObject({ type: "date", kind: "date" });
        expect(resolvePgType(tables[0].columns[4], "bigint")).toMatchObject({ kind: "number" });
    });

    it("reads names as lower-case identifiers", () => {
        expect(resolveName(" Claim_Details ")).toBe("claim_details");
        for (const name of ["", "1abc", "with space", "a-b", "x".repeat(64), 'q"uote']) expect(resolveName(name), name).toBeUndefined();
    });
});

describe("a plan with the person's edits", () => {
    it("changes a type, its notes and its checks, and keeps everything else as it was", () => {
        const before = col({}, "CLM_DT");
        expect(before).toMatchObject({ pgType: "timestamp(0)", edited: [] });
        const after = col({ columns: { "CLM.CLM_DT": { pgType: "date" } } }, "CLM_DT");
        expect(after).toMatchObject({ pgType: "date", kind: "date", edited: ["type"] });
        expect(after.note.text).toMatch(/^You changed this to date\./);
        expect(plan({ columns: { "CLM.CLM_DT": { pgType: "date" } } }).createSql[0]).toContain('"clm_dt" date NOT NULL');
    });

    it("renames a table and a column, in the DDL, the keys and the primary key", () => {
        const edited = plan({ tables: { CLM: { pgName: "claim" } }, columns: { "CLM.ID": { pgName: "claim_id" } } });
        expect(edited.tables[0]).toMatchObject({ pgName: "claim", renamed: true, pgPrimaryKey: ["claim_id"] });
        expect(edited.tables[0].columns[0]).toMatchObject({ pgName: "claim_id", edited: ["name"] });
        expect(edited.createSql[0]).toContain('CREATE TABLE "claim"');
        expect(edited.createSql[0]).toContain('PRIMARY KEY ("claim_id")');
    });

    it("keeps a default only when it still fits the new type, and says when it is dropped", () => {
        const kept = col({ columns: { "CLM.STATUS": { pgType: "varchar(8)" } } }, "STATUS");
        expect(kept.pgDefault).toBe("'OP'");
        const dropped = col({ columns: { "CLM.FLAG": { pgType: "boolean" } } }, "FLAG");
        expect(dropped.pgDefault).toBeNull();
        expect(dropped.note.text).toMatch(/Its default 0 was not carried over: it does not fit boolean/);
    });

    it("lets a person drop a default Oracle code would block, and the block goes with it", () => {
        expect(plan().problems).toEqual(["CLM.GUID: its default SYS_GUID() is Oracle code."]);
        const fixed = plan({ columns: { "CLM.GUID": { dropDefault: true } } });
        expect(fixed.problems).toEqual([]);
        expect(fixed.tables[0].columns.find((c) => c.oracleName === "GUID")).toMatchObject({ pgDefault: null, edited: ["default"] });
    });

    it("sets aside an edit it cannot make, with the reason, and leaves the plan as it was", () => {
        const refused = plan({ columns: { "CLM.CLM_DT": { pgType: "integer" } }, tables: { OWNER: { pgName: "Bad Name" } } });
        expect(refused.editProblems).toEqual([expect.stringMatching(/^CLM\.CLM_DT: DATE cannot become integer here/), 'OWNER: "Bad Name" is not a usable PostgreSQL name.']);
        expect(refused.tables[1].pgName).toBe("owner");
        expect(refused.tables[0].columns[1].pgType).toBe("timestamp(0)");
    });

    it("stops the migration when two names would clash", () => {
        expect(plan({ tables: { CLM: { pgName: "owner" } } }).problems).toContain("CLM and OWNER would both be called owner.");
        expect(plan({ columns: { "CLM.NOTE": { pgName: "status" } } }).problems).toContain("CLM: NOTE and STATUS would both be called status.");
    });
});

describe("applying what the assistant asks for", () => {
    it("applies each change, ignoring case, and reports what it did in words", () => {
        const result = applyOperations(tables, {}, [
            { op: "set_column_type", table: "clm", column: "clm_dt", pgType: "DATE" },
            { op: "rename_table", table: "CLM", newName: "Claim" },
            { op: "rename_column", table: "CLM", column: "AMT", newName: "amount" },
            { op: "drop_default", table: "CLM", column: "GUID" },
        ]);
        expect(result.rejected).toEqual([]);
        expect(result.applied).toEqual(["make CLM.CLM_DT date", "rename table CLM to Claim", "rename CLM.AMT to amount", "drop the default of CLM.GUID"]);
        expect(result.edits).toEqual({ tables: { CLM: { pgName: "claim" } }, columns: { "CLM.CLM_DT": { pgType: "date" }, "CLM.AMT": { pgName: "amount" }, "CLM.GUID": { dropDefault: true } }, objects: {} });
    });

    it("refuses what is not there, what has no rule, and what would clash, and still applies the rest", () => {
        const result = applyOperations(tables, {}, [
            { op: "rename_table", table: "NOPE", newName: "x" },
            { op: "rename_column", table: "CLM", column: "NOPE", newName: "x" },
            { op: "set_column_type", table: "CLM", column: "CLM_DT", pgType: "jsonb" },
            { op: "set_column_type", table: "CLM", column: "CLM_DT", pgType: "integer" },
            { op: "rename_table", table: "CLM", newName: "owner" },
            { op: "rename_column", table: "CLM", column: "NOTE", newName: "status" },
            { op: "drop_default", table: "CLM", column: "AMT" },
            { op: "rename_table", table: "CLM", newName: "'; drop" },
            { op: "set_column_type", table: "CLM", column: "AMT", pgType: "numeric(14,2)" },
        ]);
        expect(result.applied).toEqual(["make CLM.AMT numeric(14,2)"]);
        expect(result.rejected.map((r) => r.reason)).toEqual([
            "there is no table NOPE",
            "CLM has no column NOPE",
            expect.stringMatching(/"jsonb" is not a type this migration knows/),
            expect.stringMatching(/DATE cannot become integer here/),
            "another table is already called owner",
            "CLM already has a column called status",
            "CLM.AMT has no default",
            expect.stringMatching(/not a usable PostgreSQL name/),
        ]);
    });

    it("undoes a change, and an edit that changes nothing leaves no trace", () => {
        const start: MigrationEdits = { tables: { CLM: { pgName: "claim" } }, columns: { "CLM.CLM_DT": { pgType: "date" }, "CLM.AMT": { pgName: "amount" } } };
        const result = applyOperations(tables, start, [{ op: "reset_column", table: "CLM", column: "CLM_DT" }, { op: "reset_table", table: "CLM" }]);
        expect(result.edits).toEqual({ tables: {}, columns: { "CLM.AMT": { pgName: "amount" } }, objects: {} });
        expect(start.columns?.["CLM.CLM_DT"]).toEqual({ pgType: "date" });
    });
});

describe("the query on the Oracle data that counts what a change would lose", () => {
    const check = (name: string, pgType: string) => dataCheckFor("CLM", tables[0].columns.find((c) => c.name === name)!, pgType);

    it("counts times of day going into a date, and decimals or out-of-range numbers going into an integer", () => {
        expect(check("CLM_DT", "date")).toMatchObject({ description: "values with a time of day, which a date does not keep", sql: 'SELECT COUNT(*) FROM "CLM" WHERE "CLM_DT" <> TRUNC("CLM_DT")' });
        expect(check("AMT", "integer")?.sql).toBe('SELECT COUNT(*) FROM "CLM" WHERE "AMT" <> TRUNC("AMT") OR "AMT" < -2147483648 OR "AMT" > 2147483647');
        expect(check("AMT", "numeric(5,2)")?.description).toBe("values with more than 2 decimals or more than 3 whole digits");
    });

    it("counts text that is not a number, is too long, or is not a flag", () => {
        expect(check("NOTE", "integer")?.description).toBe("text that is not a whole number");
        expect(check("NOTE", "numeric")?.description).toBe("text that is not a number");
        expect(check("NOTE", "varchar(50)")?.sql).toBe('SELECT COUNT(*) FROM "CLM" WHERE LENGTH("NOTE") > 50');
        expect(check("STATUS", "boolean")?.description).toBe("values other than Y, N, T, F, 1 and 0");
        expect(check("FLAG", "boolean")?.sql).toBe('SELECT COUNT(*) FROM "CLM" WHERE "FLAG" NOT IN (0, 1)');
    });

    it("has nothing to count where nothing can be lost", () => {
        expect(check("CLM_DT", "text")).toBeUndefined();
        expect(check("NOTE", "text")).toBeUndefined();
        expect(check("NOTE", "varchar(500)")).toBeUndefined();
        expect(check("AMT", "numeric")).toBeUndefined();
        expect(check("ID", "bigint")?.description).toMatch(/decimals, or outside/);
    });

    it("counts the values written in another time zone, as a default check", () => {
        const tz = column("AT", "TIMESTAMP(6) WITH TIME ZONE");
        expect(dataCheckFor("T", tz, "timestamptz(6)")?.sql).toContain("EXTRACT(TIMEZONE_HOUR FROM");
        expect(dataCheckFor("T", column("AT", "TIMESTAMP(6) WITH LOCAL TIME ZONE"), "timestamptz(6)")).toBeUndefined();
    });
});
