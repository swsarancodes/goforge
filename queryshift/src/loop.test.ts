import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installOpenAiBackend } from "../../server/src/ai/openai";
import { DEFAULT_SETTINGS } from "../../server/src/ai/policy";
import { getAuditStore, installAiStores } from "../../server/src/ai/provider";
import { substituteBinds } from "./binds";
import { databaseFor, databasesFor, loadCase, type LoadedCase } from "./case";
import type { Database } from "./database";
import { hardCodingSuspicion, runLoop, type ProposalInput, type Proposer } from "./loop";
import { modelProposer } from "./model-proposer";
import { readTrace, replayProposer, traceFile } from "./replay-proposer";
import { renderCaseReport } from "./report";

// Each of these starts PostgreSQL workers (a few hundred ms to a second or two each, more when the whole suite runs in parallel).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = resolve(import.meta.dirname, "../cases");
const dirOf = (prefix: string) => resolve(root, readdirSync(root).find((name) => name.startsWith(prefix))!);
const candidate = (loaded: LoadedCase, file: string) => readFileSync(resolve(loaded.dir, "candidates", file), "utf8");

const case1 = loadCase(dirOf("case-01"));
const case2 = loadCase(dirOf("case-02"));
const case3 = loadCase(dirOf("case-03"));
type Dbs = Awaited<ReturnType<typeof databasesFor>>;
let d1: Dbs;
let d2: Dbs;
let d3: Dbs;
beforeAll(async () => {
    [d1, d2, d3] = await Promise.all([databasesFor(case1), databasesFor(case2), databasesFor(case3)]);
});
afterAll(async () => {
    await Promise.all([d1.close(), d2.close(), d3.close()]);
});
const run = (loaded: LoadedCase, dbs: Dbs, rest: { proposer?: Proposer; maxCorrections?: number; timeoutMs?: number } = {}) => runLoop({ loaded, db: dbs.primary, heldOutDb: dbs.heldOut, ...rest });

/** A proposer that answers from a list and remembers what it was asked. */
function scripted(answers: (string | Error)[]): Proposer & { asked: ProposalInput[] } {
    const asked: ProposalInput[] = [];
    return {
        name: "scripted",
        asked,
        async propose(input) {
            asked.push(input);
            const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
            if (answer instanceof Error) throw answer;
            return { sql: answer, explanation: "scripted" };
        },
    };
}

describe("the rule engine's query, renamed to the target tables", () => {
    it("is verified without any proposer when it already matches (case 1)", async () => {
        const result = await run(case1, d1);
        expect(result.outcome).toBe("verified");
        expect(result.attempts).toHaveLength(1);
        expect(result.attempts[0].source).toBe("rule-engine");
        // it really ran on the target tables: no legacy names left in what was run
        expect(result.finalSql).toMatch(/\bcustomers\b/);
        expect(result.finalSql).not.toMatch(/CUST_MST/i);
    });

    it("goes to a human, with the measured evidence, when it does not match and nothing can correct it (case 2)", async () => {
        const result = await run(case2, d2);
        expect(result.outcome).toBe("needs_human_review");
        expect(result.reasons.map((reason) => reason.code)).toEqual(["no_proposer"]);
        const evidence = result.attempts[0].evidence!;
        expect(evidence.kind).toBe("mismatch");
        expect(evidence.missingCount).toBe(4);
        expect(evidence.differingColumns.map((entry) => entry.column).sort()).toEqual(["contact_label", "open_ratio"]);
        expect(result.engineWarnings).toContain("Dividing two integers");
    });

    it("reports PostgreSQL's rejection as error evidence, not as a mismatch (case 3)", async () => {
        const result = await run(case3, d3);
        expect(result.outcome).toBe("needs_human_review");
        expect(result.attempts[0].verdict).toBe("error");
        expect(result.attempts[0].evidence?.kind).toBe("error");
        expect(result.attempts[0].evidence?.message).toMatch(/trunc/i);
    });
});

describe("corrections", () => {
    it("shows the proposer the measurement, then verifies the corrected query (case 2)", async () => {
        const proposer = scripted([candidate(case2, "correct.sql")]);
        const result = await run(case2, d2, { proposer: proposer });
        expect(result.outcome).toBe("verified");
        expect(result.attempts.map((attempt) => attempt.n)).toEqual([0, 1]);
        expect(result.attempts[1].source).toBe("scripted");
        expect(proposer.asked).toHaveLength(1);
        const [asked] = proposer.asked;
        expect(asked.attempt).toBe(1);
        expect(asked.maxAttempts).toBe(3);
        expect(asked.previousSql).toBe(result.attempts[0].sql);
        expect(asked.evidence.differingColumns.length).toBeGreaterThan(0);
        expect(asked.evidence.missingRows.length).toBe(4);
        expect(asked.schema.map((table) => table.name).sort()).toEqual(["claims", "customers", "policies"]);
        expect(asked.mapping.length).toBeGreaterThan(10);
    });

    it("corrects an error the same way (case 3), feeding the previous attempt's evidence forward", async () => {
        const wrongThenRight = scripted([candidate(case3, "silent_between_without_trunc.sql"), candidate(case3, "correct.sql")]);
        const result = await run(case3, d3, { proposer: wrongThenRight });
        expect(result.outcome).toBe("verified");
        expect(result.attempts.map((attempt) => attempt.verdict)).toEqual(["error", "fail", "pass"]);
        // the second correction was based on the first correction's mismatch, not on the original error
        expect(wrongThenRight.asked[0].evidence.kind).toBe("error");
        expect(wrongThenRight.asked[1].evidence.kind).toBe("mismatch");
        expect(wrongThenRight.asked[1].previousSql).toBe(result.attempts[1].sql);
    });

    it("stops at the budget: exactly maxCorrections corrections, then a human", async () => {
        const answers = [candidate(case2, "silent_concat_null.sql"), candidate(case2, "integer_division.sql"), candidate(case2, "avg_without_nvl.sql"), candidate(case2, "correct.sql")];
        const proposer = scripted(answers);
        const result = await run(case2, d2, { proposer: proposer });
        expect(proposer.asked).toHaveLength(3);
        expect(result.outcome).toBe("needs_human_review");
        expect(result.reasons.map((reason) => reason.code)).toEqual(["budget_exhausted"]);
        expect(result.attempts).toHaveLength(4);
        // the correct answer sat at position 4 and was never asked for
        expect(result.attempts.every((attempt) => attempt.verdict !== "pass")).toBe(true);
        const two = await run(case2, d2, { proposer: scripted(answers), maxCorrections: 2 });
        expect(two.attempts).toHaveLength(3);
    });

    it("stops when the proposer returns a query that was already tried", async () => {
        const same = candidate(case2, "silent_concat_null.sql");
        const proposer = scripted([same, same]);
        const result = await run(case2, d2, { proposer: proposer });
        expect(result.reasons.map((reason) => reason.code)).toEqual(["stalled"]);
        expect(proposer.asked).toHaveLength(2);
    });

    it("treats a query that differs only in whitespace, case, comments or a semicolon as the same query", async () => {
        const wrong = candidate(case2, "silent_concat_null.sql");
        const proposer = scripted([wrong, `/* again */ ${wrong.replace(/--[^\n]*\n/g, "").toUpperCase().replace(/\s+/g, "  ")} ;`]);
        const result = await run(case2, d2, { proposer: proposer });
        expect(result.reasons.map((reason) => reason.code)).toEqual(["stalled"]);
    });

    it("sends a query that reproduces the evidence to a human without running it", async () => {
        const hardCoded = `SELECT * FROM (VALUES (1, 'Asha Rao <asha.rao@example.com>', 3, 4400.00, 700.00, 0.3333)) AS t(cust_id, contact_label, clm_cnt, tot_claimed, avg_paid, open_ratio)`;
        const result = await run(case2, d2, { proposer: scripted([hardCoded]) });
        expect(result.reasons.map((reason) => reason.code)).toEqual(["hard_coded"]);
        expect(result.attempts[1].verdict).toBe("refused");
        expect(result.attempts[1].summary).toMatch(/does not read any table|VALUES/);
    });

    it("sends a query the guard refuses to a human and does not correct it again", async () => {
        const proposer = scripted(["DELETE FROM customers", candidate(case2, "correct.sql")]);
        const result = await run(case2, d2, { proposer: proposer });
        expect(result.reasons.map((reason) => reason.code)).toEqual(["guard_refused"]);
        expect(proposer.asked).toHaveLength(1);
        expect((await d2.primary.query<{ n: string }>("SELECT count(*) AS n FROM customers")).rows[0].n).toBe("7");
    });

    it("sends a proposer that fails (no key, policy, network) to a human, with its message", async () => {
        const result = await run(case2, d2, { proposer: scripted([new Error("OpenAI is not configured")]) });
        expect(result.outcome).toBe("needs_human_review");
        expect(result.reasons[0]).toMatchObject({ code: "proposer_failed" });
        expect(result.reasons[0].message).toMatch(/not configured/);
    });

    it("records every attempt so the trace can be exported", async () => {
        const result = await run(case2, d2, { proposer: scripted([candidate(case2, "integer_division.sql"), candidate(case2, "correct.sql")]) });
        expect(JSON.parse(JSON.stringify(result)).attempts).toHaveLength(3);
        expect(result.attempts[1].evidence?.kind).toBe("mismatch");
        expect(result.outcome).toBe("verified");
    });
});

describe("held-out data", () => {
    const heldOutNames = ["Ines Alvarez", "Jonas Weber", "Olga Petrov", "Priya Nair", "Mara Quinn"];

    it("is part of what verified means: verified results say they were also checked on it", async () => {
        const verified = await run(case2, d2, { proposer: scripted([candidate(case2, "correct.sql")]) });
        expect(verified.outcome).toBe("verified");
        expect(verified.heldOut).toBe("passed");
        expect(verified.attempts.at(-1)?.heldOut?.verdict).toBe("pass");
        const engineOnly = await run(case1, d1);
        expect(engineOnly.outcome).toBe("verified");
        expect(engineOnly.heldOut).toBe("passed");
    });

    it("sends a query that was fitted to the evidence to a human, and does not correct it against the held-out data (cases 2 and 3: case 1's rule-engine query is right, so no correction is asked for)", async () => {
        for (const [loaded, dbs, file] of [[case2, d2, "overfit_customer_2_label.sql"], [case3, d3, "overfit_special_cased_review_date.sql"]] as const) {
            const proposer = scripted([candidate(loaded, file), candidate(loaded, "correct.sql")]);
            const result = await run(loaded, dbs, { proposer });
            expect(result.outcome, loaded.definition.id).toBe("needs_human_review");
            expect(result.heldOut).toBe("failed");
            expect(result.reasons.map((reason) => reason.code)).toEqual(["fails_held_out"]);
            // the primary data said pass, the held-out data said fail, and the loop stopped there: the correct query offered second was never asked for
            const last = result.attempts.at(-1)!;
            expect(last.verdict).toBe("pass");
            expect(last.heldOut?.verdict).toBe("fail");
            expect(last.heldOut?.evidence?.missingCount).toBeGreaterThan(0);
        }
    });

    it("never reaches a proposer: no held-out value appears in anything a proposer was asked", async () => {
        const proposer = scripted([candidate(case2, "silent_concat_null.sql"), candidate(case2, "integer_division.sql"), candidate(case2, "avg_without_nvl.sql")]);
        await run(case2, d2, { proposer });
        const everything = JSON.stringify(proposer.asked.map(({ evidence, previousSql, schema, mapping, engineWarnings }) => ({ evidence, previousSql, schema, mapping, engineWarnings })));
        for (const name of heldOutNames) expect(everything).not.toContain(name);
        expect(everything).not.toMatch(/\b80\d\d\b/);

        const overfit = scripted([candidate(case2, "overfit_customer_2_label.sql")]);
        await run(case2, d2, { proposer: overfit });
        expect(overfit.asked).toHaveLength(1);
    });

    it("builds the held-out database itself when none is given, and reports none for a case without held-out data", async () => {
        const alone = await runLoop({ loaded: case1, db: d1.primary });
        expect(alone.heldOut).toBe("passed");
        const without = await runLoop({ loaded: { ...case1, heldOut: undefined }, db: d1.primary });
        expect(without.outcome).toBe("verified");
        expect(without.heldOut).toBe("none");
    });

    it("also holds the rule engine's own query to it", async () => {
        // a query that is right on the primary data and wrong on the held-out data stops the loop at attempt 0 as well
        const broken: LoadedCase = { ...case1, heldOut: { ...case1.heldOut!, expected: { ...case1.heldOut!.expected, rows: case1.heldOut!.expected.rows.slice(1) } } };
        const result = await run(broken, d1);
        expect(result.outcome).toBe("needs_human_review");
        expect(result.attempts).toHaveLength(1);
        expect(result.reasons[0].code).toBe("fails_held_out");
    });
});

describe("static checks in the loop", () => {
    const ids = (findings: { id: string }[]) => [...new Set(findings.map((finding) => finding.id))].sort();

    it("reads every attempt, and shows the proposer the findings next to the measurement", async () => {
        const proposer = scripted([candidate(case2, "correct.sql")]);
        const result = await run(case2, d2, { proposer });
        expect(ids(result.attempts[0].findings)).toEqual(["integer_division", "null_in_concatenation"]);
        expect(ids(proposer.asked[0].evidence.staticFindings)).toEqual(["integer_division", "null_in_concatenation"]);
        expect(proposer.asked[0].evidence.staticFindings[0]).toMatchObject({ title: expect.any(String), detail: expect.stringMatching(/\S/) });
        // the corrected query is clean, and that is what the result reports
        expect(result.outcome).toBe("verified");
        expect(result.findings).toEqual([]);
    });

    it("reads the rule engine's query even when it could not be run (case 3)", async () => {
        const result = await run(case3, d3);
        expect(result.attempts[0].verdict).toBe("error");
        expect(ids(result.attempts[0].findings)).toContain("month_arithmetic_without_month_end_rule");
    });

    it("does not verify a query that matches both datasets and compares with a value the legacy query never had", async () => {
        const fitted = candidate(case2, "correct.sql").replace("GROUP BY", "WHERE c.customer_id <> 999 GROUP BY");
        const proposer = scripted([fitted, candidate(case2, "correct.sql")]);
        const result = await run(case2, d2, { proposer });
        expect(result.attempts.at(-1)?.verdict).toBe("pass");
        expect(result.attempts.at(-1)?.heldOut?.verdict).toBe("pass");
        expect(result.outcome).toBe("needs_human_review");
        expect(result.reasons.map((reason) => reason.code)).toEqual(["static_finding"]);
        expect(result.reasons[0].message).toMatch(/999/);
        expect(proposer.asked).toHaveLength(1);
        expect(result.findings.map((finding) => finding.severity)).toEqual(["blocking"]);
    });

    it("verifies a query that matches both datasets and draws a warning, and lists the warning for the reviewer", async () => {
        const warned = candidate(case2, "correct.sql").replace("c.customer_name || ' <' || COALESCE(c.email, '') || '>'", "COALESCE(c.customer_name || ' <' || c.email || '>', c.customer_name || ' <>')");
        const result = await run(case2, d2, { proposer: scripted([warned]) });
        expect(result.outcome).toBe("verified");
        expect(ids(result.findings)).toEqual(["null_in_concatenation"]);
        expect(result.findings.every((finding) => finding.severity === "warning")).toBe(true);
    });

    it("sends the findings to the model", async () => {
        const sent: string[] = [];
        installAiStores({ settings: { read: () => ({ settings: { ...DEFAULT_SETTINGS, model: "test-model" } }), write: () => undefined }, audit: { record: () => 1, list: () => [], get: () => undefined } });
        installOpenAiBackend({
            credentials: async () => ({ found: true, source: "OPENAI_API_KEY" }),
            respond: async (request) => {
                sent.push(String(request.input));
                return { text: JSON.stringify({ sql: candidate(case2, "correct.sql"), explanation: "", changes: [], risks: [] }), inputTokens: null, outputTokens: null, stopReason: "end_turn" };
            },
            listModels: async () => [],
        });
        try {
            await run(case2, d2, { proposer: modelProposer() });
        } finally {
            installOpenAiBackend();
        }
        const findings = JSON.parse(sent[0]).evidence.staticFindings as { id: string }[];
        expect(ids(findings)).toEqual(["integer_division", "null_in_concatenation"]);
    });
});

describe("the wall-clock limit in the loop", () => {
    it("stops a runaway candidate, reports it as an error with evidence, and goes on to the next correction", async () => {
        const runaway = "SELECT count(*) AS n FROM claims, generate_series(1, 5000000000)";
        const proposer = scripted([runaway, candidate(case2, "correct.sql")]);
        const result = await run(case2, d2, { proposer, timeoutMs: 500 });
        expect(result.attempts[1].verdict).toBe("error");
        expect(result.attempts[1].summary).toMatch(/Stopped: .*500 ms/);
        expect(result.attempts[1].evidence?.kind).toBe("error");
        expect(proposer.asked[1].evidence.message).toMatch(/Stopped/);
        // the database came back with its data: the next query is judged normally
        expect(result.outcome).toBe("verified");
        expect(d2.primary.restarts).toBeGreaterThanOrEqual(1);
    });
});

describe("bind variables", () => {
    // Case 1's file says `>= :cutoff`; case.json says the reference result was produced with 2026-01-01.
    it("reads a declared bind variable as the value the case gives it, and verifies without a model (case 1)", async () => {
        expect(case1.legacyTemplate).toContain(":cutoff");
        expect(case1.legacySql).not.toContain(":cutoff");
        const result = await run(case1, d1);
        expect(result.outcome).toBe("verified");
        expect(result.reasons).toEqual([]);
        expect(result.attempts).toHaveLength(1);
        expect(result.attempts[0].sql).toContain("TO_DATE('2026-01-01', 'YYYY-MM-DD')");
    });

    it("sends a bind variable the case gives no value for to a human, and asks no model", async () => {
        const proposer = scripted([candidate(case1, "correct.sql")]);
        const result = await run({ ...case1, legacySql: case1.legacyTemplate }, d1, { proposer });
        expect(result.outcome).toBe("needs_human_review");
        expect(result.reasons.map((reason) => reason.code)).toEqual(["bind_parameters"]);
        expect(result.reasons[0].message).toContain(":cutoff");
        expect(result.reasons[0].message).toContain("bindValues");
        // PostgreSQL cannot run `:cutoff`, and the loop does not pretend otherwise or try to correct around it
        expect(result.attempts).toHaveLength(1);
        expect(result.attempts[0].verdict).toBe("error");
        expect(proposer.asked).toHaveLength(0);
    });

    it("measures against the declared value: another value gives another result, which is not the reference", async () => {
        const june = { type: "date" as const, value: "2026-06-01" };
        const result = await run({ ...case1, legacySql: substituteBinds(case1.legacyTemplate, { cutoff: june }).sql }, d1);
        expect(result.outcome).toBe("needs_human_review");
        expect(result.reasons.map((reason) => reason.code)).toEqual(["no_proposer"]);
        expect(result.attempts[0].verdict).toBe("fail");
        expect(result.attempts[0].sql).toContain("2026-06-01");
    });
});

describe("hardCodingSuspicion", () => {
    const schema = [{ name: "customers", columns: [{ name: "customer_name", type: "text", nullable: false }] }];
    const evidence = { kind: "mismatch" as const, message: "", expectedColumns: ["a"], missingRows: [["Asha"], ["Brightline"], ["Carlos"], ["Dunmore"]], unexpectedRows: [], missingCount: 4, unexpectedCount: 0, differingColumns: [], brokenInvariants: [], staticFindings: [] };
    const context = { legacySql: "SELECT 1 FROM CUST_MST WHERE x = 'AC'", previousSql: "SELECT 1 FROM customers", schema, evidence };

    it("accepts an ordinary correction", () => expect(hardCodingSuspicion("SELECT customer_name FROM customers WHERE segment_code = 'AC'", context)).toBeNull());
    it("flags a query that reads no table", () => expect(hardCodingSuspicion("SELECT 'Asha', 'Brightline', 'Carlos'", context)).toMatch(/does not read any table/));
    it("flags a VALUES list the legacy query did not have", () => expect(hardCodingSuspicion("SELECT * FROM customers, (VALUES (1)) v", context)).toMatch(/VALUES/));
    it("flags literals copied from the evidence, from three up", () => {
        expect(hardCodingSuspicion("SELECT 1 FROM customers WHERE customer_name IN ('Asha', 'Brightline', 'Carlos')", context)).toMatch(/3 string literals/);
        expect(hardCodingSuspicion("SELECT 1 FROM customers WHERE customer_name IN ('Asha', 'Brightline')", context)).toBeNull();
    });
    it("does not count a literal the legacy or previous query already had", () => {
        const known = { ...context, previousSql: "SELECT 1 FROM customers WHERE n IN ('Asha', 'Brightline', 'Carlos')" };
        expect(hardCodingSuspicion("SELECT 1 FROM customers WHERE n IN ('Asha', 'Brightline', 'Carlos')", known)).toBeNull();
    });
});

describe("through the real model path (stand-in OpenAI)", () => {
    const sent: { instructions: string; input: string }[] = [];
    beforeEach(() => {
        sent.length = 0;
        installAiStores({
            settings: { read: () => ({ settings: { ...DEFAULT_SETTINGS, model: "test-model" } }), write: () => undefined },
            audit: (() => {
                const entries: any[] = [];
                return { record: (entry: any) => (entries.push(entry), entries.length), list: () => entries, get: (id: number) => entries[id - 1] };
            })(),
        });
    });
    afterEach(() => installOpenAiBackend());

    const stub = (sql: string) =>
        installOpenAiBackend({
            credentials: async () => ({ found: true, source: "OPENAI_API_KEY" }),
            respond: async (request) => {
                sent.push({ instructions: request.instructions, input: String(request.input) });
                return { text: JSON.stringify({ sql, explanation: "cast and coalesce", changes: ["cast to numeric"], risks: [] }), inputTokens: null, outputTokens: null, stopReason: "end_turn" };
            },
            listModels: async () => [],
        });

    it("asks with the evidence, audits the call, and verifies what comes back", async () => {
        stub(candidate(case2, "correct.sql"));
        const result = await run(case2, d2, { proposer: modelProposer() });
        expect(result.outcome).toBe("verified");
        expect(result.attempts[1].proposal).toMatchObject({ model: "test-model", explanation: "cast and coalesce" });
        expect(sent).toHaveLength(1);
        const input = JSON.parse(sent[0].input);
        expect(input.evidence.differingColumns.length).toBeGreaterThan(0);
        expect(input.evidence.expectedColumns).toEqual(["cust_id", "contact_label", "clm_cnt", "tot_claimed", "avg_paid", "open_ratio"]);
        expect(input.mapping.length).toBeGreaterThan(10);
        expect(input.schema.tables.map((table: { name: string }) => table.name).sort()).toEqual(["claims", "customers", "policies"]);
        expect(sent[0].instructions).toMatch(/NEVER write the expected rows/);
        for (const name of ["Ines Alvarez", "Jonas Weber", "Olga Petrov"]) expect(sent[0].input).not.toContain(name);
        const audit = await getAuditStore().list();
        expect(audit.at(-1)).toMatchObject({ purpose: "correct-query", status: "ok" });
        expect(result.attempts[1].proposal?.auditId).toBeGreaterThan(0);
    });

    it("keeps the prompt itself in the trace: the same instructions and input the provider received", async () => {
        stub(candidate(case2, "correct.sql"));
        const result = await run(case2, d2, { proposer: modelProposer() });
        const recorded = JSON.parse(JSON.stringify(result)).attempts[1].proposal.prompt;
        expect(recorded.instructions).toBe(sent[0].instructions);
        expect(recorded.input).toEqual(JSON.parse(sent[0].input));
        expect(recorded.sha256).toMatch(/^[0-9a-f]{64}$/);
        // what is recorded is no more than what was sent: nothing held out, and no credential
        const everything = JSON.stringify(recorded);
        for (const name of ["Ines Alvarez", "Jonas Weber", "Olga Petrov"]) expect(everything).not.toContain(name);
        expect(everything).not.toMatch(/sk-[A-Za-z0-9]|OPENAI_API_KEY/);
    });

    it("sends the model's invalid answer to a human, not into the database", async () => {
        installOpenAiBackend({
            credentials: async () => ({ found: true, source: "OPENAI_API_KEY" }),
            respond: async () => ({ text: JSON.stringify({ explanation: "no sql here" }), inputTokens: null, outputTokens: null, stopReason: "end_turn" }),
            listModels: async () => [],
        });
        const result = await run(case2, d2, { proposer: modelProposer() });
        expect(result.reasons[0].code).toBe("proposer_failed");
        expect(result.reasons[0].message).toMatch(/invalid correction/);
    });

    it("sends a missing key to a human with the reason", async () => {
        installOpenAiBackend({ credentials: async () => ({ found: false, source: "", message: "OPENAI_API_KEY is empty" }), respond: async () => { throw new Error("must not be called"); }, listModels: async () => [] });
        const result = await run(case2, d2, { proposer: modelProposer() });
        expect(result.reasons[0]).toMatchObject({ code: "proposer_failed" });
        expect(result.reasons[0].message).toMatch(/OPENAI_API_KEY/);
    });
});

describe("replaying the committed recordings", () => {
    const reports = resolve(import.meta.dirname, "../reports");

    // Cases 2 and 3 are the ones whose recording holds a correction. Which databases they use is looked up when the test runs, after beforeAll.
    for (const [loaded, dbsOf] of [[case2, () => d2], [case3, () => d3]] as const) {
        const id = loaded.definition.id;

        it(`judges the recorded answer for ${id} again, live, and reaches the recorded outcome`, async () => {
            const recorded = readTrace(traceFile(reports, id));
            const result = await run(loaded, dbsOf(), { proposer: replayProposer(reports, id) });
            expect(result.outcome).toBe(recorded.outcome);
            expect(result.heldOut).toBe(recorded.heldOut);
            expect(result.attempts.map((attempt) => [attempt.n, attempt.verdict])).toEqual(recorded.attempts.map((attempt) => [attempt.n, attempt.verdict]));
            expect(result.finalSql).toBe(recorded.finalSql);
        });

        it(`says on every replayed attempt of ${id} that it is a replay, and it shows in the report`, async () => {
            const recorded = readTrace(traceFile(reports, id));
            const result = await run(loaded, dbsOf(), { proposer: replayProposer(reports, id) });
            const replayedAttempts = result.attempts.filter((attempt) => attempt.n > 0);
            expect(replayedAttempts.length).toBeGreaterThan(0);
            for (const attempt of replayedAttempts) {
                expect(attempt.source).toBe("replay");
                expect(attempt.proposal?.replayedFrom).toBe(relative(process.cwd(), traceFile(reports, id)));
                expect(attempt.proposal?.model, "the model of the recorded request").toBe(recorded.attempts.find((a) => a.n === attempt.n)?.proposal?.model);
            }
            const report = renderCaseReport(loaded, result);
            expect(report).toContain("(no model was called in this run)");
            expect(report).toContain("the recording shows what a model gave, not that it gives it today");
        });
    }

    it("sends the case to a human, with the reason, when the recording cannot be read, and makes no answer up", async () => {
        const dir = mkdtempSync(resolve(tmpdir(), "queryshift-replay-"));
        try {
            writeFileSync(traceFile(dir, "case-02"), "not json");
            const result = await run(case2, d2, { proposer: replayProposer(dir, "case-02") });
            expect(result.outcome).toBe("needs_human_review");
            expect(result.reasons[0]).toMatchObject({ code: "proposer_failed" });
            expect(result.reasons[0].message).toMatch(/cannot be read as a trace/);
            expect(result.attempts).toHaveLength(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

