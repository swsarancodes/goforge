import { describe, expect, it } from "vitest";
import { compareOutput, parseExpectedOutput } from "./compare-output";
import { oracleResultToText } from "./oracle-reference";

describe("oracleResultToText", () => {
    it("writes the column names first, tab separated, and NULL as nothing", () => {
        expect(oracleResultToText([{ name: "CUST_ID" }, { name: "EMAIL" }], [["1", "a@example.com"], ["2", null]])).toBe("CUST_ID\tEMAIL\n1\ta@example.com\n2\t");
    });

    it("keeps a value that has a tab or a line break in it on its own row", () => {
        expect(oracleResultToText([{ name: "NOTE" }], [["line one\nline two\tcell"]])).toBe("NOTE\nline one line two cell");
    });

    it("round-trips through the output check: what Oracle returned, compared with itself, matches, and a changed value does not", () => {
        const columns = [{ name: "ID" }, { name: "AMT" }, { name: "WHEN_AT" }, { name: "NOTE" }];
        const rows = [["1", ".5", "2026-03-31 16:45:00", null], ["2", "100", "2026-01-01 00:00:00", "x"]];
        const expected = parseExpectedOutput(oracleResultToText(columns, rows));
        expect("error" in expected).toBe(false);
        if ("error" in expected) return;
        const actual = (cells: (string | null)[][]) => ({ columns: ["id", "amt", "when_at", "note"], rows: cells, truncated: false });
        // PostgreSQL writes the same numbers and dates differently; they are the same values
        expect(compareOutput(expected, actual([["1", "0.50", "2026-03-31 16:45:00", null], ["2", "100.00", "2026-01-01 00:00:00", "x"]]), { ignoreOrder: false }).matches).toBe(true);
        expect(compareOutput(expected, actual([["1", "0.50", "2026-03-31 00:00:00", null], ["2", "100.00", "2026-01-01 00:00:00", "x"]]), { ignoreOrder: false }).matches).toBe(false);
    });

    it("handles a result with no rows", () => {
        expect(oracleResultToText([{ name: "N" }], [])).toBe("N");
    });
});
