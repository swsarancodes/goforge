import { describe, expect, it } from "vitest";
import type { ConversionStatus, MigrationPlanPreview } from "@/lib/migrations-api";
import { summarize } from "./migration-checklist";

const column = (name: string, status: ConversionStatus) => ({ oracleName: name, pgName: name.toLowerCase(), oracleType: "X", pgType: "y", nullable: true, pgDefault: null, note: { status, text: "t" } });
const plan = (...tables: ConversionStatus[][]): MigrationPlanPreview => ({
    tables: tables.map((statuses, at) => ({ oracleName: `T${at}`, pgName: `t${at}`, rows: 1, oraclePrimaryKey: [], columns: statuses.map((status, c) => column(`C${c}`, status)) })),
    problems: [],
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
