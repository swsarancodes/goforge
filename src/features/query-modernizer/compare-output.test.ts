import { describe, expect, it } from "vitest";
import { compareOutput, normalizeCell, parseExpectedOutput, type ActualOutput } from "./compare-output";

const actual = (columns: string[], rows: (string | null)[][], truncated = false): ActualOutput => ({ columns, rows, truncated });
const parsed = (text: string) => {
    const result = parseExpectedOutput(text);
    if ("error" in result) throw new Error(result.error);
    return result;
};

describe("parseExpectedOutput", () => {
    it("reads rows copied from a grid (tab separated)", () => {
        expect(parsed("ID\tNAME\n1\tAnn\n2\tBo")).toEqual({ columns: ["ID", "NAME"], rows: [["1", "Ann"], ["2", "Bo"]] });
    });

    it("reads SQL*Plus and psql tables, dropping the rulers and the row-count footer", () => {
        const sqlplus = " ID | NAME\n----+-----\n  1 | Ann\n  2 | Bo\n(2 rows)\n";
        expect(parsed(sqlplus)).toEqual({ columns: ["ID", "NAME"], rows: [["1", "Ann"], ["2", "Bo"]] });
        expect(parsed("| ID | NAME |\n+----+------+\n| 1 | Ann |\n\n2 rows selected.")).toEqual({ columns: ["ID", "NAME"], rows: [["1", "Ann"]] });
    });

    it("reads CSV, with quoted commas and doubled quotes", () => {
        expect(parsed('id,note\n1,"a, b"\n2,"say ""hi"""')).toEqual({ columns: ["id", "note"], rows: [["1", "a, b"], ["2", 'say "hi"']] });
    });

    it("says what is wrong instead of guessing", () => {
        expect(parseExpectedOutput("")).toMatchObject({ error: expect.stringMatching(/Paste the rows/) });
        expect(parseExpectedOutput("a,b\n1,2,3")).toMatchObject({ error: expect.stringMatching(/Row 1 has 3 values but there are 2 columns/) });
        expect(parseExpectedOutput("no rows selected.")).toMatchObject({ error: expect.any(String) });
    });
});

describe("normalizeCell", () => {
    it("treats every spelling of NULL, including Oracle's empty string, as one thing", () => {
        for (const text of ["", "  ", "NULL", "null", "(null)", "[NULL]", "<null>", null, undefined]) expect(normalizeCell(text as string | null), String(text)).toBeNull();
    });

    it("compares numbers by value", () => {
        expect(normalizeCell("100")).toBe(normalizeCell("100.00"));
        expect(normalizeCell("1.5")).toBe(normalizeCell("1.50"));
        expect(normalizeCell("1e3")).toBe(normalizeCell("1000"));
        expect(normalizeCell("0.1")).not.toBe(normalizeCell("0.2"));
        expect(normalizeCell("007")).toBe(normalizeCell("7"));
    });

    it("compares dates by value, whatever the layout", () => {
        const same = ["2024-01-15", "2024-01-15 00:00:00", "2024-01-15T00:00:00.000Z", "2024-01-15 00:00:00.000", "15-JAN-24", "15-Jan-2024", "15-JAN-24 00:00:00", "2024-01-15 00:00:00+00"];
        for (const text of same) expect(normalizeCell(text), text).toBe(normalizeCell("2024-01-15"));
        expect(normalizeCell("2024-01-15 10:30:00")).not.toBe(normalizeCell("2024-01-15"));
        expect(normalizeCell("2024-01-15 10:30:00.5")).not.toBe(normalizeCell("2024-01-15 10:30:00"));
        expect(normalizeCell("15-JAN-75")).toBe(normalizeCell("1975-01-15"));
    });

    it("keeps text as it is, apart from the edges", () => {
        expect(normalizeCell(" Ann ")).toBe(normalizeCell("Ann"));
        expect(normalizeCell("Ann")).not.toBe(normalizeCell("ann"));
        expect(normalizeCell("1,000")).toBe("s:1,000");
    });
});

describe("compareOutput", () => {
    const expected = parsed("ID\tNAME\tHIRED\n1\tAnn\t15-JAN-24\n2\tBo\t");

    it("matches when the values are the same however they are written", () => {
        const result = compareOutput(expected, actual(["id", "name", "hired"], [["1.00", "Ann", "2024-01-15 00:00:00"], ["2", "Bo", null]]), { ignoreOrder: false });
        expect(result).toMatchObject({ matches: true, expectedRows: 2, actualRows: 2, differences: [], missing: [], extra: [] });
        expect(result.columnProblem).toBeUndefined();
    });

    it("names the cell that differs", () => {
        const result = compareOutput(expected, actual(["id", "name", "hired"], [["1", "Ann", "2024-01-15"], ["2", "Bob", null]]), { ignoreOrder: false });
        expect(result.matches).toBe(false);
        expect(result.differences).toEqual([{ row: 2, column: "NAME", expected: "Bo", actual: "Bob" }]);
    });

    it("shows NULL against an empty string as the same, and NULL against a value as different", () => {
        const empty = parsed("A\n\nx");
        expect(compareOutput(empty, actual(["a"], [[null], ["x"]]), { ignoreOrder: false }).matches).toBe(true);
        expect(compareOutput(empty, actual(["a"], [["y"], ["x"]]), { ignoreOrder: false }).differences[0]).toMatchObject({ expected: "(empty)", actual: "y" });
    });

    it("reports rows the other side lacks, in order", () => {
        const fewer = compareOutput(expected, actual(["id", "name", "hired"], [["1", "Ann", "2024-01-15"]]), { ignoreOrder: false });
        expect(fewer).toMatchObject({ matches: false, expectedRows: 2, actualRows: 1 });
        expect(fewer.missing).toEqual([["2", "Bo", ""]]);
        const more = compareOutput(expected, actual(["id", "name", "hired"], [["1", "Ann", "2024-01-15"], ["2", "Bo", null], ["3", "Cy", null]]), { ignoreOrder: false });
        expect(more.extra).toEqual([["3", "Cy", "NULL"]]);
    });

    it("can ignore the order of rows, and still finds a missing and an extra row", () => {
        const shuffled = actual(["id", "name", "hired"], [["2", "Bo", null], ["1", "Ann", "2024-01-15"]]);
        expect(compareOutput(expected, shuffled, { ignoreOrder: false }).matches).toBe(false);
        expect(compareOutput(expected, shuffled, { ignoreOrder: true }).matches).toBe(true);

        const different = compareOutput(expected, actual(["id", "name", "hired"], [["2", "Bo", null], ["9", "Zed", null]]), { ignoreOrder: true });
        expect(different.matches).toBe(false);
        expect(different.missing).toEqual([["1", "Ann", "15-JAN-24"]]);
        expect(different.extra).toEqual([["9", "Zed", "NULL"]]);
    });

    it("counts duplicate rows, which a set comparison would hide", () => {
        const twice = parsed("A\n1\n1");
        expect(compareOutput(twice, actual(["a"], [["1"]]), { ignoreOrder: true }).matches).toBe(false);
        expect(compareOutput(twice, actual(["a"], [["1"], ["1"]]), { ignoreOrder: true }).matches).toBe(true);
    });

    it("flags a different column count without comparing rows, and different names while still comparing by position", () => {
        const count = compareOutput(expected, actual(["id", "name"], [["1", "Ann"]]), { ignoreOrder: false });
        expect(count.matches).toBe(false);
        expect(count.columnProblem).toMatch(/3 columns.*PostgreSQL 2/);

        const renamed = compareOutput(parsed("ID\n1"), actual(["customer_id"], [["1"]]), { ignoreOrder: false });
        expect(renamed.columnProblem).toMatch(/Column names differ/);
        expect(renamed.differences).toEqual([]);
        expect(renamed.matches).toBe(true);
    });

    it("only checks the rows that were read when PostgreSQL had more, and says so", () => {
        const long = parsed("N\n1\n2\n3\n4");
        const result = compareOutput(long, actual(["n"], [["1"], ["2"]], true), { ignoreOrder: true });
        expect(result).toMatchObject({ matches: true, partial: true, actualRows: 2 });
        expect(compareOutput(long, actual(["n"], [["1"], ["9"]], true), { ignoreOrder: true }).differences).toEqual([{ row: 2, column: "N", expected: "2", actual: "9" }]);
    });
});
