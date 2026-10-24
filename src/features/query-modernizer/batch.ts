import type { QueryModernizationRequest } from "@/lib/ai-api";
import { ModernizeDeps, ModernizeOutcome, modernize } from "./modernize";
import { ScriptUnit, UNIT_KIND_LABELS, UnitKind, splitScript } from "./engine/script";
import type { LegacyDialect, SchemaContext } from "./types";

/**
 * Converting a whole file: the file is split into statements, every query goes through exactly the same path as a single
 * query (the rules, then PostgreSQL's own answer, then, only where those leave a gap, the model), and every statement ends
 * up with one status and the plain facts that led to it. Nothing is scored. Statements that are not queries (procedures,
 * schema statements, client commands) are listed and counted, never converted and never called failures.
 */

export type BatchStatus =
    /** The rules converted it and nothing was left over; PostgreSQL (or, without a connection, a PostgreSQL grammar) accepts the result. */
    | "converted"
    /** No rule had anything to change and PostgreSQL (or the grammar) accepts it as it is. */
    | "unchanged"
    /** Converted, but a person should look: behaviour that differs, bind variables, a model's answer, names the connection could not resolve. */
    | "review"
    /** Not converted, or the result is not accepted. */
    | "failed"
    /** Not a query: a procedure, a schema statement, a client command. Not converted and not counted as a failure. */
    | "out-of-scope";

export const BATCH_STATUSES: BatchStatus[] = ["converted", "unchanged", "review", "failed", "out-of-scope"];

export const STATUS_LABELS: Record<BatchStatus, string> = {
    converted: "Converted",
    unchanged: "Already PostgreSQL",
    review: "Needs review",
    failed: "Failed",
    "out-of-scope": "Out of scope",
};

/** How the converted SQL was checked: by the database itself, by a PostgreSQL grammar only, or not at all. */
export type Verification = "database" | "syntax" | "none";

export interface BatchItem {
    unit: ScriptUnit;
    status: BatchStatus;
    verification: Verification;
    /** Why it has this status, one fact each. */
    reasons: string[];
    /** Other things worth knowing that do not change the status. */
    notes: string[];
    outcome?: ModernizeOutcome;
    /** Index of the earlier, identical statement this one reuses the answer of. */
    repeatOf?: number;
}

// SQLSTATEs that mean "a name does not resolve here": the table, column or schema is missing on this connection. Only counted as such when the rules left nothing unconverted.
const NAME_ERRORS = new Set(["42P01", "42703", "3F000", "42P02"]);

const clip = (text: string, length = 140): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** `TRUNC(hired)` and `TRUNC(salary)` are the same thing to count: the function, or the first words of the construct. */
export function constructFamily(construct: string): string {
    const text = oneLine(construct);
    const call = /^([A-Za-z_][\w.$#]*)\s*\(/.exec(text);
    return call ? `${call[1].toUpperCase()}(…)` : clip(text.split(" ").slice(0, 3).join(" ").toUpperCase(), 60);
}

const SCOPE_HINTS: Record<Exclude<UnitKind, "query">, string> = {
    procedural: "Procedures, functions, packages, triggers and blocks are not translated, and the queries inside them are not checked.",
    ddl: "Schema statements (tables, indexes, views, grants) are outside the query converter: data types, sequences and constraints differ between databases.",
    session: "A session or client command: PostgreSQL has no query form of it. Remove it, or use the matching psql or driver setting.",
    other: "The statement starts with a word the splitter does not recognise, so it was left alone.",
};

export function outOfScope(unit: ScriptUnit): BatchItem {
    const kind = unit.kind === "query" ? "other" : unit.kind;
    return {
        unit,
        status: "out-of-scope",
        verification: "none",
        reasons: [`${UNIT_KIND_LABELS[kind][0].toUpperCase()}${UNIT_KIND_LABELS[kind].slice(1)}, starting with ${unit.keyword}.`, SCOPE_HINTS[kind], ...(unit.note ? [`This statement ${unit.note}.`] : [])],
        notes: [],
    };
}

/** The status of one converted query, and why. Pure: everything it says is in the outcome. */
export function classifyOutcome(outcome: ModernizeOutcome): Pick<BatchItem, "status" | "verification" | "reasons" | "notes"> {
    const { engine, postgres, syntax } = outcome;
    const notes: string[] = [];
    const fail = (reasons: string[], verification: Verification = "none") => ({ status: "failed" as const, verification, reasons, notes });

    if (engine.syntaxError) return fail([`Could not read the statement: ${engine.syntaxError}`]);

    const rejection = postgres.statements.find((statement) => statement.status === "rejected");
    const viaModel = outcome.source === "ai";
    const hardUnconverted = engine.unconverted.filter((item) => !engine.parameters.includes(item.construct));
    const verification: Verification = postgres.status === "accepted" ? "database" : syntax.ok ? "syntax" : "none";

    if (rejection && NAME_ERRORS.has(rejection.error?.code ?? "") && syntax.ok && (viaModel || hardUnconverted.length === 0)) {
        // the SQL reads as PostgreSQL; only the names are missing on this connection
        return {
            status: "review",
            verification: "syntax",
            reasons: [`PostgreSQL could not resolve a name: ${rejection.error?.message}. The statement parses as PostgreSQL, but this connection does not have the object, so the names were not checked.`],
            notes,
        };
    }
    const leftOver = (): string[] =>
        !viaModel && hardUnconverted.length > 0
            ? [`${hardUnconverted.length} construct${hardUnconverted.length === 1 ? "" : "s"} not converted: ${hardUnconverted.map((item) => `${clip(oneLine(item.construct), 60)} (${item.reason})`).slice(0, 3).join("; ")}${hardUnconverted.length > 3 ? `; and ${hardUnconverted.length - 3} more` : ""}.`]
            : [];
    // What the rules could not convert is the cause and PostgreSQL's complaint the symptom, so it comes first.
    if (rejection) return fail([...leftOver(), `PostgreSQL rejects the result: ${rejection.error?.message ?? "no message"}${rejection.excerpt ? ` (near “${clip(oneLine(rejection.excerpt), 80)}”)` : ""}.`], "none");
    if (postgres.status !== "accepted" && !syntax.ok) return fail([...leftOver(), `The result is not valid PostgreSQL syntax: ${syntax.error ?? "the parser gave no reason"}.`]);
    if (!viaModel && hardUnconverted.length > 0) return fail([...leftOver(), ...(outcome.aiNotice ? [outcome.aiNotice] : [])], verification);

    const reasons: string[] = [];
    if (viaModel) {
        reasons.push(`The rules could not finish this one; ${outcome.ai?.model ?? "the model"} converted it and ${outcome.ai?.checkedByDatabase ? "PostgreSQL accepts the result" : "a PostgreSQL grammar accepts the result (no database was asked)"}.`);
        if (outcome.ai && outcome.ai.risks.length > 0) reasons.push(`The model's own notes (nothing checks them): ${outcome.ai.risks.slice(0, 3).join("; ")}.`);
    }
    const changing = engine.traps.filter((trap) => trap.severity === "changes-results");
    if (changing.length > 0) reasons.push(`Can return different results than the original: ${changing.map((trap) => trap.title).join("; ")}.`);
    if (engine.parameters.length > 0) reasons.push(`Has bind variables (${engine.parameters.slice(0, 4).join(", ")}${engine.parameters.length > 4 ? ", …" : ""}); PostgreSQL drivers use $1, $2, … so they need replacing.`);
    // A script names tables the open project may not have; that is a fact to show, not a reason to stop and look.
    if (engine.unknownTables.length > 0) notes.push(`Uses tables that are not in the open project: ${engine.unknownTables.slice(0, 4).join(", ")}${engine.unknownTables.length > 4 ? ", …" : ""}.`);

    for (const trap of engine.traps.filter((candidate) => candidate.severity === "check")) notes.push(`Worth checking: ${trap.title}.`);
    if (postgres.status === "skipped") notes.push("PostgreSQL cannot check this kind of statement without running it, so only the grammar was asked.");
    if (postgres.status === "unreachable") notes.push(`PostgreSQL could not be asked (${postgres.message ?? "no answer"}); the result was checked by a grammar only.`);
    if (outcome.aiNotice) notes.push(outcome.aiNotice);

    if (reasons.length > 0) return { status: "review", verification, reasons, notes };
    return { status: engine.applied.length === 0 ? "unchanged" : "converted", verification, reasons: engine.applied.length === 0 ? ["No rule had anything to change."] : [`${engine.applied.length} rule${engine.applied.length === 1 ? "" : "s"} applied, nothing left over.`], notes };
}

// ---- running a file --------------------------------------------------------------------------------------------------------

export interface BatchDeps {
    syntax: ModernizeDeps["syntax"];
    validate?: ModernizeDeps["validate"];
    connectionName?: string;
    ask?: (request: QueryModernizationRequest) => ReturnType<NonNullable<ModernizeDeps["ask"]>>;
}

export interface BatchOptions {
    /** How many statements are converted at the same time (each may ask the database). */
    concurrency?: number;
    /** The model is asked about at most this many different statements in one run. */
    maxAiStatements?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
}

export interface RuleTotal {
    id: string;
    title: string;
    family: string;
    statements: number;
    count: number;
}

export interface BatchSummary {
    units: number;
    queries: number;
    byStatus: Record<BatchStatus, number>;
    byKind: Record<UnitKind, number>;
    /** Among the queries that were not failures: how they were checked. */
    verification: Record<Verification, number>;
    /** Statements whose only problem is that this connection does not have the table, column or schema. */
    namesUnresolved: number;
    repeated: number;
    convertedByModel: number;
    rules: RuleTotal[];
    unconverted: { construct: string; reason: string; statements: number }[];
    traps: { id: string; title: string; severity: string; statements: number }[];
    errors: { message: string; statements: number }[];
}

export interface BatchResult {
    dialect: LegacyDialect;
    items: BatchItem[];
    summary: BatchSummary;
    warnings: string[];
    lineCount: number;
    elapsedMs: number;
    /** The run was stopped; `skipped` queries were not converted. */
    aborted: boolean;
    skipped: number;
    aiLimit: number;
    aiStatementsAsked: number;
    /** What the statements were checked against, if anything. */
    connectionName?: string;
}

const emptyCounts = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

const top = <T extends { statements: number }>(map: Map<string, T>, limit: number): T[] => [...map.values()].sort((a, b) => b.statements - a.statements).slice(0, limit);

export function summarize(items: BatchItem[]): BatchSummary {
    const byStatus = emptyCounts(BATCH_STATUSES);
    const byKind = emptyCounts<UnitKind>(["query", "ddl", "procedural", "session", "other"]);
    const verification = emptyCounts<Verification>(["database", "syntax", "none"]);
    const rules = new Map<string, RuleTotal>();
    const unconverted = new Map<string, { construct: string; reason: string; statements: number }>();
    const traps = new Map<string, { id: string; title: string; severity: string; statements: number }>();
    const errors = new Map<string, { message: string; statements: number }>();
    let namesUnresolved = 0;
    let repeated = 0;
    let convertedByModel = 0;

    for (const item of items) {
        byStatus[item.status]++;
        byKind[item.unit.kind]++;
        if (item.repeatOf !== undefined) repeated++;
        const outcome = item.outcome;
        if (!outcome) continue;
        if (item.status !== "failed") verification[item.verification]++;
        if (outcome.source === "ai") convertedByModel++;
        if (item.status === "review" && item.reasons[0]?.startsWith("PostgreSQL could not resolve a name")) namesUnresolved++;

        for (const rule of outcome.engine.applied) {
            const entry = rules.get(rule.id) ?? { id: rule.id, title: rule.title, family: rule.family, statements: 0, count: 0 };
            entry.statements++;
            entry.count += rule.count;
            rules.set(rule.id, entry);
        }
        for (const trap of outcome.engine.traps) {
            const entry = traps.get(trap.id) ?? { id: trap.id, title: trap.title, severity: trap.severity, statements: 0 };
            entry.statements++;
            traps.set(trap.id, entry);
        }
        if (item.status === "failed" || (item.status === "review" && outcome.source === "rules")) {
            for (const left of outcome.engine.unconverted.filter((candidate) => !outcome.engine.parameters.includes(candidate.construct))) {
                const key = constructFamily(left.construct);
                const entry = unconverted.get(key) ?? { construct: key, reason: left.reason, statements: 0 };
                entry.statements++;
                unconverted.set(key, entry);
            }
        }
        const rejection = outcome.postgres.statements.find((statement) => statement.status === "rejected");
        if (rejection?.error) {
            const key = rejection.error.message.replace(/"[^"]*"/g, '"…"');
            const entry = errors.get(key) ?? { message: key, statements: 0 };
            entry.statements++;
            errors.set(key, entry);
        }
    }

    return {
        units: items.length,
        queries: byKind.query,
        byStatus,
        byKind,
        verification,
        namesUnresolved,
        repeated,
        convertedByModel,
        rules: [...rules.values()].sort((a, b) => b.statements - a.statements || b.count - a.count),
        unconverted: top(unconverted, 15),
        traps: top(traps, 15),
        errors: top(errors, 10),
    };
}

/** What a file contains, without converting anything. */
export function inspectScript(script: string, dialect: LegacyDialect) {
    const split = splitScript(script, dialect);
    const byKind = emptyCounts<UnitKind>(["query", "ddl", "procedural", "session", "other"]);
    for (const unit of split.units) byKind[unit.kind]++;
    return { ...split, byKind };
}

export async function runBatch(input: { script: string; dialect: LegacyDialect; schema?: SchemaContext }, deps: BatchDeps, options: BatchOptions = {}): Promise<BatchResult> {
    const startedAt = performance.now();
    const { units, warnings, lineCount } = splitScript(input.script, input.dialect);
    const concurrency = Math.max(1, options.concurrency ?? 4);
    const aiLimit = options.maxAiStatements ?? 25;
    const items: (BatchItem | undefined)[] = units.map((unit) => (unit.kind === "query" ? undefined : outOfScope(unit)));
    const queries = units.filter((unit) => unit.kind === "query");
    let done = units.length - queries.length;
    options.onProgress?.(done, units.length);

    // The model is asked about at most `aiLimit` different statements; after that it is not asked and the item says so.
    const asked = new Set<string>();
    const ask: ModernizeDeps["ask"] | undefined = deps.ask
        ? async (request) => {
              if (!asked.has(request.legacySql)) {
                  if (asked.size >= aiLimit) throw new Error(`the limit of ${aiLimit} statements sent to the model in one run was reached`);
                  asked.add(request.legacySql);
              }
              return deps.ask!(request);
          }
        : undefined;

    const seen = new Map<string, { index: number; outcome: Promise<ModernizeOutcome> }>();
    let next = 0;
    // Converting without a database is pure computation: let the page repaint, and the Stop button work, every so often.
    let lastYield = performance.now();
    const breathe = async () => {
        if (performance.now() - lastYield < 40) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
    };

    const work = async () => {
        while (!options.signal?.aborted) {
            const at = next++;
            if (at >= queries.length) return;
            const unit = queries[at];
            const key = unit.text;
            const earlier = seen.get(key);
            let repeatOf: number | undefined;
            let promise: Promise<ModernizeOutcome>;
            if (earlier) {
                repeatOf = earlier.index;
                promise = earlier.outcome;
            } else {
                promise = modernize({ sql: unit.text, dialect: input.dialect, schema: input.schema }, { syntax: deps.syntax, validate: deps.validate, connectionName: deps.connectionName, ask });
                seen.set(key, { index: unit.index, outcome: promise });
            }
            try {
                const outcome = await promise;
                items[unit.index] = { unit, outcome, ...(repeatOf !== undefined ? { repeatOf } : {}), ...classifyOutcome(outcome) };
            } catch (error) {
                if (options.signal?.aborted) return;
                items[unit.index] = { unit, status: "failed", verification: "none", reasons: [`The conversion stopped with an error: ${error instanceof Error ? error.message : String(error)}`], notes: [], ...(repeatOf !== undefined ? { repeatOf } : {}) };
            }
            done++;
            options.onProgress?.(done, units.length);
            await breathe();
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queries.length)) }, work));

    const finished = items.filter((item): item is BatchItem => item !== undefined);
    return {
        dialect: input.dialect,
        items: finished,
        summary: summarize(finished),
        warnings,
        lineCount,
        elapsedMs: Math.round(performance.now() - startedAt),
        aborted: Boolean(options.signal?.aborted),
        skipped: units.length - finished.length,
        aiLimit,
        aiStatementsAsked: asked.size,
        connectionName: deps.connectionName,
    };
}
