/**
 * QueryShift harness.
 *
 *   npm run queryshift                         every case: each known candidate must be judged as its author said
 *   npm run queryshift -- --case queryshift/cases/case-01-outer-join-active-policies --candidate my_translation.sql
 *   npm run queryshift -- --engine             what GoForge's own rule engine makes of each legacy query, judged the same way
 *   npm run queryshift -- --loop               rule engine, then the correction loop; ends in verified or needs_human_review
 *       --proposer none|model                  who proposes corrections (default none: no model is called; model uses OPENAI_API_KEY from server/.env)
 *       --timeout-ms 10000                     wall-clock limit for one query (a query over it is stopped and reported as an error)
 *       --max-corrections 3                    the budget
 *       --out queryshift/reports               write each case's full trace as JSON
 *   npm run queryshift -- --json               machine-readable
 *
 * Exit code 1 when a candidate is judged differently from what its case says (a wrong translation accepted, a correct one refused), or,
 * with --candidate, when that candidate does not pass.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { convertQuery } from "../src/features/query-modernizer/engine/convert";
import type { LegacyDialect } from "../src/features/query-modernizer/types";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runLoop, type Proposer } from "./src/loop";
import { legacyNameViews, loadMapping } from "./src/mapping";
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

async function chooseProposer(): Promise<Proposer | undefined> {
    const choice = option("proposer") ?? "none";
    if (choice === "none") return undefined;
    if (choice !== "model") throw new Error(`--proposer must be none or model, not ${choice}`);
    createRequire(new URL("../server/package.json", import.meta.url))("dotenv").config({ path: resolve(import.meta.dirname, "../server/.env") });
    return (await import("./src/model-proposer")).modelProposer();
}

async function main(): Promise<number> {
    const json: unknown[] = [];
    let unexpected = 0;
    const single = option("candidate");
    const loopProposer = flag("loop") ? await chooseProposer() : undefined;

    for (const dir of caseDirs) {
        const loaded = loadCase(dir);
        const dbs = await databasesFor(loaded);
        const db = dbs.primary;
        const label = `${loaded.definition.id}  ${loaded.definition.title}`;

        if (flag("loop")) {
            const result = await runLoop({ loaded, db, heldOutDb: dbs.heldOut, proposer: loopProposer, maxCorrections: option("max-corrections") ? Number(option("max-corrections")) : undefined, timeoutMs: option("timeout-ms") ? Number(option("timeout-ms")) : undefined });
            json.push(result);
            const outDir = option("out");
            if (outDir) {
                mkdirSync(resolve(outDir), { recursive: true });
                writeFileSync(resolve(outDir, `${loaded.definition.id}.loop.json`), `${JSON.stringify(result, null, 2)}\n`);
            }
            if (!flag("json")) {
                console.log(`\n${label}\n  ${result.outcome === "verified" ? `VERIFIED (${result.heldOut === "passed" ? "primary and held-out data" : "primary data only: this case has no held-out data"})` : "NEEDS HUMAN REVIEW"}`);
                for (const attempt of result.attempts) {
                    console.log(`    attempt ${attempt.n} (${attempt.source}): ${mark(attempt.verdict)} ${attempt.summary}`);
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
    else if (flag("loop")) console.log(`\n${unexpected === 0 ? "Every case was verified." : `${unexpected} of ${caseDirs.length} case(s) need a human.`}`);
    else if (flag("engine")) console.log(`\n${unexpected === 0 ? "The rule engine's output matched on every case." : `The rule engine's output did not match on ${unexpected} of ${caseDirs.length} case(s).`}`);
    else if (!single) console.log(`\n${unexpected === 0 ? "Every candidate was judged as its case says." : `${unexpected} candidate(s) were judged differently from what the case says.`}`);
    return unexpected === 0 ? 0 : 1;
}

process.exit(await main());
