import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCase } from "./case";
import type { LoopResult } from "./loop";
import { renderCaseReport } from "./report";
import { readTrace, traceFile } from "./replay-proposer";

// These render text from traces already on disk, so they start no database. The loop that makes such traces is run in loop.test.ts,
// which also renders the report of a replay it has just run.
const reports = resolve(import.meta.dirname, "../reports");
const casesRoot = resolve(import.meta.dirname, "../cases");
const [case1, case2, case3] = readdirSync(casesRoot).map((name) => resolve(casesRoot, name)).filter((path) => statSync(path).isDirectory()).sort().map(loadCase);
const recorded = (id: string) => readTrace(traceFile(reports, id));

/** Case 1: the rule engine's own query verifies. */
const engineOnly = recorded("case-01");

/** Case 2 as a replay presents it: the recorded model attempt, labelled as played back. */
const replayed: LoopResult = (() => {
    const trace = structuredClone(recorded("case-02"));
    for (const attempt of trace.attempts.filter((a) => a.n > 0)) {
        attempt.source = "replay";
        attempt.proposal = { ...attempt.proposal!, replayedFrom: "queryshift/reports/case-02.loop.json" };
    }
    return trace;
})();

/** Case 3 as it ends with no proposer: the rule engine's attempt, then a human. */
const unresolved: LoopResult = (() => {
    const trace = structuredClone(recorded("case-03"));
    const [first] = trace.attempts;
    return { ...trace, outcome: "needs_human_review", attempts: [first], finalSql: first.sql, reasons: [{ code: "no_proposer", message: `No model is configured, so nothing can correct the rule engine's query. It was judged: ${first.summary}` }] };
})();

describe("the case report", () => {
    it("states the outcome, what it means, and what it does not", () => {
        const report = renderCaseReport(case1, engineOnly);
        expect(report).toMatch(/^# case-01: /);
        expect(report).toContain("**Outcome: VERIFIED**");
        expect(report).toContain("on the primary data (7 rows) and the held-out data (8 rows), in the same order, and all 3 invariants held");
        expect(report).toContain("not a proof that the two queries agree on every possible input");
    });

    it("says 'the invariant' and not 'all 1 invariants' for a case with one", () => {
        expect(renderCaseReport(case3, recorded("case-03"))).toContain("and the invariant held");
    });

    it("lays the case out in the order of the challenge: input, risk analysis, transformation and proof, decision", () => {
        const report = renderCaseReport(case2, replayed);
        const at = ["## Input", "## Risk analysis", "## Transformation and proof", "## Decision"].map((heading) => report.indexOf(heading));
        expect(at.every((index) => index >= 0)).toBe(true);
        expect([...at].sort((a, b) => a - b)).toEqual(at);
    });

    it("shows the legacy query as its file has it, and the values its bind variables were given", () => {
        const report = renderCaseReport(case1, engineOnly);
        expect(report).toContain(">= :cutoff");
        expect(report).toContain("`:cutoff` = `TO_DATE('2026-01-01', 'YYYY-MM-DD')`");
    });

    it("lists every attempt with who produced it and what was measured, and the accepted query last", () => {
        const report = renderCaseReport(case2, replayed);
        expect(report).toContain("### Attempt 0: GoForge rule engine, then the schema mapping");
        const model = recorded("case-02").attempts[1].proposal?.model;
        expect(model, "the recorded model attempt names its model").toBeTruthy();
        expect(report).toContain(`### Attempt 1: model \`${model}\`, answer replayed from \`queryshift/reports/case-02.loop.json\` (no model was called in this run)`);
        expect(report).toContain("**Primary data: FAIL.**");
        expect(report).toContain("The rows differ in: open_ratio (4 rows), contact_label (1 row).");
        expect(report).toContain("**Held-out data: PASS.**");
        expect(report.indexOf("**The accepted query**")).toBeGreaterThan(report.indexOf("### Attempt 1"));
        expect(report.slice(report.indexOf("**The accepted query**"))).toContain(replayed.finalSql.trim());
    });

    it("says that a replayed answer was not asked for now, and that what was measured was run again", () => {
        const report = renderCaseReport(case2, replayed);
        expect(report).toContain("replayed from a recording");
        expect(report).toContain("the recording shows what a model gave, not that it gives it today");
        expect(renderCaseReport(case2, recorded("case-02"))).not.toContain("replayed from a recording");
    });

    it("gives a case that needs a human its reasons and the measurement to start from", () => {
        const report = renderCaseReport(case3, unresolved);
        expect(report).toContain("**Outcome: NEEDS HUMAN REVIEW**");
        expect(report).toContain("`no_proposer`");
        expect(report).toContain("**The last query tried**");
        expect(report).toMatch(/trunc/i);
    });

    it("quotes the model's own words as its own, and keeps them out of the claims", () => {
        const report = renderCaseReport(case2, replayed);
        expect(report).toContain("(its own words; nothing checks them)");
    });

    it("carries the exact prompt when the trace has one", () => {
        const withPrompt = structuredClone(replayed);
        withPrompt.attempts[1].proposal = { ...withPrompt.attempts[1].proposal, prompt: { instructions: "You are a migration engine.", input: { originalQuery: "SELECT 1" }, sha256: "ab".repeat(32) } };
        const report = renderCaseReport(case2, withPrompt);
        expect(report).toContain("<summary>The exact prompt sent for correction 1 (SHA-256 abababababab…)</summary>");
        expect(report).toContain("You are a migration engine.");
        expect(report).toContain('"originalQuery": "SELECT 1"');
        expect(renderCaseReport(case2, replayed)).not.toContain("<details>");
    });

    it("keeps a table cell in one piece when a summary contains a pipe or a line break", () => {
        const awkward = structuredClone(unresolved);
        awkward.attempts[0].summary = "a | b\nc";
        const row = renderCaseReport(case3, awkward).split("\n").find((line) => line.startsWith("| 0 |"))!;
        expect(row).toContain("a \\| b c");
        expect(row.replace(/\\\|/g, "").split("|")).toHaveLength(6);
    });

    it("is the same report for the same trace, with no date and no path of the machine it ran on", () => {
        const report = renderCaseReport(case2, replayed);
        expect(renderCaseReport(case2, replayed)).toBe(report);
        expect(report).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\|\b20\d\d-\d\d-\d\dT\d\d:/);
    });

    it("is the report committed next to each recorded trace, so the evidence cannot drift from the code that writes it", () => {
        for (const [loaded, id] of [[case1, "case-01"], [case2, "case-02"], [case3, "case-03"]] as const) {
            const committed = readFileSync(resolve(reports, `${id}.report.md`), "utf8").replace(/\r\n/g, "\n");
            expect(renderCaseReport(loaded, recorded(id)), `${id}.report.md is out of date: run npm run queryshift -- --report-from queryshift/reports`).toBe(committed);
        }
    });
});
