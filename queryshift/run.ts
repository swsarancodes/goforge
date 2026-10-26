/**
 * QueryShift harness.
 *
 *   npm run queryshift                         every case: each known candidate must be judged as its author said
 *   npm run queryshift -- --case queryshift/cases/case-01-outer-join-active-policies --candidate my_translation.sql
 *   npm run queryshift -- --engine             what GoForge's own rule engine makes of each legacy query, judged the same way
 *   npm run queryshift -- --loop               rule engine, then the correction loop; ends in verified or needs_human_review
 *       --proposer none|model|replay           who proposes corrections (default none: no model is called; model uses OPENAI_API_KEY from server/.env;
 *                                              replay plays back the answers recorded in --replay-from, labelled as a replay, calling no model)
 *       --replay-from queryshift/reports       the folder of <case>.loop.json traces that replay reads
 *       --timeout-ms 10000                     wall-clock limit for one query (a query over it is stopped and reported as an error)
 *       --max-corrections 3                    the budget
 *       --out queryshift/reports               write each case's full trace as JSON, and its validation report as Markdown
 *   npm run queryshift -- --report-from queryshift/reports
 *                                              write the Markdown report of each case from a trace already on disk (runs nothing)
 *   npm run queryshift -- --json               machine-readable
 *
 * Exit code 1 when a candidate is judged differently from what its case says (a wrong translation accepted, a correct one refused), or,
 * with --candidate, when that candidate does not pass.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { convertQuery } from "../src/features/query-modernizer/engine/convert";
import type { LegacyDialect } from "../src/features/query-modernizer/types";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runLoop, type Attempt, type Proposer } from "./src/loop";
import { legacyNameViews, loadMapping } from "./src/mapping";
import { renderCaseReport } from "./src/report";
import { readTrace, replayProposer, traceFile } from "./src/replay-proposer";
import { databasesFor, evaluateCandidate, evaluateOnBoth, loadCase, runKnownCandidates, type CandidateReport, type CandidateRun } from "./src/case";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
};

const casesRoot = resolve(import.meta.dirname, "cases");
const caseDirs = option("case")
    ? [resolve(option("case")!)]
    : readdirSync(casesRoot).map((name) => resolve(casesRoot, name)).filter((path) => statSync(path).isDirectory()).sort();

const mark = (verdict: string) => ({ pass: "PASS   ", fail: "FAIL   ", error: "ERROR  ", refused: "REFUSED" })[verdict] ?? verdict;

const replayDir = resolve(option("replay-from") ?? resolve(import.meta.dirname, "reports"));

/** A mistake in how the command was written: said in one line, without a stack trace. */
class UsageError extends Error {}

/** Who answers when the loop asks for a correction: nobody, a model, or the recording of an earlier run. Chosen per case, because a recording is. */
async function chooseProposer(): Promise<(caseId: string) => Proposer | undefined> {
    const choice = option("proposer") ?? "none";
    if (choice === "none") return () => undefined;
    if (choice === "replay") {
        if (option("out") && resolve(option("out")!) === replayDir) throw new UsageError(`--out is ${relative(process.cwd(), replayDir) || "."}, the folder being replayed: the replay's traces would overwrite the recordings it plays back. Write them somewhere else.`);
        return (caseId) => replayProposer(replayDir, caseId);
    }
    if (choice !== "model") throw new UsageError(`--proposer must be none, model or replay, not ${choice}`);
    createRequire(new URL("../server/package.json", import.meta.url))("dotenv").config({ path: resolve(import.meta.dirname, "../server/.env") });
    const proposer = (await import("./src/model-proposer")).modelProposer();
    return () => proposer;
}

/** Who made an attempt, said so that a replay cannot be mistaken for a live call. */
const sourceOf = (attempt: Attempt) => (attempt.proposal?.replayedFrom ? `replay of the recorded ${attempt.proposal.model ?? "answer"}, not a live call` : attempt.source);

function writeReports(outDir: string, caseId: string, files: { json?: unknown; markdown?: string }) {
    mkdirSync(resolve(outDir), { recursive: true });
    if (files.json !== undefined) writeFileSync(resolve(outDir, `${caseId}.loop.json`), `${JSON.stringify(files.json, null, 2)}\n`);
    if (files.markdown !== undefined) writeFileSync(resolve(outDir, `${caseId}.report.md`), files.markdown);
}

async function main(): Promise<number> {
    const json: unknown[] = [];
    let unexpected = 0;
    let skipped = 0;
    const single = option("candidate");

    const reportFrom = option("report-from");
    if (reportFrom) {
        for (const dir of caseDirs) {
            const loaded = loadCase(dir);
            writeReports(option("out") ?? reportFrom, loaded.definition.id, { markdown: renderCaseReport(loaded, readTrace(traceFile(resolve(reportFrom), loaded.definition.id))) });
            console.log(`wrote ${relative(process.cwd(), resolve(option("out") ?? reportFrom, `${loaded.definition.id}.report.md`))}`);
        }
        return 0;
    }

    const proposerFor = flag("loop") ? await chooseProposer() : () => undefined;
    let replayed = false;

    for (const dir of caseDirs) {
        const loaded = loadCase(dir);
        const dbs = await databasesFor(loaded);
        const db = dbs.primary;
        const label = `${loaded.definition.id}  ${loaded.definition.title}`;

        if (flag("loop")) {
            const result = await runLoop({ loaded, db, heldOutDb: dbs.heldOut, proposer: proposerFor(loaded.definition.id), maxCorrections: option("max-corrections") ? Number(option("max-corrections")) : undefined, timeoutMs: option("timeout-ms") ? Number(option("timeout-ms")) : undefined });
            json.push(result);
            replayed ||= result.attempts.some((attempt) => attempt.proposal?.replayedFrom);
            const outDir = option("out");
            if (outDir) writeReports(outDir, loaded.definition.id, { json: result, markdown: renderCaseReport(loaded, result) });
            if (!flag("json")) {
                console.log(`\n${label}\n  ${result.outcome === "verified" ? `VERIFIED (${result.heldOut === "passed" ? "primary and held-out data" : "primary data only: this case has no held-out data"})` : "NEEDS HUMAN REVIEW"}`);
                for (const attempt of result.attempts) {
                    console.log(`    attempt ${attempt.n} (${sourceOf(attempt)}): ${mark(attempt.verdict)} ${attempt.summary}`);
                    if (attempt.heldOut) console.log(`      held-out data: ${mark(attempt.heldOut.verdict)} ${attempt.heldOut.summary}`);
                    for (const finding of attempt.findings) console.log(`      static (${finding.severity}): ${finding.id}: ${finding.title}`);
                }
                for (const reason of result.reasons) console.log(`    why: [${reason.code}] ${reason.message}`);
                if (result.engineWarnings.length) console.log(`    rule-engine warnings: ${result.engineWarnings.join("; ")}`);
                const last = result.attempts[result.attempts.length - 1].evidence;
                if (result.outcome !== "verified" && last?.differingColumns.length) console.log(`    last evidence: rows differ in ${last.differingColumns.map((c) => `${c.column} (${c.rows})`).join(", ")}`);
            }
            if (result.outcome !== "verified") unexpected++;
        } else if (flag("engine")) {
            await db.exec(legacyNameViews(loadMapping(resolve(loaded.dir, loaded.definition.domain))));
            const conversion = convertQuery({ sql: loaded.legacySql, dialect: loaded.definition.legacyDialect as LegacyDialect });
            if (conversion.parameters.length > 0) {
                // No reference result belongs to a bind variable nobody gave a value for: there is nothing to judge the engine's query against.
                json.push({ case: loaded.definition.id, engine: true, needsPerson: true, parameters: conversion.parameters });
                if (!flag("json")) console.log(`${label}\n  NEEDS A PERSON: bind variable(s) ${conversion.parameters.map((name) => (name.startsWith(":") ? name : `:${name}`)).join(", ")} have no value in the case, so there is no reference result and the rule engine's query is not judged.`);
                skipped++;
                await dbs.close();
                continue;
            }
            const report: CandidateReport = await evaluateCandidate(db, loaded, conversion.validationSql);
            json.push({ case: loaded.definition.id, engine: true, convertedSql: conversion.sql, traps: conversion.traps.map((trap) => trap.title), unconverted: conversion.unconverted.length, ...report });
            if (!flag("json")) {
                console.log(`${label}\n  ${mark(report.verdict)} rule engine: ${report.summary}`);
                console.log(`    traps reported: ${conversion.traps.length}${conversion.traps.map((trap) => `\n      - ${trap.title}`).join("")}\n    left unconverted: ${conversion.unconverted.length}${conversion.unconverted.map((item) => `\n      - ${JSON.stringify(item)}`).join("")}`);
                if (flag("show-sql")) console.log(`    converted SQL:\n${conversion.sql.replace(/^/gm, "      ")}`);
            }
            if (report.verdict !== "pass") unexpected++;
        } else if (single) {
            const both = await evaluateOnBoth(dbs, loaded, readFileSync(resolve(single), "utf8"));
            const report: CandidateReport = both.primary;
            json.push({ case: loaded.definition.id, candidate: single, ...report, heldOut: both.heldOut });
            if (!flag("json")) {
                console.log(`${label}\n  ${mark(report.verdict)} primary data: ${report.summary}`);
                if (both.heldOut) console.log(`  ${mark(both.heldOut.verdict)} held-out data: ${both.heldOut.summary}`);
                for (const row of report.comparison?.missing ?? []) console.log(`    missing:    ${JSON.stringify(row)}`);
                for (const row of report.comparison?.additional ?? []) console.log(`    unexpected: ${JSON.stringify(row)}`);
            }
            if (report.verdict !== "pass" || (both.heldOut && both.heldOut.verdict !== "pass")) unexpected++;
        } else {
            const runs: CandidateRun[] = await runKnownCandidates(dbs, loaded);
            json.push({ case: loaded.definition.id, risks: loaded.definition.risks, runs: runs.map(({ file, expect, catchBy, report, heldOut, findings, asExpected }) => ({ file, expect, catchBy, verdict: report.verdict, heldOutVerdict: heldOut?.verdict, findings: findings.map((finding) => finding.id), asExpected, summary: report.summary, heldOutSummary: heldOut?.summary })) });
            if (!flag("json")) {
                console.log(`\n${label}  [${loaded.definition.risks.join(", ")}]\n  ok/!!  primary  held-out`);
                for (const run of runs) {
                    console.log(`  ${run.asExpected ? "ok " : "!! "} ${mark(run.report.verdict)} ${run.heldOut ? mark(run.heldOut.verdict) : "       "} ${run.file.replace("candidates/", "").padEnd(40)} ${run.report.verdict === "pass" && run.heldOut ? `held-out: ${run.heldOut.summary}` : run.report.summary}${run.findings.length ? `\n${" ".repeat(10)}static: ${[...new Set(run.findings.map((finding) => finding.id))].join(", ")}${run.flagsAsExpected ? "" : "   <-- not what the case declares"}` : ""}`);
                }
            }
            unexpected += runs.filter((run) => !run.asExpected).length;
        }
        await dbs.close();
    }

    if (flag("json")) console.log(JSON.stringify(json, null, 2));
    else if (flag("loop")) {
        console.log(`\n${unexpected === 0 ? "Every case was verified." : `${unexpected} of ${caseDirs.length} case(s) need a human.`}`);
        if (replayed) console.log(`The corrections above were read from ${relative(process.cwd(), replayDir)}: no model was called. Every query, recorded or not, was run again just now.`);
    }
    else if (flag("engine")) console.log(`\n${unexpected === 0 ? "The rule engine's output matched on every case it could be judged on." : `The rule engine's output did not match on ${unexpected} of ${caseDirs.length - skipped} judged case(s).`}${skipped ? ` ${skipped} case(s) need a person and were not judged.` : ""}`);
    else if (!single) console.log(`\n${unexpected === 0 ? "Every candidate was judged as its case says." : `${unexpected} candidate(s) were judged differently from what the case says.`}`);
    return unexpected === 0 ? 0 : 1;
}

process.exit(
    await main().catch((error) => {
        if (!(error instanceof UsageError)) throw error;
        console.error(`queryshift: ${error.message}`);
        return 2;
    }),
);
