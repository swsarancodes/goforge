import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callZenJson, createZenSchemaPlan, getZenStatus } from "../services/zen-client.js";
import { buildModernizeInstructions, createZenQueryModernization, modernizeQueryRequestSchema, modernizeQueryResultSchema } from "./modernize-query.js";

const request = modernizeQueryRequestSchema.parse({
    legacySql: "SELECT NVL(a, 0) FROM t WHERE ROWNUM <= 5",
    sourceDialect: "oracle",
    targetDialect: "postgresql",
    schema: { tables: [{ name: "t", columns: [{ name: "a", type: "integer" }] }] },
    draft: { sql: "SELECT COALESCE(a, 0) FROM t WHERE ROWNUM <= 5", issues: ["ROWNUM left in place"] },
});

/** Makes `fetch` answer like the Zen /responses endpoint. */
function stubZen(output: unknown, init: { ok?: boolean; status?: number; raw?: string } = {}) {
    const fetchMock = vi.fn(async () => ({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        text: async () => init.raw ?? JSON.stringify(typeof output === "string" ? { output_text: output } : { output_text: JSON.stringify(output) }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

beforeEach(() => {
    vi.stubEnv("ZEN_API_KEY", "test-key");
    vi.stubEnv("ZEN_MODEL", "test-model");
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe("modernize request and result schemas", () => {
    it("accepts a request with and without schema/draft, and rejects unknown dialects or empty SQL", () => {
        expect(modernizeQueryRequestSchema.safeParse({ legacySql: "SELECT 1", sourceDialect: "db2", targetDialect: "mysql" }).success).toBe(true);
        expect(modernizeQueryRequestSchema.safeParse({ legacySql: "  ", sourceDialect: "oracle", targetDialect: "postgresql" }).success).toBe(false);
        expect(modernizeQueryRequestSchema.safeParse({ legacySql: "SELECT 1", sourceDialect: "cobol", targetDialect: "postgresql" }).success).toBe(false);
        expect(modernizeQueryRequestSchema.safeParse({ legacySql: "SELECT 1", sourceDialect: "oracle", targetDialect: "oracle" }).success).toBe(false);
    });

    it("tolerates a messy model answer: stray keys, non-string list items, bad index entries", () => {
        const parsed = modernizeQueryResultSchema.parse({
            sql: "  SELECT 1  ",
            summary: 42,
            changes: ["NVL -> COALESCE", null, { oops: true }, "  "],
            risks: "not a list",
            extra: "ignored",
            indexSuggestions: [{ tableName: "t", columns: ["a"], reason: "filter" }, { nope: true }, { tableName: "t", columns: [] }],
        });
        expect(parsed.sql).toBe("SELECT 1");
        expect(parsed.summary).toBe("");
        expect(parsed.changes).toEqual(["NVL -> COALESCE"]);
        expect(parsed.risks).toEqual([]);
        expect(parsed.indexSuggestions).toEqual([{ tableName: "t", columns: ["a"], reason: "filter" }]);
        expect("extra" in parsed).toBe(false);
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
    });
});

describe("callZenJson", () => {
    it("sends the key, model and JSON input, and returns the parsed object", async () => {
        const fetchMock = stubZen({ hello: "world" });
        const { output, model } = await callZenJson({ instructions: "be brief", input: { a: 1 } });

        expect(output).toEqual({ hello: "world" });
        expect(model).toBe("test-model");
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
        expect(url).toMatch(/\/responses$/);
        expect(init.headers.Authorization).toBe("Bearer test-key");
        expect(JSON.parse(init.body)).toMatchObject({ model: "test-model", store: false, instructions: "be brief", input: '{"a":1}' });
    });

    it("accepts JSON wrapped in a markdown fence or prose", async () => {
        stubZen('```json\n{"ok": true}\n```');
        await expect(callZenJson({ instructions: "x", input: "y" })).resolves.toMatchObject({ output: { ok: true } });
        stubZen('Sure! {"ok": 1} hope that helps');
        await expect(callZenJson({ instructions: "x", input: "y" })).resolves.toMatchObject({ output: { ok: 1 } });
    });

    it("fails clearly without a key, on API errors, and on non-JSON replies", async () => {
        vi.stubEnv("ZEN_API_KEY", "");
        await expect(callZenJson({ instructions: "x", input: "y" })).rejects.toThrow("ZEN_API_KEY is not configured on the server");

        vi.stubEnv("ZEN_API_KEY", "k");
        stubZen(null, { ok: false, status: 429, raw: JSON.stringify({ error: { message: "rate limited" } }) });
        await expect(callZenJson({ instructions: "x", input: "y" })).rejects.toThrow("rate limited");

        stubZen(null, { raw: "<html>gateway</html>", status: 502 });
        await expect(callZenJson({ instructions: "x", input: "y" })).rejects.toThrow(/non-JSON response \(502\)/);
    });

    it("reports a timeout as such", async () => {
        vi.stubEnv("ZEN_TIMEOUT_MS", "20");
        vi.stubGlobal(
            "fetch",
            vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))),
        );
        await expect(callZenJson({ instructions: "x", input: "y" })).rejects.toThrow("Zen request timed out");
    });
});

describe("getZenStatus", () => {
    it("says whether a key is configured without exposing it", () => {
        expect(getZenStatus()).toEqual({ configured: true, model: "test-model" });
        vi.stubEnv("ZEN_API_KEY", "   ");
        expect(getZenStatus().configured).toBe(false);
        expect(JSON.stringify(getZenStatus())).not.toContain("test-key");
    });
});

describe("createZenQueryModernization", () => {
    it("sends the query, dialects, schema and rule draft, and returns the validated conversion", async () => {
        const fetchMock = stubZen({
            sql: "SELECT COALESCE(a, 0) FROM t ORDER BY a LIMIT 5",
            summary: "Converted NVL and ROWNUM.",
            changes: ["NVL -> COALESCE", "ROWNUM -> LIMIT"],
            risks: ["ROWNUM applied before ORDER BY in Oracle"],
            unsupported: [],
            indexSuggestions: [{ tableName: "t", columns: ["a"], reason: "ORDER BY a" }],
        });

        const { result, model } = await createZenQueryModernization(request);

        expect(model).toBe("test-model");
        expect(result.sql).toContain("LIMIT 5");
        expect(result.indexSuggestions).toHaveLength(1);
        const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
        const input = JSON.parse(body.input);
        expect(input).toMatchObject({ originalQuery: request.legacySql, sourceDialect: "oracle", targetDialect: "postgresql" });
        expect(input.schema.tables[0].name).toBe("t");
        expect(input.ruleBasedDraft.issues).toEqual(["ROWNUM left in place"]);
    });

    it("rejects an answer without SQL", async () => {
        stubZen({ summary: "I could not do it" });
        await expect(createZenQueryModernization(request)).rejects.toThrow(/invalid conversion/);
    });
});

describe("createZenSchemaPlan (unchanged behaviour after the refactor)", () => {
    it("still returns a validated plan", async () => {
        stubZen({ summary: "Add a table", assumptions: [], warnings: [], clarifyingQuestions: [], operations: [{ type: "add_index", tableName: "t", index: { name: "i", columns: ["a"] } }] });
        const { plan, model } = await createZenSchemaPlan({
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
