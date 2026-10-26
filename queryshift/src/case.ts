import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseBindValues, substituteBinds, type BindValues } from "./binds";
import { compareResults, parseExpected, type Category, type Comparison, type ExpectedTable } from "./compare";
import { analyzeCandidate, type Finding } from "./semantic";
import { CandidateRefused, CandidateTimeout, createDatabase, describeSchema, executeCandidate, scalar, type Database } from "./database";

export const RISK_CATEGORIES = ["date_or_time_semantics", "null_type_or_aggregation_semantics", "join_semantics", "silent_executable_failure"] as const;

/**
 * The one source dialect the harness reads end to end. The rule engine also converts mssql, mysql and db2, but the static checks
 * (semantic.ts) describe Oracle's behaviour (|| and NULL, (+), NVL, TRUNC, ADD_MONTHS). A case in another dialect would be judged by
 * checks that do not apply to it and could still come out "verified", so it is refused when the case is read.
 */
export const SUPPORTED_DIALECTS = ["oracle"] as const;

export type Invariant =
    | { name: string; kind: "row_count_equals"; sql: string }
    | { name: string; kind: "column_sum_equals"; column: string; sql: string };

export interface CaseDefinition {
    id: string;
    title: string;
    businessPurpose: string;
    difficulty: "easy" | "medium" | "hard";
    risks: (typeof RISK_CATEGORIES)[number][];
    legacyDialect: (typeof SUPPORTED_DIALECTS)[number];
    legacyQuery: string;
    expected: string;
    domain: string;
    /** Compare the order of the rows too, not just the set. True when the legacy query's ORDER BY fully determines the order. */
    orderSensitive: boolean;
    /** The values the reference result was produced with, for the bind variables the legacy query has (`{}` when it has none). */
    bindValues: BindValues;
    invariants: Invariant[];
    /** Reference result on the held-out data (domain/seed_heldout.sql). Absent: the case has no held-out check. */
    heldOutExpected?: string;
    candidates: { file: string; expect: "pass" | "fail"; /** Which data must expose a `fail` candidate: the primary data (default) or only the held-out data. */ catchBy: "primary" | "heldout"; /** The static findings (by id) the candidate must draw: exactly these, no others. Absent: not asserted. */ flags?: string[]; why: string }[];
}

/** Reads case.json and says exactly what is wrong with it: a case that is half-defined must not run. */
export function parseCaseDefinition(raw: unknown, where = "case.json"): CaseDefinition {
    const fail = (message: string): never => {
        throw new Error(`${where}: ${message}`);
    };
    if (typeof raw !== "object" || raw === null) return fail("must be a JSON object");
    const value = raw as Record<string, unknown>;
    const text = (key: string): string => (typeof value[key] === "string" && (value[key] as string).trim() !== "" ? (value[key] as string) : fail(`"${key}" must be a non-empty string`));
    const list = (key: string): unknown[] => (value[key] === undefined ? [] : Array.isArray(value[key]) ? (value[key] as unknown[]) : fail(`"${key}" must be a list`));

    const difficulty = text("difficulty");
    if (!["easy", "medium", "hard"].includes(difficulty)) fail(`"difficulty" must be easy, medium or hard`);
    const risks = list("risks");
    if (risks.length === 0 || !risks.every((risk) => (RISK_CATEGORIES as readonly string[]).includes(risk as string))) fail(`"risks" must be a non-empty list of: ${RISK_CATEGORIES.join(", ")}`);
    const legacyDialect = text("legacyDialect");
    if (!(SUPPORTED_DIALECTS as readonly string[]).includes(legacyDialect))
        fail(`"legacyDialect" is "${legacyDialect}", but this harness supports only: ${SUPPORTED_DIALECTS.join(", ")}. The static checks describe Oracle's behaviour, so a verified result for another dialect would rest on fewer checks than it appears to.`);

    const invariants = list("invariants").map((item, index): Invariant => {
        const entry = item as Record<string, unknown>;
        const name = typeof entry?.name === "string" ? entry.name : fail(`invariants[${index}] needs a name`);
        const sql = typeof entry?.sql === "string" ? entry.sql : fail(`invariants[${index}] needs sql`);
        if (entry.kind === "row_count_equals") return { name, kind: "row_count_equals", sql };
        if (entry.kind === "column_sum_equals" && typeof entry.column === "string") return { name, kind: "column_sum_equals", column: entry.column, sql };
        return fail(`invariants[${index}] must be row_count_equals, or column_sum_equals with a column`);
    });
    const candidates = list("candidates").map((item, index) => {
        const entry = item as Record<string, unknown>;
        if (typeof entry?.file !== "string" || (entry.expect !== "pass" && entry.expect !== "fail") || typeof entry.why !== "string") fail(`candidates[${index}] needs file, expect (pass or fail) and why`);
        if (entry.catchBy !== undefined && entry.catchBy !== "primary" && entry.catchBy !== "heldout") fail(`candidates[${index}].catchBy must be primary or heldout`);
        if (entry.catchBy === "heldout" && value.heldOutExpected === undefined) fail(`candidates[${index}] is caught by held-out data but the case has no heldOutExpected`);
        if (entry.flags !== undefined && !(Array.isArray(entry.flags) && entry.flags.every((flag) => typeof flag === "string"))) fail(`candidates[${index}].flags must be a list of finding ids`);
        return { file: entry.file as string, expect: entry.expect as "pass" | "fail", flags: entry.flags as string[] | undefined, catchBy: (entry.catchBy as "primary" | "heldout" | undefined) ?? "primary", why: entry.why as string };
    });

    return {
        id: text("id"),
        title: text("title"),
        businessPurpose: text("businessPurpose"),
        difficulty: difficulty as CaseDefinition["difficulty"],
        risks: risks as CaseDefinition["risks"],
        legacyDialect: legacyDialect as CaseDefinition["legacyDialect"],
        legacyQuery: text("legacyQuery"),
        expected: text("expected"),
        domain: typeof value.domain === "string" ? value.domain : "../../domain",
        orderSensitive: value.orderSensitive === true,
        bindValues: parseBindValues(value.bindValues, fail),
        heldOutExpected: typeof value.heldOutExpected === "string" ? value.heldOutExpected : undefined,
        invariants,
        candidates,
    };
}

export interface LoadedCase {
    dir: string;
    definition: CaseDefinition;
    /** The legacy query with the case's bind values written in as literals: what the rule engine converts, the static checks read and the model is shown. */
    legacySql: string;
    /** The legacy query as its file has it, bind variables and all. Equal to `legacySql` when the case declares none. */
    legacyTemplate: string;
    expected: ExpectedTable;
    schemaSql: string;
    seedSql: string;
    /** Data and reference result no model is ever shown evidence from. */
    heldOut?: { seedSql: string; expected: ExpectedTable };
}

export function loadCase(dir: string): LoadedCase {
    const root = resolve(dir);
    const definition = parseCaseDefinition(JSON.parse(readFileSync(resolve(root, "case.json"), "utf8")), `${dir}/case.json`);
    const domain = resolve(root, definition.domain);
    const legacyTemplate = readFileSync(resolve(root, definition.legacyQuery), "utf8");
    const bound = substituteBinds(legacyTemplate, definition.bindValues);
    if (bound.unused.length > 0) throw new Error(`${dir}/case.json: bindValues declares ${bound.unused.map((name) => `:${name}`).join(", ")}, which ${definition.legacyQuery} never uses`);
    return {
        dir: root,
        definition,
        legacySql: bound.sql,
        legacyTemplate,
        expected: parseExpected(readFileSync(resolve(root, definition.expected), "utf8")),
        schemaSql: readFileSync(resolve(domain, "target_schema.sql"), "utf8"),
        seedSql: readFileSync(resolve(domain, "seed_target.sql"), "utf8"),
        heldOut: definition.heldOutExpected
            ? { seedSql: readFileSync(resolve(domain, "seed_heldout.sql"), "utf8"), expected: parseExpected(readFileSync(resolve(root, definition.heldOutExpected), "utf8")) }
            : undefined,
    };
}

export interface InvariantResult {
    name: string;
    ok: boolean;
    detail: string;
}

/** `pass`: equivalent on every check. `fail`: ran, and something differs. `error`: PostgreSQL rejected it. `refused`: the guard did not let it run. */
export type Verdict = "pass" | "fail" | "error" | "refused";

export interface CandidateReport {
    verdict: Verdict;
    /** One line a person can act on. */
    summary: string;
    comparison?: Comparison;
    /** Columns the query returned, with how each is compared. */
    actualColumns?: { name: string; category: Category; typeOid?: number }[];
    /** The candidate was stopped because it ran longer than the limit. */
    timedOut?: boolean;
    invariants: InvariantResult[];
    sql: string;
}

const TOLERANCE = 1e-6;

async function checkInvariants(db: Database, invariants: Invariant[], columns: string[], rows: (string | null)[][], options: { timeoutMs?: number }): Promise<InvariantResult[]> {
    const results: InvariantResult[] = [];
    for (const invariant of invariants) {
        try {
            const reference = await scalar(db, invariant.sql, options);
            if (invariant.kind === "row_count_equals") {
                results.push({ name: invariant.name, ok: rows.length === reference, detail: `${rows.length} row(s) returned, ${reference} expected` });
            } else {
                const index = columns.findIndex((name) => name.toLowerCase() === invariant.column.toLowerCase());
                if (index < 0) {
                    results.push({ name: invariant.name, ok: false, detail: `the result has no column ${invariant.column}` });
                    continue;
                }
                const total = rows.reduce((sum, row) => sum + (row[index] === null ? 0 : Number(row[index])), 0);
                results.push({ name: invariant.name, ok: Number.isFinite(total) && Math.abs(total - reference) < TOLERANCE, detail: `sum of ${invariant.column} is ${total}, ${reference} expected` });
            }
        } catch (error) {
            results.push({ name: invariant.name, ok: false, detail: `the check itself failed: ${error instanceof Error ? error.message : String(error)}` });
        }
    }
    return results;
}

export async function evaluateCandidate(db: Database, loaded: LoadedCase, sql: string, expected: ExpectedTable = loaded.expected, options: { timeoutMs?: number } = {}): Promise<CandidateReport> {
    const { definition } = loaded;
    let table;
    try {
        table = await executeCandidate(db, sql, options);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof CandidateRefused) return { verdict: "refused", summary: `Not run: ${message}`, invariants: [], sql };
        if (error instanceof CandidateTimeout) return { verdict: "error", summary: `Stopped: ${message}`, invariants: [], sql, timedOut: true };
        return { verdict: "error", summary: `PostgreSQL rejected it: ${message}`, invariants: [], sql };
    }
    const comparison = compareResults(expected, table, { orderSensitive: definition.orderSensitive });
    const invariants = await checkInvariants(db, definition.invariants, table.columns.map((column) => column.name), table.rows, options);
    const broken = invariants.filter((invariant) => !invariant.ok);
    const passed = comparison.passed && broken.length === 0;
    const summary = passed
        ? `Matches the reference result and all ${invariants.length} invariant(s) hold.`
        : [comparison.passed ? "" : comparison.message, ...broken.map((invariant) => `Invariant broken: ${invariant.name} (${invariant.detail}).`)].filter(Boolean).join(" ");
    return { verdict: passed ? "pass" : "fail", summary, comparison, actualColumns: table.columns, invariants, sql };
}

export interface CandidateRun {
    file: string;
    expect: "pass" | "fail";
    catchBy: "primary" | "heldout";
    why: string;
    report: CandidateReport;
    /** The same query on the held-out data. Absent when the case has none. */
    heldOut?: CandidateReport;
    /** What the static checks say about the query text. */
    findings: Finding[];
    /** The findings are exactly the ones the case declares (true when it declares none). */
    flagsAsExpected: boolean;
    /** The harness did what the case author said it must: accepted the correct translation (on both datasets), and did not accept a known-wrong one where it was meant to be caught. */
    asExpected: boolean;
}

/** The query on the primary data and, where the case has held-out data, on that too. */
export async function evaluateOnBoth(dbs: { primary: Database; heldOut?: Database }, loaded: LoadedCase, sql: string): Promise<{ primary: CandidateReport; heldOut?: CandidateReport }> {
    const primary = await evaluateCandidate(dbs.primary, loaded, sql);
    const heldOut = loaded.heldOut && dbs.heldOut ? await evaluateCandidate(dbs.heldOut, loaded, sql, loaded.heldOut.expected) : undefined;
    return { primary, heldOut };
}

export async function runKnownCandidates(dbs: { primary: Database; heldOut?: Database }, loaded: LoadedCase): Promise<CandidateRun[]> {
    const runs: CandidateRun[] = [];
    const schema = await describeSchema(dbs.primary);
    for (const candidate of loaded.definition.candidates) {
        const sql = readFileSync(resolve(loaded.dir, candidate.file), "utf8");
        const { primary, heldOut } = await evaluateOnBoth(dbs, loaded, sql);
        const findings = await analyzeCandidate({ legacySql: loaded.legacySql, sql, schema, resultColumns: primary.actualColumns });
        const ids = [...new Set(findings.map((finding) => finding.id))].sort();
        const flagsAsExpected = candidate.flags === undefined || JSON.stringify(ids) === JSON.stringify([...candidate.flags].sort());
        const asExpected =
            candidate.expect === "pass"
                ? primary.verdict === "pass" && (heldOut === undefined || heldOut.verdict === "pass")
                : candidate.catchBy === "heldout"
                  ? // must get past the primary data and be stopped by the held-out data: that is the whole point of having it
                    primary.verdict === "pass" && heldOut !== undefined && heldOut.verdict !== "pass"
                  : primary.verdict !== "pass";
        runs.push({ ...candidate, report: primary, heldOut, findings, flagsAsExpected, asExpected: asExpected && flagsAsExpected });
    }
    return runs;
}

/** One database per dataset, built once and reused: every statement against it is read-only. */
export async function databaseFor(loaded: LoadedCase, dataset: "primary" | "heldout" = "primary"): Promise<Database> {
    if (dataset === "heldout") {
        if (!loaded.heldOut) throw new Error(`${loaded.definition.id} has no held-out data`);
        return createDatabase(loaded.schemaSql, loaded.heldOut.seedSql);
    }
    return createDatabase(loaded.schemaSql, loaded.seedSql);
}

export async function databasesFor(loaded: LoadedCase): Promise<{ primary: Database; heldOut?: Database; close(): Promise<void> }> {
    const primary = await databaseFor(loaded);
    const heldOut = loaded.heldOut ? await databaseFor(loaded, "heldout") : undefined;
    return { primary, heldOut, close: async () => void (await Promise.all([primary.close(), heldOut?.close()])) };
}

export const caseDirectory = (dir: string) => dirname(resolve(dir, "case.json"));
