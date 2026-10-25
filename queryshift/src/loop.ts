import { convertQuery } from "../../src/features/query-modernizer/engine/convert";
import type { LegacyDialect } from "../../src/features/query-modernizer/types";
import { databaseFor, evaluateCandidate, type CandidateReport, type LoadedCase, type Verdict } from "./case";
import { describeSchema, type Database, type SchemaTable } from "./database";
import { diagnose, type Evidence } from "./diagnose";
import { analyzeCandidate, type Finding } from "./semantic";
import { applyMapping } from "./mapping-apply";
import { loadMapping, type MappingRow } from "./mapping";
import { skeleton } from "./sql-guard";
import { resolve } from "node:path";

/**
 * The correction loop. Start from the rule engine's conversion (deterministic), rename it to the target schema from the mapping
 * (deterministic), run it read-only and compare it with the reference result. If it matches, it is verified. If it does not, a proposer
 * is shown the measured difference and asked for a corrected query, up to a fixed number of corrections. Every query goes through the
 * same guard, run and comparison; the proposer never decides that it is right.
 *
 * Every query is also read by the static checks (`semantic.ts`): deterministic observations about its text (an outer join filtered in WHERE,
 * integer division, ||, ...). They are shown to the proposer as suspects next to the measured evidence, and listed for the reviewer. One
 * kind is blocking: a comparison with a value the legacy query never had. A query that passes every dataset and contains one is not verified.
 *
 * A query that passes is then run on HELD-OUT data (a second dataset with its own hand-derived reference result). Nothing measured there is
 * ever given to a proposer: a query that passes the data the proposer saw evidence from and fails on data it did not see is a query that
 * was fitted to the evidence, and it goes to a human instead of being corrected against the held-out data.
 *
 * The loop ends in exactly one of two outcomes:
 *   verified            the query matched the reference result and every invariant on the primary data, and on the held-out data when
 *                       the case has some (the result says which). That is all "verified" claims.
 *   needs_human_review  it did not, and the reasons say why: no proposer, the budget used up, no progress, a query that reproduces the
 *                       evidence instead of fixing the logic, a query the guard refused, a proposer that failed, or a query that fails
 *                       on the held-out data.
 * Nothing in between, and no confidence score.
 */

export const DEFAULT_MAX_CORRECTIONS = 3;

export interface ProposalInput {
    loaded: LoadedCase;
    schema: SchemaTable[];
    mapping: MappingRow[];
    previousSql: string;
    /** 1-based number of this correction. */
    attempt: number;
    maxAttempts: number;
    evidence: Evidence;
    engineWarnings: string[];
}

export interface Proposal {
    sql: string;
    explanation?: string;
    changes?: string[];
    /** The proposer's own words; nothing checks them. */
    risks?: string[];
    model?: string;
    /** The entry in the AI audit log for this request. */
    auditId?: number;
    /** Tokens the provider reported for this request, when it did. */
    usage?: { inputTokens: number | null; outputTokens: number | null };
    latencyMs?: number;
    /** Exactly what the model was sent for this request, as the AI layer's audit log recorded it, so the trace does not ask to be taken on trust. */
    prompt?: { instructions: string; input: unknown; sha256?: string };
    /** Set when this answer was read back from an earlier trace and not asked for now (see replay-proposer.ts). Everything else in the proposal then describes that earlier request. */
    replayedFrom?: string;
}

export interface Proposer {
    name: string;
    propose(input: ProposalInput): Promise<Proposal>;
}

export type Outcome = "verified" | "needs_human_review";

export type ReviewCode = "no_proposer" | "budget_exhausted" | "stalled" | "hard_coded" | "guard_refused" | "proposer_failed" | "bind_parameters" | "fails_held_out" | "static_finding";

export interface Attempt {
    /** 0 is the rule engine's conversion; 1... are corrections. */
    n: number;
    source: string;
    sql: string;
    verdict: Verdict;
    summary: string;
    evidence?: Evidence;
    proposal?: Omit<Proposal, "sql">;
    /** The held-out result, for a query that passed the primary data. For the reviewer; never sent to a proposer. */
    heldOut?: { verdict: Verdict; summary: string; evidence?: Evidence };
    /** What the static checks saw in this query's text. */
    findings: Finding[];
}

export interface LoopResult {
    caseId: string;
    outcome: Outcome;
    reasons: { code: ReviewCode; message: string }[];
    /** Static findings on the final query. On a verified result these are warnings a reviewer should still read; a blocking one stops verification. */
    findings: Finding[];
    /** `passed` or `failed` on the held-out data, or `none` when the case has no held-out data (a verified result then rests on the primary data alone). */
    heldOut: "passed" | "failed" | "none";
    /** The query that matched (verified) or the last one tried (needs_human_review). */
    finalSql: string;
    attempts: Attempt[];
    maxCorrections: number;
    /** What the rule engine reported about the original query: traps and constructs it left alone. A reviewer reads these either way. */
    engineWarnings: string[];
    /** The proposer's own stated uncertainties. Unverified. */
    proposerRisks: string[];
}

const normalizeSql = (sql: string) => sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/[\s;]+/g, " ").trim().toLowerCase();

const literals = (sql: string): Set<string> => new Set([...sql.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replace(/''/g, "'")));

/**
 * Why a proposed query looks like the evidence written back as SQL instead of a fix, or null. Three signs: it reads no table, it has a
 * VALUES list the legacy query did not, or it carries three or more string literals that appear in the evidence rows and in neither the
 * legacy query nor the previous query. A first line only; the real defence is that the query is also meant to be run on other data.
 */
export function hardCodingSuspicion(sql: string, context: { legacySql: string; previousSql: string; schema: SchemaTable[]; evidence: Evidence }): string | null {
    const flat = skeleton(sql) ?? "";
    const words = new Set(flat.match(/[a-z_][a-z0-9_$]*/g) ?? []);
    if (!context.schema.some((table) => words.has(table.name.toLowerCase()))) return "The query does not read any table of the target schema.";
    const legacyFlat = skeleton(context.legacySql) ?? "";
    if (/\bvalues\s*\(/.test(flat) && !/\bvalues\s*\(/.test(legacyFlat)) return "The query contains a VALUES list that the legacy query does not have.";
    const known = new Set([...literals(context.legacySql), ...literals(context.previousSql)]);
    const copied = [...literals(sql)].filter((value) => value.length >= 2 && !known.has(value));
    const cells = new Set([...context.evidence.missingRows, ...context.evidence.unexpectedRows].flat().filter((cell): cell is string => cell !== null));
    const matching = copied.filter((value) => cells.has(value));
    if (matching.length >= 3) return `The query carries ${matching.length} string literals copied from the evidence rows (${matching.slice(0, 3).map((value) => JSON.stringify(value)).join(", ")}).`;
    return null;
}

export async function runLoop(options: { loaded: LoadedCase; db: Database; /** Reused when given; otherwise built (and closed) here. */ heldOutDb?: Database; proposer?: Proposer; maxCorrections?: number; /** Wall-clock limit for one query, in ms. */ timeoutMs?: number }): Promise<LoopResult> {
    const heldOutDb = loadedHeldOut(options);
    try {
        return await runLoopOn(options, await heldOutDb);
    } finally {
        if (!options.heldOutDb) await (await heldOutDb)?.close();
    }
}

async function loadedHeldOut(options: { loaded: LoadedCase; heldOutDb?: Database }): Promise<Database | undefined> {
    if (!options.loaded.heldOut) return undefined;
    return options.heldOutDb ?? databaseFor(options.loaded, "heldout");
}

async function runLoopOn(options: { loaded: LoadedCase; db: Database; proposer?: Proposer; maxCorrections?: number; timeoutMs?: number }, heldOutDb: Database | undefined): Promise<LoopResult> {
    const { loaded, db, proposer } = options;
    const maxCorrections = options.maxCorrections ?? DEFAULT_MAX_CORRECTIONS;
    const limits = { timeoutMs: options.timeoutMs };
    const attempts: Attempt[] = [];
    const reasons: LoopResult["reasons"] = [];
    const proposerRisks: string[] = [];
    const mapping = loadMapping(resolve(loaded.dir, loaded.definition.domain));
    const schema = await describeSchema(db);
    const read = (sql: string, report?: CandidateReport) => analyzeCandidate({ legacySql: loaded.legacySql, sql, schema, resultColumns: report?.actualColumns });
    const suspects = (findings: Finding[]) => findings.map(({ id, title, detail }) => ({ id, title, detail }));

    const conversion = convertQuery({ sql: loaded.legacySql, dialect: loaded.definition.legacyDialect as LegacyDialect });
    const engineWarnings = [...conversion.traps.map((trap) => trap.title), ...conversion.unconverted.map((item) => `Not converted: ${item.construct} (${item.reason})`)];
    let heldOut: LoopResult["heldOut"] = heldOutDb ? "passed" : "none";
    const finish = (outcome: Outcome): LoopResult => ({
        caseId: loaded.definition.id,
        outcome,
        heldOut,
        findings: attempts[attempts.length - 1].findings,
        reasons,
        finalSql: attempts[attempts.length - 1].sql,
        attempts,
        maxCorrections,
        engineWarnings,
        proposerRisks,
    });

    /** Runs a query that passed the primary data on the held-out data. False (with the reason recorded) when it does not hold up there. */
    const holdsUp = async (attempt: Attempt): Promise<boolean> => {
        if (!heldOutDb || !loaded.heldOut) return true;
        const result = await evaluateCandidate(heldOutDb, loaded, attempt.sql, loaded.heldOut.expected, limits);
        attempt.heldOut = { verdict: result.verdict, summary: result.summary, evidence: result.verdict === "pass" ? undefined : diagnose({ ...loaded, expected: loaded.heldOut.expected }, result) };
        if (result.verdict === "pass") return true;
        heldOut = "failed";
        reasons.push({ code: "fails_held_out", message: `It matched the primary data and does not match the held-out data (${result.summary}). It was probably fitted to the evidence; it is not corrected against held-out data, which no model is shown.` });
        return false;
    };

    /** A query that passed the data is accepted unless it holds a blocking finding or fails the held-out data. */
    const accepted = async (attempt: Attempt): Promise<boolean> => {
        if (!(await holdsUp(attempt))) return false;
        const blocking = attempt.findings.filter((finding) => finding.severity === "blocking");
        if (blocking.length === 0) return true;
        reasons.push({ code: "static_finding", message: `It matches the data, but ${blocking.map((finding) => `${finding.title}: ${finding.detail}`).join(" ")}` });
        return false;
    };

    // ---- attempt 0: the rule engine, then the mapping
    const mapped = applyMapping(conversion.sql, mapping, loaded.definition.legacyDialect as "oracle");
    let report: CandidateReport;
    if (conversion.syntaxError || mapped.issues.length > 0) {
        const problem = conversion.syntaxError ?? mapped.issues.join(" ");
        report = { verdict: "error", summary: `Not run: ${problem}`, invariants: [], sql: mapped.sql };
    } else report = await evaluateCandidate(db, loaded, mapped.sql, loaded.expected, limits);
    const findings0 = await read(mapped.sql, report);
    attempts.push({ n: 0, source: "rule-engine", sql: mapped.sql, verdict: report.verdict, summary: report.summary, findings: findings0, evidence: report.verdict === "pass" ? undefined : { ...diagnose(loaded, report), staticFindings: suspects(findings0) } });
    if (conversion.parameters.length > 0) {
        reasons.push({ code: "bind_parameters", message: `The legacy query has bind variables the case gives no value for (${conversion.parameters.join(", ")}). The reference result belongs to particular values, so the converted query cannot be run and compared until case.json declares them under "bindValues". No model is asked: nothing it proposed could be checked.` });
        return finish("needs_human_review");
    }
    if (report.verdict === "pass") return finish((await accepted(attempts[0])) ? "verified" : "needs_human_review");

    // ---- corrections
    const seen = new Set([normalizeSql(mapped.sql)]);
    let previous = attempts[0];
    for (let correction = 1; correction <= maxCorrections; correction++) {
        if (!proposer) {
            reasons.push({ code: "no_proposer", message: `No model is configured, so nothing can correct the rule engine's query. It was judged: ${previous.summary}` });
            return finish("needs_human_review");
        }
        const evidence = previous.evidence ?? diagnose(loaded, { verdict: previous.verdict, summary: previous.summary, invariants: [], sql: previous.sql });
        let proposal: Proposal;
        try {
            proposal = await proposer.propose({ loaded, schema, mapping, previousSql: previous.sql, attempt: correction, maxAttempts: maxCorrections, evidence, engineWarnings });
        } catch (error) {
            reasons.push({ code: "proposer_failed", message: `The model could not be asked: ${error instanceof Error ? error.message : String(error)}` });
            return finish("needs_human_review");
        }
        const { sql, ...details } = proposal;
        proposerRisks.push(...(proposal.risks ?? []).filter((risk) => !proposerRisks.includes(risk)));

        const note = (verdict: Verdict, summary: string, findings: Finding[] = []): Attempt => ({ n: correction, source: proposer.name, sql, verdict, summary, findings, proposal: details });
        if (seen.has(normalizeSql(sql))) {
            attempts.push(note(previous.verdict, "The proposer returned a query it had already been judged on."));
            reasons.push({ code: "stalled", message: "The proposer returned a query that was already tried: there is no progress to wait for." });
            return finish("needs_human_review");
        }
        seen.add(normalizeSql(sql));
        const suspicion = hardCodingSuspicion(sql, { legacySql: loaded.legacySql, previousSql: previous.sql, schema, evidence });
        if (suspicion) {
            attempts.push(note("refused", `Not run: ${suspicion}`));
            reasons.push({ code: "hard_coded", message: `${suspicion} A query that reproduces the evidence is not a fix.` });
            return finish("needs_human_review");
        }

        report = await evaluateCandidate(db, loaded, sql, loaded.expected, limits);
        const findings = await read(sql, report);
        const attempt: Attempt = { ...note(report.verdict, report.summary, findings), evidence: report.verdict === "pass" ? undefined : { ...diagnose(loaded, report), staticFindings: suspects(findings) } };
        attempts.push(attempt);
        if (report.verdict === "pass") return finish((await accepted(attempt)) ? "verified" : "needs_human_review");
        if (report.verdict === "refused") {
            reasons.push({ code: "guard_refused", message: `The proposed query was not allowed to run (${report.summary.replace(/^Not run: /, "")}). It is not corrected again.` });
            return finish("needs_human_review");
        }
        previous = attempt;
    }
    reasons.push({ code: "budget_exhausted", message: `Still not matching after ${maxCorrections} correction(s). Last result: ${previous.summary}` });
    return finish("needs_human_review");
}
