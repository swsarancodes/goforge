import { beforeAll, describe, expect, it } from "vitest";
import { modernizeQuery } from "./orchestrator";
import { reconcileModernization, type AiConversion } from "./reconcile";
import type { ModernizeRequest, ModernizeResponse } from "./types";

const request: ModernizeRequest = {
    legacySql: "SELECT NVL(a, 0) AS a FROM t WHERE ROWNUM <= 5",
    sourceDialect: "oracle",
    targetDialect: "postgresql",
    schemaContext: { databaseName: "d", tables: [{ name: "t", columns: [{ name: "a", type: "integer" }] }] },
    options: { optimize: true, generateIndexes: true },
};

const conversion = (overrides: Partial<AiConversion> = {}): AiConversion => ({
    sql: "SELECT COALESCE(a, 0) AS a FROM t LIMIT 5",
    summary: "Converted NVL and ROWNUM.",
    changes: ["NVL -> COALESCE", "ROWNUM -> LIMIT"],
    risks: [],
    unsupported: [],
    indexSuggestions: [],
    ...overrides,
});

let rules: ModernizeResponse;
beforeAll(async () => {
    rules = await modernizeQuery(request);
});

describe("reconcileModernization", () => {
    it("leaves the rule-based result alone when AI is off", () => {
        const result = reconcileModernization(rules, { status: "off" }, request);
        expect(result.optimizedSql).toBe(rules.optimizedSql);
        expect(result.source).toBe("rules");
        expect(result.aiNotice).toBeUndefined();
        expect(result.agentTraces).toEqual(rules.agentTraces);
    });

    it("keeps the rule-based result and says why when the AI was unavailable", () => {
        const result = reconcileModernization(rules, { status: "unavailable", reason: "ZEN_API_KEY is not configured on the server" }, request, 1234);
        expect(result.optimizedSql).toBe(rules.optimizedSql);
        expect(result.source).toBe("rules");
        expect(result.aiNotice).toMatch(/AI unavailable: ZEN_API_KEY is not configured/);
        expect(result.agentTraces.at(-1)).toMatchObject({ agentId: "ai", status: "warning", title: "Skipped", timestamp: 1234 });
        expect(result.agentTraces).toHaveLength(rules.agentTraces.length + 1);
    });

    it("shows the AI conversion when it passes the same checks as the rules", () => {
        const result = reconcileModernization(rules, { status: "ok", result: conversion(), model: "test-model", elapsedMs: 900 }, request);

        expect(result.source).toBe("ai");
        expect(result.optimizedSql).toBe("SELECT COALESCE(a, 0) AS a FROM t LIMIT 5");
        expect(result.aiModel).toBe("test-model");
        expect(result.aiSummary).toBe("Converted NVL and ROWNUM.");
        expect(result.transformationsSummary).toEqual(["NVL -> COALESCE", "ROWNUM -> LIMIT"]);
        expect(result.validationReport.astErrors).toEqual([]);
        expect(result.verificationSql).toContain("COALESCE(a, 0)");
        expect(result.diff.additions).toBeGreaterThan(0);

        const [aiStep, checkStep] = result.agentTraces.slice(-2);
        expect(aiStep).toMatchObject({ agentId: "ai", name: "AI refinement", status: "success", durationMs: 900 });
        expect(aiStep.details).toEqual(["NVL -> COALESCE", "ROWNUM -> LIMIT"]);
        expect(checkStep.name).toMatch(/Validation of the AI result/);
    });

    it("rejects an AI conversion with broken syntax and falls back to the rules", () => {
        const result = reconcileModernization(rules, { status: "ok", result: conversion({ sql: "SELECT COALESCE(a, 0 FROM t" }), model: "m" }, request);

        expect(result.source).toBe("rules");
        expect(result.optimizedSql).toBe(rules.optimizedSql);
        expect(result.aiNotice).toMatch(/AI result failed validation/);
        expect(result.agentTraces.at(-1)).toMatchObject({ agentId: "ai", status: "error", title: "Result rejected by validation" });
    });

    it("lowers confidence and raises risk for risks and constructs that were not converted", () => {
        const clean = reconcileModernization(rules, { status: "ok", result: conversion(), model: "m" }, request);
        const risky = reconcileModernization(rules, { status: "ok", result: conversion({ risks: ["ROWNUM applies before ORDER BY in Oracle"] }), model: "m" }, request);
        const partial = reconcileModernization(rules, { status: "ok", result: conversion({ unsupported: ["CONNECT BY NOCYCLE"] }), model: "m" }, request);

        expect(clean.riskLevel).toBe("low");
        expect(risky.riskLevel).toBe("medium");
        expect(risky.confidenceScore).toBeLessThan(clean.confidenceScore);
        expect(partial.riskLevel).toBe("high");
        expect(partial.confidenceScore).toBeLessThan(risky.confidenceScore);
        expect(partial.agentTraces.at(-2)?.status).toBe("warning");
        expect(partial.agentTraces.at(-2)?.details).toContain("Not converted: CONNECT BY NOCYCLE");
    });

    it("merges the model's index suggestions into the rules' without duplicates", () => {
        const existing = rules.indexRecommendations[0];
        const result = reconcileModernization(
            rules,
            {
                status: "ok",
                model: "m",
                result: conversion({
                    indexSuggestions: [
                        ...(existing ? [{ tableName: existing.tableName.toUpperCase(), columns: existing.columns.map((c) => c.toUpperCase()), reason: "duplicate of a rule suggestion" }] : []),
                        { tableName: "t", columns: ["a", "b"], unique: true, reason: "filter on a, b" },
                    ],
                }),
            },
            request,
        );

        const added = result.indexRecommendations.filter((recommendation) => recommendation.id.startsWith("ai-"));
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({ tableName: "t", columns: ["a", "b"], unique: true, name: "idx_t_a_b", estimatedImpact: "Suggested by AI" });
        expect(added[0].ddl).toBe("CREATE UNIQUE INDEX idx_t_a_b ON t (a, b);");
        expect(result.indexRecommendations.length).toBe(rules.indexRecommendations.length + 1);
    });
});
