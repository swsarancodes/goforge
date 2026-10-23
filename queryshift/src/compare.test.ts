import { describe, expect, it } from "vitest";
import { compareResults, normalizeCell, parseCsv, parseExpected, type ActualTable, type Category } from "./compare";

const table = (columns: [string, Category][], rows: (string | null)[][], truncated = false): ActualTable => ({ columns: columns.map(([name, category]) => ({ name, category })), rows, truncated });
const expected = (columns: string[], rows: (string | null)[][]) => ({ columns, rows });

describe("compareResults: the challenge defaults", () => {
    it("ignores row order", () => {
        const result = compareResults(expected(["id"], [["1"], ["2"]]), table([["id", "number"]], [["2"], ["1"]]));
        expect(result.passed).toBe(true);
    });

    it("keeps duplicates: the same row twice is not the same as once", () => {
        const once = compareResults(expected(["id"], [["1"], ["1"]]), table([["id", "number"]], [["1"]]));
        expect(once.passed).toBe(false);
        expect(once.missingCount).toBe(1);
        const extra = compareResults(expected(["id"], [["1"]]), table([["id", "number"]], [["1"], ["1"]]));
        expect(extra.passed).toBe(false);
        expect(extra.additionalCount).toBe(1);
    });

    it("treats NULL as equal to NULL only: an empty string is not NULL", () => {
        const nulls = compareResults(expected(["note"], [[null]]), table([["note", "text"]], [[null]]));
        expect(nulls.passed).toBe(true);
        const empty = compareResults(expected(["note"], [[null]]), table([["note", "text"]], [[""]]));
        expect(empty.passed).toBe(false);
        const zero = compareResults(expected(["n"], [[null]]), table([["n", "number"]], [["0"]]));
        expect(zero.passed).toBe(false);
    });

    it("rounds numbers to six decimal places, no further", () => {
        expect(compareResults(expected(["v"], [["64.333333"]]), table([["v", "number"]], [["64.33333333333"]])).passed).toBe(true);
        expect(compareResults(expected(["v"], [["64.333333"]]), table([["v", "number"]], [["64.333334"]])).passed).toBe(false);
        expect(compareResults(expected(["v"], [["100"]]), table([["v", "number"]], [["100.00"]])).passed).toBe(true);
    });

    it("compares column names without regard to case, in order, and by count", () => {
        expect(compareResults(expected(["CUST_ID", "Name"], []), table([["cust_id", "number"], ["name", "text"]], [])).passed).toBe(true);
        const swapped = compareResults(expected(["a", "b"], []), table([["b", "text"], ["a", "text"]], []));
        expect(swapped.passed).toBe(false);
        expect(swapped.columnProblem).toMatch(/Column mismatch/);
        expect(compareResults(expected(["a"], []), table([["a", "text"], ["b", "text"]], [])).passed).toBe(false);
    });
});

describe("compareResults: stricter than the starter pack where it matters", () => {
    it("keeps the time of day of a timestamp", () => {
        const sameDay = compareResults(expected(["at"], [["2026-03-31 16:45:00"]]), table([["at", "timestamp"]], [["2026-03-31 00:00:00"]]));
        expect(sameDay.passed).toBe(false);
        expect(compareResults(expected(["at"], [["2026-03-31 16:45:00"]]), table([["at", "timestamp"]], [["2026-03-31 16:45:00"]])).passed).toBe(true);
    });

    it("reads a date-only reference as midnight for a timestamp, and a midnight timestamp as that date", () => {
        expect(compareResults(expected(["at"], [["2026-03-31"]]), table([["at", "timestamp"]], [["2026-03-31 00:00:00"]])).passed).toBe(true);
        expect(compareResults(expected(["d"], [["2026-03-31 00:00:00"]]), table([["d", "date"]], [["2026-03-31"]])).passed).toBe(true);
    });

    it("compares each value as its column's type: text '007' is not the number 7", () => {
        expect(compareResults(expected(["code"], [["7"]]), table([["code", "text"]], [["007"]])).passed).toBe(false);
        expect(compareResults(expected(["code"], [["007"]]), table([["code", "number"]], [["7"]])).passed).toBe(true);
    });

    it("never equates an interval with a number of days", () => {
        const result = compareResults(expected(["days"], [["14.4375"]]), table([["days", "text"]], [["14 days 10:30:00"]]));
        expect(result.passed).toBe(false);
    });

    it("refuses to pass a result that was cut off", () => {
        const result = compareResults(expected(["id"], [["1"]]), table([["id", "number"]], [["1"]], true));
        expect(result.passed).toBe(false);
        expect(result.message).toMatch(/cut off/);
    });
});

describe("compareResults: order-sensitive cases", () => {
    const ranked = expected(["id"], [["1"], ["2"], ["3"]]);
    it("passes the same sequence", () => expect(compareResults(ranked, table([["id", "number"]], [["1"], ["2"], ["3"]]), { orderSensitive: true }).passed).toBe(true));
    it("names the first position that differs when only the order is wrong", () => {
        const result = compareResults(ranked, table([["id", "number"]], [["1"], ["3"], ["2"]]), { orderSensitive: true });
        expect(result.passed).toBe(false);
        expect(result.orderProblem).toMatch(/row 2/);
        expect(compareResults(ranked, table([["id", "number"]], [["1"], ["3"], ["2"]])).passed).toBe(true);
    });
});

describe("normalizeCell", () => {
    it("makes a cell that cannot be read as its type something nothing else equals", () => {
        expect(normalizeCell("abc", "number")).not.toBe(normalizeCell("abc", "number") + "x");
        expect(normalizeCell("abc", "number")).toContain("unparseable");
        expect(normalizeCell("", "number")).toContain("unparseable");
        expect(normalizeCell("not a date", "date")).toContain("unparseable");
    });
    it("does not let -0 differ from 0", () => expect(normalizeCell("-0.0000001", "number")).toBe(normalizeCell("0", "number")));
    it("reads booleans as PostgreSQL prints them", () => {
        expect(normalizeCell("t", "boolean")).toBe(normalizeCell("true", "boolean"));
        expect(normalizeCell("f", "boolean")).not.toBe(normalizeCell("t", "boolean"));
    });
});

describe("CSV", () => {
    it("reads quotes, doubled quotes, commas and line breaks inside quotes, CRLF, and a missing final newline", () => {
        expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z')).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["two\nlines", "z"]]);
    });
    it("turns an empty cell into NULL and rejects a ragged row", () => {
        expect(parseExpected("a,b\n1,\n").rows).toEqual([["1", null]]);
        expect(() => parseExpected("a,b\n1\n")).toThrow(/row 1 has 1 values/);
        expect(() => parseExpected("")).toThrow(/empty/);
    });
});
