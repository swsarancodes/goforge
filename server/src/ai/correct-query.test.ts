import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCorrectionInstructions, correctQueryRequestSchema, correctQueryResultSchema, createQueryCorrection } from "./correct-query.js";
import { installOpenAiBackend, type ModelRequest } from "./openai.js";
import { DEFAULT_SETTINGS } from "./policy.js";
import { installAiStores } from "./provider.js";

const request = correctQueryRequestSchema.parse({
    legacySql: "SELECT NVL(a, 0) FROM t",
    sourceDialect: "oracle",
    schema: { tables: [{ name: "t", columns: [{ name: "a", type: "integer" }] }] },
    previousSql: "SELECT a FROM t",
    attempt: 2,
    maxAttempts: 3,
    evidence: { kind: "mismatch", message: "1 expected row(s) missing", expectedColumns: ["a"], missingRows: [["0"]], missingCount: 1 },
});

const seen: ModelRequest[] = [];
const stub = (output: unknown) => {
    seen.length = 0;
    installOpenAiBackend({
        credentials: async () => ({ found: true, source: "OPENAI_API_KEY" }),
        respond: async (modelRequest) => {
            seen.push(modelRequest);
            return { text: typeof output === "string" ? output : JSON.stringify(output), inputTokens: null, outputTokens: null, stopReason: "end_turn" };
        },
        listModels: async () => [],
    });
};

beforeEach(() => {
    installAiStores({ settings: { read: () => ({ settings: { ...DEFAULT_SETTINGS, model: "test-model" } }), write: () => undefined }, audit: { record: () => 1, list: () => [], get: () => undefined } });
});
afterEach(() => installOpenAiBackend());

describe("correction request and result", () => {
    it("applies defaults and refuses an attempt number outside the budget range or more than 20 evidence rows", () => {
        expect(request.engineWarnings).toEqual([]);
        expect(request.evidence.unexpectedRows).toEqual([]);
        expect(request.evidence.staticFindings).toEqual([]);
        expect(correctQueryRequestSchema.safeParse({ ...request, attempt: 0 }).success).toBe(false);
        expect(correctQueryRequestSchema.safeParse({ ...request, evidence: { ...request.evidence, missingRows: Array.from({ length: 21 }, () => ["x"]) } }).success).toBe(false);
    });

    it("tolerates a messy answer but requires sql", () => {
        const parsed = correctQueryResultSchema.parse({ sql: " SELECT 1 ", explanation: 7, changes: ["a", null, 3], risks: "none", extra: true });
        expect(parsed).toEqual({ sql: "SELECT 1", explanation: "", changes: ["a"], risks: [] });
        expect(correctQueryResultSchema.safeParse({ explanation: "no sql" }).success).toBe(false);
    });
});

describe("instructions", () => {
    it("say how many corrections remain, that the evidence is measured, and forbid writing the evidence back as SQL", () => {
        const text = buildCorrectionInstructions(request);
        expect(text).toMatch(/correction 2 of at most 3/);
        expect(text).toMatch(/measurement, not an opinion/);
        expect(text).toMatch(/NEVER write the expected rows/);
        expect(text).toMatch(/exactly the column names/);
        expect(text).toMatch(/staticFindings.*suspects, not proof/);
    });
});

describe("createQueryCorrection", () => {
    it("sends the evidence and the previous query, asks in structured form, and returns the validated answer", async () => {
        stub({ sql: "SELECT COALESCE(a, 0) AS a FROM t", explanation: "NVL", changes: ["NVL to COALESCE"], risks: [] });
        const { result, model } = await createQueryCorrection(request);
        expect(result.sql).toMatch(/COALESCE/);
        expect(model).toBe("test-model");
        const input = JSON.parse(String(seen[0].input));
        expect(input.previousQuery).toBe("SELECT a FROM t");
        expect(input.evidence.missingRows).toEqual([["0"]]);
        expect(input.evidence.staticFindings).toEqual([]);
        expect(seen[0].format?.name).toBe("correct_query");
    });

    it("rejects an answer without sql with a message a person can read", async () => {
        stub({ explanation: "I could not" });
        await expect(createQueryCorrection(request)).rejects.toThrow(/invalid correction: sql/);
    });
});
