import { describe, expect, it } from "vitest";
import { dataChangeFor } from "./oracle-data-changes.js";
import { oracleSelectExpression } from "./oracle-migration.js";

const col = (oracleType: string, pgType: string, oracleName = "C") => ({ oracleName, oracleType, pgType });

describe("what the copy does to a value, for each Oracle type", () => {
    it("NUMBER to an integer or numeric type: every digit kept, read as text, a leading dot given its 0", () => {
        for (const pg of ["bigint", "integer", "smallint", "numeric(12,2)", "numeric"]) {
            const change = dataChangeFor(col("NUMBER", pg));
            expect(change, pg).toMatchObject({ effect: "kept", status: "exact", load: `${pg}, parsed from the text` });
            expect(change.read).toContain(".5 becomes 0.5");
            expect(change.read).toContain("not as a JavaScript number");
        }
    });

    it("NUMBER to a floating-point type: parsed, and digits past 6 (real) or 15 (double) are rounded", () => {
        expect(dataChangeFor(col("NUMBER", "double precision"))).toMatchObject({ effect: "converted", status: "changed", summary: expect.stringContaining("past about 15") });
        expect(dataChangeFor(col("NUMBER", "real")).summary).toContain("past about 6");
    });

    it("FLOAT to double precision is rounded the same way, and a BINARY_DOUBLE or BINARY_FLOAT arrives as the same number", () => {
        expect(dataChangeFor(col("FLOAT", "double precision"))).toMatchObject({ effect: "converted", status: "changed" });
        expect(dataChangeFor(col("BINARY_DOUBLE", "double precision"))).toMatchObject({ effect: "kept", status: "exact", summary: expect.stringContaining("same IEEE") });
        expect(dataChangeFor(col("BINARY_FLOAT", "real"))).toMatchObject({ effect: "kept", status: "exact" });
    });

    it("a number that becomes text or a boolean is written as text, or must be 0 or 1", () => {
        expect(dataChangeFor(col("NUMBER", "text"))).toMatchObject({ effect: "reformatted", status: "changed" });
        expect(dataChangeFor(col("NUMBER", "boolean"))).toMatchObject({ effect: "converted", summary: expect.stringContaining("0 and 1 become false and true") });
    });

    it("VARCHAR2 and NVARCHAR2 are copied character for character, and the empty string is explained", () => {
        for (const type of ["VARCHAR2(100)", "NVARCHAR2(50)"]) {
            const change = dataChangeFor(col(type, "varchar(100)", "NAME"));
            expect(change, type).toMatchObject({ effect: "kept", status: "exact", read: "NAME" });
            expect(change.notes).toEqual(["An empty string is NULL in Oracle, so there are none to convert; a NULL stays NULL in PostgreSQL."]);
        }
        expect(dataChangeFor(col("VARCHAR2(10)", "text")).load).toBe("text");
    });

    it("CHAR is copied and padded with blanks to its length", () => {
        expect(dataChangeFor(col("CHAR(2)", "char(2)"))).toMatchObject({ effect: "kept", status: "exact", summary: expect.stringContaining("pads with blanks") });
    });

    it("text that becomes a number or a boolean must parse as one, and the check counts what does not", () => {
        expect(dataChangeFor(col("VARCHAR2(10)", "integer"))).toMatchObject({ effect: "converted", status: "changed", summary: expect.stringContaining("text that is not a number stops the copy") });
        expect(dataChangeFor(col("VARCHAR2(1)", "boolean")).summary).toContain("Y, N, T, F, 1 and 0");
    });

    it("CLOB and NCLOB are fetched whole and loaded as text, with the 1 GB limit and the empty string noted", () => {
        for (const type of ["CLOB", "NCLOB"]) {
            const change = dataChangeFor(col(type, "text"));
            expect(change, type).toMatchObject({ effect: "kept", status: "exact", load: "text" });
            expect(change.read).toContain("fetched whole");
            expect(change.notes.join(" ")).toContain("over 1 GB");
            expect(change.notes.join(" ")).toContain("empty string is NULL");
        }
    });

    it("BLOB and RAW are fetched as bytes and loaded as bytea, the same bytes", () => {
        expect(dataChangeFor(col("BLOB", "bytea"))).toMatchObject({ effect: "kept", status: "exact", load: "bytea", read: expect.stringContaining("BLOB fetched as bytes") });
        expect(dataChangeFor(col("RAW(4)", "bytea"))).toMatchObject({ effect: "kept", status: "exact", read: "RAW fetched as bytes" });
    });

    it("DATE to timestamp(0) keeps the day and the time of day, and says so", () => {
        const change = dataChangeFor(col("DATE", "timestamp(0)", "EFF_DT"));
        expect(change).toMatchObject({ effect: "kept", status: "exact", load: "timestamp(0)" });
        expect(change.summary).toContain("time of day are both kept");
        expect(change.read).toBe(`TO_CHAR("EFF_DT", 'YYYY-MM-DD HH24:MI:SS')`);
    });

    it("DATE to date drops the time of day, which is a real change", () => {
        const change = dataChangeFor(col("DATE", "date", "EFF_DT"));
        expect(change).toMatchObject({ effect: "dropped", status: "risk", load: "date", summary: expect.stringContaining("time of day is dropped") });
        expect(change.read).toBe(`TO_CHAR(TRUNC("EFF_DT"), 'YYYY-MM-DD')`);
    });

    it("DATE to text is the same instant written as text", () => {
        expect(dataChangeFor(col("DATE", "text"))).toMatchObject({ effect: "reformatted", status: "changed", load: "text" });
    });

    it("TIMESTAMP(n) keeps its fraction of a second, and drops the time when it becomes a date", () => {
        const kept = dataChangeFor(col("TIMESTAMP(3)", "timestamp(3)", "TS"));
        expect(kept).toMatchObject({ effect: "kept", status: "exact", read: `TO_CHAR("TS", 'YYYY-MM-DD HH24:MI:SS.FF3')` });
        expect(dataChangeFor(col("TIMESTAMP(6)", "date"))).toMatchObject({ effect: "dropped", status: "risk" });
    });

    it("TIMESTAMP WITH TIME ZONE is converted to UTC and the offset it was written with is not kept: a real change", () => {
        const change = dataChangeFor(col("TIMESTAMP(6) WITH TIME ZONE", "timestamptz(6)", "AT"));
        expect(change).toMatchObject({ effect: "converted", status: "risk", load: "timestamptz(6), in UTC" });
        expect(change.summary).toContain("the offset each value was written with is not");
        expect(change.read).toContain("SYS_EXTRACT_UTC");
        expect(change.read).toContain("'+00'");
        expect(change.notes.join(" ")).toContain("other than UTC");
    });

    it("TIMESTAMP WITH LOCAL TIME ZONE keeps its instant and has no original offset to lose", () => {
        const change = dataChangeFor(col("TIMESTAMP(6) WITH LOCAL TIME ZONE", "timestamptz(6)"));
        expect(change).toMatchObject({ effect: "converted", status: "changed" });
        expect(change.summary).toContain("no original offset to lose");
    });

    it("a time zone timestamp that becomes text is written in UTC", () => {
        expect(dataChangeFor(col("TIMESTAMP(6) WITH TIME ZONE", "text"))).toMatchObject({ effect: "converted", status: "risk", load: "text, in UTC" });
    });

    it("ROWID is copied as text and means nothing in PostgreSQL", () => {
        expect(dataChangeFor(col("ROWID", "text"))).toMatchObject({ effect: "kept", status: "changed", summary: expect.stringContaining("means nothing in PostgreSQL") });
    });

    it("a type with no PostgreSQL form is not copied", () => {
        expect(dataChangeFor(col("XMLTYPE", ""))).toMatchObject({ effect: "dropped", status: "risk", read: "not read", load: "not loaded" });
        expect(dataChangeFor(col("INTERVAL DAY(2) TO SECOND(6)", "interval"))).toMatchObject({ effect: "dropped", status: "risk" });
    });

    it("says the read expression the copy runs, not a description of it", () => {
        for (const [oracleType, pgType] of [["DATE", "timestamp(0)"], ["DATE", "date"], ["TIMESTAMP(3)", "timestamp(3)"], ["TIMESTAMP(6) WITH TIME ZONE", "timestamptz(6)"]] as const) {
            const shape = col(oracleType, pgType, "SOME_COL");
            expect(dataChangeFor(shape).read, `${oracleType} to ${pgType}`).toBe(oracleSelectExpression(shape));
        }
    });
});
