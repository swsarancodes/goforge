import { describe, expect, it } from "vitest";
import type { ConversionStatus, MigrationPlanPreview } from "@/lib/migrations-api";
import { checkSentence, summarize } from "./migration-checklist";

const column = (name: string, status: ConversionStatus) => ({ oracleName: name, pgName: name.toLowerCase(), oracleType: "X", pgType: "y", nullable: true, pgDefault: null, note: { status, text: "t" }, edited: [] as ("name" | "type" | "default")[], oracleDefault: null });
const plan = (...tables: ConversionStatus[][]): MigrationPlanPreview => ({
    tables: tables.map((statuses, at) => ({ oracleName: `T${at}`, pgName: `t${at}`, renamed: false, rows: 1, oraclePrimaryKey: [], columns: statuses.map((status, c) => column(`C${c}`, status)) })),
    problems: [],
    editProblems: [],
    notCarried: [],
    behaviour: [],
    statements: 1,
});

describe("the checklist's counts", () => {
    it("counts every column of every table by how its values fare", () => {
        expect(summarize(plan(["exact", "exact", "changed"], ["risk", "exact"]))).toEqual({ exact: 3, changed: 1, risk: 1, columns: 5 });
    });
    it("counts nothing for a schema with no tables", () => {
        expect(summarize(plan())).toEqual({ exact: 0, changed: 0, risk: 0, columns: 0 });
    });
});

describe("what a check says", () => {
    it("says how many values a change would touch, none, or that the check could not run", () => {
        expect(checkSentence({ description: "values with a time of day", sql: "x", count: 3 })).toBe("Checked on your data: 3 values affected (values with a time of day).");
        expect(checkSentence({ description: "values with a time of day", sql: "x", count: 1 })).toBe("Checked on your data: 1 value affected (values with a time of day).");
        expect(checkSentence({ description: "values with a time of day", sql: "x", count: 0 })).toBe("Checked on your data: no value is affected (values with a time of day).");
        expect(checkSentence({ description: "d", sql: "x", count: null, error: "ORA-00942: table does not exist" })).toBe("Could not be checked on your data (ORA-00942: table does not exist).");
    });
});
