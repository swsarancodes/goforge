import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaPlan } from "../services/schema-plan-client.js";
import { installOpenAiBackend, type ModelRequest } from "./openai.js";
import { DEFAULT_SETTINGS } from "./policy.js";
import { installAiStores } from "./provider.js";
import { buildModernizeInstructions, createQueryModernization, modernizeQueryRequestSchema, modernizeQueryResultSchema } from "./modernize-query.js";

const request = modernizeQueryRequestSchema.parse({
    legacySql: "SELECT NVL(a, 0) FROM t WHERE ROWNUM <= 5",
    sourceDialect: "oracle",
    schema: { tables: [{ name: "t", columns: [{ name: "a", type: "integer" }] }] },
    draft: { sql: "SELECT COALESCE(a, 0) FROM t WHERE ROWNUM <= 5", changes: ["NVL → COALESCE"], notConverted: [{ construct: "ROWNUM <= 5", reason: "left in place" }], postgresError: 'column "rownum" does not exist' },
});

const seen: ModelRequest[] = [];

/** Makes the model answer with this value (as JSON text) through a stand-in OpenAI. */
function stubModel(output: unknown) {
    seen.length = 0;
    installOpenAiBackend({
        credentials: async () => ({ found: true, source: "OPENAI_API_KEY" }),
        respond: async (modelRequest) => {
            seen.push(modelRequest);
            return { text: typeof output === "string" ? output : JSON.stringify(output), inputTokens: null, outputTokens: null, stopReason: "end_turn" };
        },
        listModels: async () => [],
    });
}

beforeEach(() => {
    installAiStores({ settings: { read: () => ({ settings: { ...DEFAULT_SETTINGS, model: "test-model" } }), write: () => undefined }, audit: { record: () => 1, list: () => [], get: () => undefined } });
});
afterEach(() => {
    installOpenAiBackend();
});

describe("modernize request and result schemas", () => {
    it("accepts a request with and without schema/draft, and rejects unknown dialects or empty SQL", () => {
        expect(modernizeQueryRequestSchema.safeParse({ legacySql: "SELECT 1", sourceDialect: "db2" }).success).toBe(true);
        expect(modernizeQueryRequestSchema.safeParse({ legacySql: "  ", sourceDialect: "oracle" }).success).toBe(false);
        expect(modernizeQueryRequestSchema.safeParse({ legacySql: "SELECT 1", sourceDialect: "cobol" }).success).toBe(false);
        // PostgreSQL is the only target, so there is nothing to choose
        expect(modernizeQueryRequestSchema.safeParse({ legacySql: "SELECT 1", sourceDialect: "sqlite" }).success).toBe(false);
    });

    it("tolerates a messy model answer: stray keys and non-string list items", () => {
        const parsed = modernizeQueryResultSchema.parse({
            sql: "  SELECT 1  ",
            summary: 42,
            changes: ["NVL -> COALESCE", null, { oops: true }, "  "],
            risks: "not a list",
            extra: "ignored",
            indexSuggestions: [{ tableName: "t", columns: ["a"], reason: "filter" }],
        });
        expect(parsed.sql).toBe("SELECT 1");
        expect(parsed.summary).toBe("");
        expect(parsed.changes).toEqual(["NVL -> COALESCE"]);
        expect(parsed.risks).toEqual([]);
        expect("extra" in parsed).toBe(false);
        // index advice comes from the engine's checks against the real tables, not from the model
        expect("indexSuggestions" in parsed).toBe(false);
    });

    it("requires converted SQL", () => {
        expect(modernizeQueryResultSchema.safeParse({ summary: "x" }).success).toBe(false);
        expect(modernizeQueryResultSchema.safeParse({ sql: "" }).success).toBe(false);
    });
});

describe("buildModernizeInstructions", () => {
    it("names both dialects, demands JSON only and forbids inventing objects or data", () => {
        const text = buildModernizeInstructions(request);
        expect(text).toContain("Oracle");
        expect(text).toContain("PostgreSQL 16");
        expect(text).toMatch(/JSON only/);
        expect(text).toMatch(/Never invent tables, columns/);
        expect(text).toMatch(/same rows, columns, ordering/);
        expect(text).toMatch(/rule-based draft/);
        expect(text).toMatch(/check your answer/);
        expect(text).toMatch(/Do not claim the result is equivalent/);
    });
});

describe("createQueryModernization", () => {
    it("sends the query, dialects, schema and rule draft, and returns the validated conversion", async () => {
        stubModel({
            sql: "SELECT COALESCE(a, 0) FROM t ORDER BY a LIMIT 5",
            summary: "Converted NVL and ROWNUM.",
            changes: ["NVL -> COALESCE", "ROWNUM -> LIMIT"],
            risks: ["ROWNUM applied before ORDER BY in Oracle"],
            unsupported: [],
        });

        const { result, model } = await createQueryModernization(request);

        expect(model).toBe("test-model");
        expect(result.sql).toContain("LIMIT 5");
        expect(result.risks).toEqual(["ROWNUM applied before ORDER BY in Oracle"]);
        expect(seen[0]).toMatchObject({ model: "test-model" });
        // the answer is asked for in the shape the result schema describes, and the schema is part of what is sent
        expect(seen[0].format).toMatchObject({ name: "modernize_query", schema: { type: "object", required: ["sql", "summary", "changes", "risks", "unsupported"], additionalProperties: false } });
        const input = JSON.parse(seen[0].input);
        expect(input).toMatchObject({ originalQuery: request.legacySql, sourceDialect: "oracle", targetDialect: "postgresql" });
        expect(input.schema.tables[0].name).toBe("t");
        expect(input.ruleBasedDraft.notConverted).toEqual([{ construct: "ROWNUM <= 5", reason: "left in place" }]);
        expect(input.ruleBasedDraft.postgresError).toBe('column "rownum" does not exist');
    });

    it("rejects an answer without SQL", async () => {
        stubModel({ summary: "I could not do it" });
        await expect(createQueryModernization(request)).rejects.toThrow(/invalid conversion/);
    });
});

describe("createSchemaPlan (the diagram's AI Schema)", () => {
    it("still returns a validated plan", async () => {
        stubModel({ summary: "Add a table", assumptions: [], warnings: [], clarifyingQuestions: [], operations: [{ type: "add_index", tableName: "t", index: { name: "i", columns: ["a"] } }] });
        const { plan, model } = await createSchemaPlan({
            prompt: "index a",
            scope: "database",
            dialect: "postgresql",
            databaseName: "d",
            tables: [],
            relationships: [],
            allowedDataTypes: ["integer"],
        } as never);
        expect(model).toBe("test-model");
        expect(plan.operations).toHaveLength(1);
    });
});
