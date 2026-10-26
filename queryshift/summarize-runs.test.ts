import { describe, expect, it } from "vitest";
import { summarize, toMarkdown } from "./summarize-runs";

const call = (n: number, input: number, output: number, latencyMs: number) => ({ n, source: "model", proposal: { model: "m-1", usage: { inputTokens: input, outputTokens: output }, latencyMs } });
const engine = { n: 0, source: "rule-engine" };

describe("summarize-runs", () => {
    const traces = [
        { caseId: "case-02", outcome: "verified" as const, reasons: [], attempts: [engine, call(1, 1000, 100, 4000)] },
        { caseId: "case-02", outcome: "verified" as const, reasons: [], attempts: [engine, call(1, 1200, 120, 6000), call(2, 1500, 150, 8000)] },
        { caseId: "case-02", outcome: "needs_human_review" as const, reasons: [{ code: "budget_exhausted" }], attempts: [engine, call(1, 1000, 100, 5000)] },
        { caseId: "case-01", outcome: "verified" as const, reasons: [], attempts: [engine] },
    ];
    const [one, two] = summarize(traces);

    it("counts runs, outcomes and reasons per case from the traces", () => {
        expect(one.caseId).toBe("case-01");
        expect(two).toMatchObject({ caseId: "case-02", runs: 3, verified: 2, needsHumanReview: 1, reasons: { budget_exhausted: 1 } });
    });

    it("counts a correction as an attempt after the rule engine's, and says when no model was called", () => {
        expect(one).toMatchObject({ runsThatCalledTheModel: 0, modelCalls: 0, corrections: { average: 0, max: 0 }, models: [] });
        expect(two.corrections).toEqual({ average: 4 / 3, max: 2 });
        expect(two).toMatchObject({ runsThatCalledTheModel: 3, modelCalls: 4, models: ["m-1"] });
    });

    it("adds tokens over every call and averages latency per call and per run", () => {
        expect(two.tokens).toMatchObject({ input: 4700, output: 470 });
        expect(two.tokens.inputPerRun).toBeCloseTo(4700 / 3);
        expect(two.latencyMs).toMatchObject({ averagePerCall: 5750, maxPerCall: 8000 });
        expect(two.latencyMs.averageTotalPerRun).toBeCloseTo(23000 / 3);
    });

    it("writes one table per case", () => {
        const text = toMarkdown([one, two]);
        expect(text.match(/^\*\*case-/gm)).toHaveLength(2);
        expect(text).toContain("| Verified | 2 of 3 |");
        expect(text).toContain("| Reasons seen | budget_exhausted x1 |");
        expect(text).toContain("| Tokens in / out (total) | 4,700 / 470 |");
    });
});
