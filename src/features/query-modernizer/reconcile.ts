import { computeDiffMetrics, generateVerificationQuery } from "./agents/judge-agent";
import type { TranspilerOutput } from "./agents/transpiler-agent";
import { runValidatorAgent } from "./agents/validator-agent";
import type { AgentTrace, AiConversion, IndexRecommendation, ModernizeRequest, ModernizeResponse } from "./types";

export type { AiConversion };

export type AiOutcome =
    | { status: "off" }
    | { status: "unavailable"; reason: string }
    | { status: "ok"; result: AiConversion; model: string; elapsedMs?: number };

const trace = (partial: Omit<AgentTrace, "agentId" | "timestamp"> & { timestamp: number }): AgentTrace => ({ agentId: "ai", ...partial });

const indexKey = (tableName: string, columns: string[]) => `${tableName.toLowerCase()}|${columns.map((column) => column.toLowerCase()).join(",")}`;

/** Folds the model's index suggestions into the rule engine's, without repeating one that is already there. */
function mergeIndexes(rules: IndexRecommendation[], ai: AiConversion["indexSuggestions"]): IndexRecommendation[] {
    const seen = new Set(rules.map((recommendation) => indexKey(recommendation.tableName, recommendation.columns)));
    const added: IndexRecommendation[] = [];

    ai.forEach((suggestion, index) => {
        const key = indexKey(suggestion.tableName, suggestion.columns);
        if (seen.has(key)) return;
        seen.add(key);
        const name = `idx_${suggestion.tableName}_${suggestion.columns.join("_")}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
        added.push({
            id: `ai-${index}`,
            tableName: suggestion.tableName,
            columns: suggestion.columns,
            unique: suggestion.unique ?? false,
            name,
            reason: suggestion.reason || "Suggested by the language model.",
            estimatedImpact: "Suggested by AI",
            ddl: `CREATE ${suggestion.unique ? "UNIQUE " : ""}INDEX ${name} ON ${suggestion.tableName} (${suggestion.columns.join(", ")});`,
        });
    });

    return [...rules, ...added];
}

/**
 * Confidence and risk for a model-produced conversion. The rules can't prove two queries return the same rows, so this
 * is a heuristic from what they can see: broken syntax is rejected earlier; schema warnings, risks the model itself
 * flagged and constructs it couldn't convert all lower the score.
 */
function scoreConversion(schemaWarnings: number, antiPatterns: number, risks: number, unsupported: number): { confidenceScore: number; riskLevel: ModernizeResponse["riskLevel"] } {
    const confidenceScore = Math.max(35, 92 - Math.min(24, schemaWarnings * 6) - Math.min(9, antiPatterns * 3) - Math.min(16, risks * 4) - Math.min(36, unsupported * 12));
    const riskLevel = unsupported > 0 ? "high" : risks > 0 || schemaWarnings > 0 || confidenceScore < 80 ? "medium" : "low";
    return { confidenceScore, riskLevel };
}

/**
 * Combines the rule engine's conversion with the optional model conversion.
 *  - The model's SQL is only shown when it passes the same syntax checks the rules apply to their own output.
 *  - If it fails them, isn't configured, or errors, the rule-based result stays the answer and `aiNotice` says why.
 */
export function reconcileModernization(rules: ModernizeResponse, ai: AiOutcome, request: ModernizeRequest, now: number = Date.now()): ModernizeResponse {
    if (ai.status === "off") return { ...rules, source: "rules" };

    if (ai.status === "unavailable") {
        const notice = `AI unavailable: ${ai.reason}. Showing the rule-based conversion.`;
        return {
            ...rules,
            source: "rules",
            aiNotice: notice,
            agentTraces: [...rules.agentTraces, trace({ name: "AI refinement", role: "Language model", status: "warning", title: "Skipped", details: [ai.reason], timestamp: now })],
        };
    }

    const checkTrace: AgentTrace = { agentId: "validator", name: "", role: "", status: "success", title: "", details: [], timestamp: now };
    const validation = runValidatorAgent(request, { translatedSql: ai.result.sql, transformationsApplied: [], trace: checkTrace } as TranspilerOutput, 0);
    const { report } = validation;

    if (report.astErrors.length > 0) {
        const notice = `The AI result failed validation (${report.astErrors[0]}). Showing the rule-based conversion.`;
        return {
            ...rules,
            source: "rules",
            aiNotice: notice,
            agentTraces: [
                ...rules.agentTraces,
                trace({ name: "AI refinement", role: "Language model", status: "error", title: "Result rejected by validation", details: [...report.astErrors, ...(ai.result.summary ? [ai.result.summary] : [])], timestamp: now, durationMs: ai.elapsedMs }),
            ],
        };
    }

    const { confidenceScore, riskLevel } = scoreConversion(report.schemaWarnings.length, report.antiPatternsDetected.length, ai.result.risks.length, ai.result.unsupported.length);
    const { additions, deletions } = computeDiffMetrics(request.legacySql, ai.result.sql);

    const aiTrace = trace({
        name: "AI refinement",
        role: `Language model${ai.model ? ` (${ai.model})` : ""}`,
        status: ai.result.unsupported.length > 0 ? "warning" : "success",
        title: ai.result.summary || "Converted the query",
        details: [...ai.result.changes, ...ai.result.unsupported.map((item) => `Not converted: ${item}`)],
        timestamp: now,
        durationMs: ai.elapsedMs,
    });
    const checkedTrace = trace({
        name: "Validation of the AI result",
        role: "Rule-based checks",
        status: report.schemaWarnings.length > 0 ? "warning" : "success",
        title: report.schemaWarnings.length > 0 ? `${report.schemaWarnings.length} warning(s) against your tables` : "Syntax and tables check out",
        details: [...report.schemaWarnings, ...report.antiPatternsDetected],
        timestamp: now,
    });

    return {
        ...rules,
        optimizedSql: ai.result.sql,
        diff: { additions, deletions },
        confidenceScore,
        riskLevel,
        agentTraces: [...rules.agentTraces, aiTrace, checkedTrace],
        indexRecommendations: mergeIndexes(rules.indexRecommendations, ai.result.indexSuggestions),
        transformationsSummary: ai.result.changes.length > 0 ? ai.result.changes : rules.transformationsSummary,
        validationReport: report,
        verificationSql: generateVerificationQuery(ai.result.sql),
        source: "ai",
        aiModel: ai.model,
        aiSummary: ai.result.summary,
        aiRisks: ai.result.risks,
        aiUnsupported: ai.result.unsupported,
    };
}
