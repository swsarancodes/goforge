import { describe, expect, it } from "vitest";
import { aiSchemaPlanSchema } from "./schema-plan.js";
import { normalizePlanOutput } from "./plan-normalize.js";

const plan = (...operations: unknown[]) => ({ summary: "s", assumptions: [], warnings: [], clarifyingQuestions: [], operations });
const parse = (...operations: unknown[]) => aiSchemaPlanSchema.parse(normalizePlanOutput(plan(...operations)));

describe("blank defaults from a model that had none to give", () => {
    it("are dropped from a new column, a changed column and a new table's columns", () => {
        const parsed = parse(
            { type: "add_column", tableName: "t", field: { name: "a", dataType: "text", defaultValue: "" } },
            { type: "add_column", tableName: "t", field: { name: "b", dataType: "text", defaultValue: "   " } },
            { type: "alter_column", tableName: "t", columnName: "a", changes: { nullable: false, defaultValue: "" } },
            { type: "create_table", table: { name: "n", fields: [{ name: "id", dataType: "bigint", primaryKey: true, defaultValue: "" }, { name: "x", dataType: "text", defaultValue: "" }] } },
        );
        expect(JSON.stringify(parsed.operations)).not.toContain("defaultValue");
    });

    it("leave a real default, the empty-string literal and a deliberate removal alone", () => {
        const parsed = parse(
            { type: "add_column", tableName: "t", field: { name: "a", dataType: "text", defaultValue: "''" } },
            { type: "add_column", tableName: "t", field: { name: "b", dataType: "integer", defaultValue: "0" } },
            { type: "alter_column", tableName: "t", columnName: "a", changes: { defaultValue: null } },
        );
        const [a, b, c] = parsed.operations as unknown as { field?: { defaultValue?: string }; changes?: { defaultValue?: string | null } }[];
        expect(a.field?.defaultValue).toBe("''");
        expect(b.field?.defaultValue).toBe("0");
        expect(c.changes?.defaultValue).toBeNull();
    });
});
