import { describe, expect, it } from "vitest";
import { formatRows } from "./format-rows";

describe("formatRows", () => {
    const columns = [{ dataType: "integer" }, { dataType: "jsonb" }, { dataType: "text" }];

    it("formats each cell by its column's type", () => {
        const [row] = formatRows(columns, [["42", '{"a": 1}', null]]);
        expect(row.map((cell) => cell.cell.kind)).toEqual(["number", "json", "null"]);
        expect(row[0].cell.align).toBe("right");
        expect(row[1].cell.display).toBe('{"a":1}');
    });

    it("marks the cells the server truncated", () => {
        const rows = formatRows(columns, [["1", "{}", "a"], ["2", "{}", "b"]], [[1, 2]]);
        expect(rows.map((row) => row.map((cell) => cell.truncated))).toEqual([
            [false, false, false],
            [false, false, true],
        ]);
    });

    it("handles no rows and no truncation info", () => {
        expect(formatRows(columns, [])).toEqual([]);
        expect(formatRows(columns, [["1", "{}", "a"]])[0].every((cell) => !cell.truncated)).toBe(true);
    });
});
