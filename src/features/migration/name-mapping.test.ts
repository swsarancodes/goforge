import { describe, expect, it } from "vitest";
import type { MigrationPlanPreview } from "@/lib/migrations-api";
import { applyMapping } from "@/features/query-modernizer/engine/mapping-apply";
import { defaultProofQuery, mappingFromPlan } from "./name-mapping";

const column = (name: string, pgName: string, edited: ("name" | "type" | "default")[] = []) => ({ oracleName: name, pgName, oracleType: "X", pgType: "y", nullable: true, pgDefault: null, note: { status: "exact" as const, text: "t" }, edited, oracleDefault: null });
const plan: MigrationPlanPreview = {
    tables: [
        { oracleName: "CLM", pgName: "claim", renamed: true, rows: 160, oraclePrimaryKey: ["ID"], columns: [column("ID", "id"), column("AMT", "amount", ["name"])] },
        { oracleName: "CUST", pgName: "cust", renamed: false, rows: 40, oraclePrimaryKey: [], columns: [column("CUST_ID", "cust_id")] },
    ],
    problems: [],
    editProblems: [],
    notCarried: [],
    behaviour: [],
    statements: 2,
};

describe("the names a query is rewritten to", () => {
    it("lists every column of a table that has a name of its own, and leaves untouched tables out", () => {
        expect(mappingFromPlan(plan)).toEqual([
            { sourceTable: "CLM", sourceColumn: "ID", targetTable: "claim", targetColumn: "id" },
            { sourceTable: "CLM", sourceColumn: "AMT", targetTable: "claim", targetColumn: "amount" },
        ]);
        expect(mappingFromPlan({ ...plan, tables: [plan.tables[1]] })).toEqual([]);
    });

    it("rewrites a legacy query so it runs on the renamed tables, keeping the output name of a renamed column", () => {
        const rewritten = applyMapping("SELECT c.ID, c.AMT FROM CLM c WHERE c.AMT > 5 ORDER BY c.ID", mappingFromPlan(plan));
        expect(rewritten.issues).toEqual([]);
        expect(rewritten.sql).toMatch(/FROM claim c/);
        expect(rewritten.sql).toMatch(/c\.amount AS AMT/);
        expect(rewritten.sql).toMatch(/WHERE c\.amount > 5/);
    });
});

describe("the query the proof starts from", () => {
    it("reads up to 100 rows of the biggest table in a fixed order", () => {
        expect(defaultProofQuery(plan)).toBe("SELECT * FROM CLM ORDER BY ID FETCH FIRST 100 ROWS ONLY");
        expect(defaultProofQuery({ ...plan, tables: [plan.tables[1]] })).toBe("SELECT * FROM CUST FETCH FIRST 100 ROWS ONLY");
        expect(defaultProofQuery({ ...plan, tables: [] })).toBe("");
    });
    it("quotes a name that is not a plain upper-case identifier", () => {
        const mixed = { ...plan, tables: [{ ...plan.tables[0], oracleName: "Claim Rows", oraclePrimaryKey: ["Row Id"] }] };
        expect(defaultProofQuery(mixed)).toBe('SELECT * FROM "Claim Rows" ORDER BY "Row Id" FETCH FIRST 100 ROWS ONLY');
    });
});
