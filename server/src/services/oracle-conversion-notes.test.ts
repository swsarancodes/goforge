import { describe, expect, it } from "vitest";
import { behaviourNotes, conversionNote } from "./oracle-conversion-notes.js";
import { planMigration, type OracleColumn, type OracleTable } from "./oracle-migration.js";

const shape = (type: string, precision: number | null = null, scale: number | null = null, defaultValue: string | null = null) => ({ type, precision, scale, defaultValue });

describe("what the migration says about a column", () => {
    it("calls whole numbers, decimals and plain NUMBER exact", () => {
        expect(conversionNote(shape("NUMBER", 10, 0), "bigint", null).status).toBe("exact");
        expect(conversionNote(shape("NUMBER", 12, 2), "numeric(12,2)", null)).toMatchObject({ status: "exact", text: "numeric(12,2) keeps every digit and the scale." });
        expect(conversionNote(shape("NUMBER"), "numeric", null).status).toBe("exact");
    });

    it("warns that integer division differs, and that a negative scale stops rounding", () => {
        expect(conversionNote(shape("NUMBER", 5, 0), "integer", null).text).toMatch(/drops the fraction/);
        expect(conversionNote(shape("NUMBER", 6, -2), "numeric(6,0)", null)).toMatchObject({ status: "changed" });
    });

    it("marks what can lose information: a wide FLOAT and the time zone of a timestamp", () => {
        expect(conversionNote(shape("FLOAT", 126), "double precision", null).status).toBe("risk");
        expect(conversionNote(shape("FLOAT", 53), "double precision", null).status).toBe("exact");
        expect(conversionNote(shape("TIMESTAMP(6) WITH TIME ZONE"), "timestamptz(6)", null)).toMatchObject({ status: "risk" });
        expect(conversionNote(shape("TIMESTAMP(6) WITH LOCAL TIME ZONE"), "timestamptz(6)", null).status).toBe("changed");
    });

    it("says a DATE keeps its time of day and changes how date arithmetic works", () => {
        expect(conversionNote(shape("DATE"), "timestamp(0)", null)).toMatchObject({ status: "changed", text: expect.stringContaining("no time of day is lost") });
    });

    it("keeps text, bytes and binary floats exact", () => {
        for (const [type, pg] of [["VARCHAR2", "varchar(20)"], ["CHAR", "char(3)"], ["CLOB", "text"], ["BLOB", "bytea"], ["RAW", "bytea"], ["BINARY_DOUBLE", "double precision"], ["BINARY_FLOAT", "real"], ["TIMESTAMP(3)", "timestamp(3)"]] as const) {
            expect(conversionNote(shape(type), pg, null).status, type).toBe("exact");
        }
    });

    it("says what a default becomes when it is not written the same", () => {
        expect(conversionNote(shape("DATE", null, null, "SYSDATE"), "timestamp(0)", "CURRENT_TIMESTAMP").text).toMatch(/Its default SYSDATE becomes CURRENT_TIMESTAMP/);
        expect(conversionNote(shape("NUMBER", 3, 0, "7"), "smallint", "7").text).not.toMatch(/default/);
    });
});

describe("how the plan carries the notes", () => {
    const column = (name: string, type: string, extra: Partial<OracleColumn> = {}): OracleColumn => ({ name, type, charLength: null, dataLength: null, precision: null, scale: null, nullable: true, defaultValue: null, ...extra });
    const table: OracleTable = {
        name: "T",
        columns: [column("ID", "NUMBER", { precision: 5, scale: 0, nullable: false }), column("D", "DATE"), column("S", "VARCHAR2", { charLength: 10 })],
        primaryKey: { name: "T_PK", columns: ["ID"] },
        uniques: [],
        foreignKeys: [],
    };

    it("puts a note on every column, the primary key on the table, and the behaviour that differs for this schema", () => {
        const plan = planMigration([table], new Map([["T", 3]]));
        expect(plan.tables[0].columns.map((c) => c.note.status)).toEqual(["exact", "changed", "exact"]);
        expect(plan.tables[0]).toMatchObject({ oraclePrimaryKey: ["ID"], pgPrimaryKey: ["id"] });
        expect(plan.behaviour.join(" ")).toMatch(/empty string as NULL/);
        expect(plan.behaviour.join(" ")).toMatch(/DATE arithmetic/);
        expect(plan.behaviour.join(" ")).toMatch(/integer columns/);
    });

    it("lists only the behaviour a schema can meet", () => {
        expect(behaviourNotes([{ columns: [{ oracleType: "NUMBER", pgType: "numeric" }] }])).toEqual(["Names: unquoted Oracle names are upper case and become lower case, so a query without quotes finds the same tables and columns."]);
    });
});
