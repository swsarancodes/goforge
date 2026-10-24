import { describe, expect, it } from "vitest";
import type { ModelCall, ModelResult } from "../ai/provider.js";
import { analyzeHealth, type HealthData } from "./health.js";
import { summarizeHealth } from "./health-summary.js";

const data: HealthData = {
    serverVersion: "16.0",
    statsResetAt: null,
    tables: [
        { schema: "billing", name: "invoices", partitioned: false, columns: 5, hasPrimaryKey: false, estimatedRows: 5000, totalBytes: 9_000_000, liveTuples: 5000, deadTuples: 0, modificationsSinceAnalyze: 0, lastAnalyze: "2026-01-01T00:00:00.000Z", hasStatistics: true },
        { schema: "billing", name: "payroll_runs", partitioned: false, columns: 80, hasPrimaryKey: true, estimatedRows: 100, totalBytes: 1_000, liveTuples: 100, deadTuples: 0, modificationsSinceAnalyze: 0, lastAnalyze: "2026-01-01T00:00:00.000Z", hasStatistics: true },
    ],
    indexes: [],
    foreignKeys: [],
    unvalidated: [],
    sequences: [],
};
const report = analyzeHealth(data, { now: Date.parse("2026-02-01T00:00:00Z") });
const connection = { id: "c1", name: "main" };

const model = (answer: (call: ModelCall) => unknown) => {
    const calls: ModelCall[] = [];
    return { calls, callModel: async (call: ModelCall): Promise<ModelResult> => (calls.push(call), { output: answer(call), model: "m", usage: { inputTokens: null, outputTokens: null }, auditId: 7, latencyMs: 1 }) };
};

describe("summarizeHealth", () => {
    it("keeps the model's order and sentences, and drops ids that are not in the report", async () => {
        const first = report.findings[0].id;
        const { callModel, calls } = model(() => ({ headline: "Two things to look at.", priorities: [{ findingIds: [first, "no-primary-key:invented.table:"], why: "It has no key." }, { findingIds: ["made-up"], why: "Nothing real." }] }));
        const summary = await summarizeHealth(report, { callModel }, { redact: false, connection });
        expect(summary.priorities).toEqual([{ findingIds: [first], why: "It has no key." }]);
        expect(summary.droppedIds).toBe(2);
        expect(summary).toMatchObject({ headline: "Two things to look at.", model: "m", auditId: 7, redacted: false });
        expect(calls[0].purpose).toBe("health-summary");
        // the answer is asked for in the shape the validator checks it against
        expect(calls[0].format?.name).toBe("health_summary");
        expect(calls[0].format?.schema.safeParse({ headline: "x", priorities: [] }).success).toBe(true);
        const sent = calls[0].input as { findings: { id: string; detail: unknown }[]; tables: number };
        expect(sent.tables).toBe(2);
        expect(Object.keys(sent.findings[0]).sort()).toEqual(["bytes", "category", "detail", "id", "object", "table"]);
    });

    it("sends placeholders instead of names when asked, and translates the answer back", async () => {
        const { callModel, calls } = model((call) => {
            const findings = (call.input as { findings: { id: string; table: string }[] }).findings;
            return { headline: `Look at ${findings[0].table} first.`, priorities: [{ findingIds: [findings[0].id], why: `${findings[0].table} matters.` }] };
        });
        const summary = await summarizeHealth(report, { callModel }, { redact: true, connection });
        const sent = JSON.stringify(calls[0].input);
        for (const name of ["billing", "invoices", "payroll_runs"]) expect(sent, name).not.toContain(name);
        expect(summary.redacted).toBe(true);
        expect(summary.headline).toMatch(/billing\.(invoices|payroll_runs)/);
        expect(summary.priorities).toHaveLength(1);
        expect(report.findings.map((f) => f.id)).toContain(summary.priorities[0].findingIds[0]);
        expect(summary.priorities[0].why).toMatch(/billing\./);
    });

    it("says what was wrong when the answer is not a summary", async () => {
        const { callModel } = model(() => ({ nothing: true }));
        await expect(summarizeHealth(report, { callModel }, { redact: false, connection })).rejects.toThrow(/not in the expected format/);
    });
});
