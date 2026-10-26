import { describe, expect, it } from "vitest";
import { differingRows } from "./differences";

describe("which rows of two results have no counterpart", () => {
    it("finds none when every row has an equal one, whatever the number or date is written like", () => {
        const left = [["1", "100", "2026-01-01 00:00:00", null], ["2", "0.5", "2026-01-02 00:00:00", ""]];
        const right = [["1", "100.00", "2026-01-01", ""], ["2", "0.50", "2026-01-02 00:00:00", null]];
        expect(differingRows(left, right, false)).toEqual({ left: new Set(), right: new Set() });
        expect(differingRows(left, right, true)).toEqual({ left: new Set(), right: new Set() });
    });

    it("by position, marks the row where the values differ and any row one side has beyond the other", () => {
        const result = differingRows([["1", "a"], ["2", "b"], ["3", "c"]], [["1", "a"], ["2", "X"]], false);
        expect([[...result.left], [...result.right]]).toEqual([[1, 2], [1]]);
    });

    it("by value, ignores the order, counts duplicates, and marks what has no equal on the other side", () => {
        const result = differingRows([["a"], ["b"], ["b"], ["c"]], [["c"], ["b"], ["a"], ["z"]], true);
        expect([...result.left]).toEqual([2]);
        expect([...result.right]).toEqual([3]);
    });

    it("marks every row of a result when the other is empty", () => {
        expect(differingRows([["a"], ["b"]], [], true)).toEqual({ left: new Set([0, 1]), right: new Set() });
        expect(differingRows([], [["a"]], false)).toEqual({ left: new Set(), right: new Set([0]) });
    });
});
