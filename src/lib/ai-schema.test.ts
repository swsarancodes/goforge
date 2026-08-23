import { describe, expect, it } from "vitest";

import { DatabaseDialect } from "@/lib/database";
import { Cardinality } from "@/lib/schemas/relationship-schema";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { getDataTypes } from "@/test/fixtures/data-types";
import { AiPlanValidationError, AiSchemaPlan, applyAiSchemaPlan, buildAiSchemaContext, validateAiPlanScope } from "./ai-schema";

const dataTypes = getDataTypes(DatabaseDialect.POSTGRES);

const plan = (operations: AiSchemaPlan["operations"]): AiSchemaPlan => ({
    summary: "Test plan",
    assumptions: [],
    warnings: [],
    clarifyingQuestions: [],
    operations,
});

describe("AI schema plan compiler", () => {
    it("creates a typed table and index without mutating the current database", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const result = applyAiSchemaPlan(current, plan([
            {
                type: "create_table",
                table: {
                    name: "projects",
                    fields: [
                        { name: "id", dataType: "integer", primaryKey: true, nullable: false },
                        { name: "slug", dataType: "varchar", nullable: false, maxLength: 120 },
                    ],
                    indexes: [{ name: "projects_slug_unique", columns: ["slug"], unique: true }],
                },
            },
        ]), dataTypes);

        expect(current.tables).toHaveLength(2);
        expect(result.database.tables).toHaveLength(3);
        const projects = result.database.tables.find((table) => table.name === "projects");
        expect(projects?.fields[0].type?.name?.toLowerCase()).toBe("integer");
        expect(projects?.indices[0].fieldIndices[0].fieldId).toBe(projects?.fields[1].id);
        expect(result.database.numOfTables).toBe(3);
    });

    it("applies sequential column and relationship operations", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const result = applyAiSchemaPlan(current, plan([
            {
                type: "create_table",
                table: {
                    name: "comments",
                    fields: [
                        { name: "id", dataType: "integer", primaryKey: true, nullable: false },
                        { name: "user_id", dataType: "integer", nullable: false },
                    ],
                },
            },
            {
                type: "add_relationship",
                relationship: {
                    sourceTable: "users",
                    sourceColumn: "id",
                    targetTable: "comments",
                    targetColumn: "user_id",
                    cardinality: Cardinality.one_to_many,
                },
            },
        ]), dataTypes);

        const relationship = result.database.relationships.at(-1);
        expect(relationship?.sourceTable.name).toBe("users");
        expect(relationship?.targetTable.name).toBe("comments");
        expect(relationship?.targetField.name).toBe("user_id");
    });

    it("renames and alters a column while preserving its stable id", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const originalId = current.tables[0].fields.find((field) => field.name === "status")?.id;
        const result = applyAiSchemaPlan(current, plan([
            {
                type: "alter_column",
                tableName: "users",
                columnName: "status",
                changes: { newName: "account_status", nullable: true, maxLength: 40 },
            },
        ]), dataTypes);

        const field = result.database.tables[0].fields.find((candidate) => candidate.name === "account_status");
        expect(field?.id).toBe(originalId);
        expect(field?.nullable).toBe(true);
        expect(field?.maxLength).toBe(40);
    });

    it("cascades relationships when dropping a referenced column and reports it", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const result = applyAiSchemaPlan(current, plan([
            { type: "drop_column", tableName: "posts", columnName: "user_id" },
        ]), dataTypes);

        expect(result.database.relationships).toHaveLength(0);
        expect(result.warnings.join(" ")).toContain("removes 1 relationship");
    });

    it("rejects unsupported data types before producing a database diff", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);
        expect(() => applyAiSchemaPlan(current, plan([
            {
                type: "add_column",
                tableName: "users",
                field: { name: "mystery", dataType: "definitely_not_a_real_type" },
            },
        ]), dataTypes)).toThrow(AiPlanValidationError);
    });

    it("serializes metadata without row data or credentials", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);
        current.relationships[0].onDelete = null;
        current.relationships[0].onUpdate = null;
        const context = buildAiSchemaContext("Add an audit table", current, dataTypes, ["users"]);

        expect(context.tables[0].fields[0]).toMatchObject({ name: "id", dataType: "integer" });
        expect(context.selectedTables).toEqual(["users"]);
        expect(context.scope).toBe("selected_tables");
        expect(context.relationships[0]).not.toHaveProperty("onDelete");
        expect(context.relationships[0]).not.toHaveProperty("onUpdate");
        expect(JSON.stringify(context)).not.toMatch(/password|connectionString|rows/i);
    });

    it("blocks operations outside selected-table scope", () => {
        expect(() => validateAiPlanScope(plan([
            { type: "add_column", tableName: "posts", field: { name: "archived_at", dataType: "timestamp" } },
        ]), ["users"])).toThrow(/outside the selected scope/i);
    });

    it("allows operations limited to selected tables", () => {
        expect(() => validateAiPlanScope(plan([
            { type: "add_index", tableName: "users", index: { name: "users_email_idx", columns: ["email"] } },
        ]), ["users"])).not.toThrow();
    });
});
