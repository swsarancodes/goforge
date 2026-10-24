import { describe, expect, it } from "vitest";
import { diffLines } from "./line-diff";

describe("diffLines", () => {
    it("marks unchanged, removed and added lines", () => {
        expect(diffLines("SELECT a\nFROM t\nWHERE x = 1", "SELECT a\nFROM t\nWHERE x = 2\nLIMIT 5")).toEqual([
            { type: "same", text: "SELECT a" },
            { type: "same", text: "FROM t" },
            { type: "removed", text: "WHERE x = 1" },
            { type: "added", text: "WHERE x = 2" },
            { type: "added", text: "LIMIT 5" },
        ]);
    });

    it("ignores indentation when matching lines", () => {
        expect(diffLines("SELECT a\n   FROM t", "SELECT a\nFROM t").every((line) => line.type === "same")).toBe(true);
    });

    it("handles empty and identical input", () => {
        expect(diffLines("", "")).toEqual([{ type: "same", text: "" }]);
        expect(diffLines("a", "a")).toEqual([{ type: "same", text: "a" }]);
        expect(diffLines("a", "")).toEqual([{ type: "removed", text: "a" }, { type: "added", text: "" }]);
    });

    it("falls back to remove-all / add-all for huge inputs instead of hanging", () => {
        const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
        const result = diffLines(big, big + "\nmore");
        expect(result.some((line) => line.type === "same")).toBe(false);
    });
});
