import { aiSchemaPlanModelSchema, aiSchemaPlanSchema, type AiSchemaPlan } from "../ai/schema-plan.js";
import { normalizePlanOutput } from "../ai/plan-normalize.js";
import type { ModelCall, ModelResult, ModelUsage } from "../ai/provider.js";
import { compilePlan, discoverProbes } from "./compile.js";
import { qualifiedName, splitQualified, type Facts, type ProbeRequest, type Probes } from "./facts.js";
import { lintSteps, type LintResult } from "./lint.js";
import { namesToRedact, plannerInput, plannerInstructions } from "./prompt.js";
import { Redactor, findLeaks, stringValues } from "./redact.js";
import type { CompileSettings, Finding, Runbook } from "./runbook.js";

/**
 * One schema change request, end to end: the facts of the chosen tables are read, a model proposes operations, the operations are
 * checked against the real catalog and compiled into a runbook, and if the checks found errors the model gets to see them once.
 * The model never sees rows or credentials, and with redaction on it never sees a name.
 */

export const MAX_ATTEMPTS = 2;
export const MAX_SCOPE_TABLES = 100;
/** How many names of tables outside the scope are shown to the model. */
export const MAX_OTHER_TABLE_NAMES = 400;

export interface PlannerDeps {
    loadFacts(tables: string[]): Promise<Facts>;
    probe(request: ProbeRequest): Promise<Probes>;
    /** Table and schema names of the whole database, and how many tables there are (for the count of tables not shown). */
    wholeDatabase(): Promise<{ tables: { schema: string; name: string }[] }>;
    callModel(call: ModelCall): Promise<ModelResult>;
}

export interface PlannerRequest {
    prompt: string;
    /** Schema-qualified names of the tables the model is shown in full. May be empty: a plan that creates new tables needs none, and the ones a plan turns out to need are read after it. */
    tables: string[];
    redact: boolean;
    connection: { id: string; name: string };
    settings?: Partial<CompileSettings>;
    signal?: AbortSignal;
}

export interface PlannerResult {
    plan: AiSchemaPlan;
    /** null while the model is asking questions instead of planning. */
    runbook: Runbook | null;
    lint: LintResult | null;
    findings: Finding[];
    model: string;
    attempts: number;
    usage: ModelUsage;
    auditIds: number[];
    redacted: boolean;
    scope: string[];
    /** Tables that were not in the scope but that the plan refers to: they were read to check the plan, and shown to the model if it was asked again. */
    expandedTables: string[];
    omittedTables: number;
    requestChars: number;
    modelLatencyMs: number;
}

export class PlannerError extends Error {
    constructor(message: string, public status = 502) {
        super(message);
        this.name = "PlannerError";
    }
}

const mostCommonSchema = (schemas: string[]): string => {
    const counts = new Map<string, number>();
    for (const schema of schemas) counts.set(schema, (counts.get(schema) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "public";
};

/** Table names the operations refer to, as the model wrote them. A table the plan creates itself is not a reference. */
export function referencedTableNames(plan: AiSchemaPlan): string[] {
    const created = plan.operations.flatMap((operation) => (operation.type === "create_table" ? [splitQualified(operation.table.name.trim().toLowerCase())] : []));
    // "notes" and "public.notes" are the same table when the plan creates one of them and refers to the other.
    const isCreated = (name: string): boolean => {
        const reference = splitQualified(name.trim().toLowerCase());
        return created.some((table) => table.name === reference.name && (table.schema === undefined || reference.schema === undefined || table.schema === reference.schema));
    };
    const names: string[] = [];
    for (const operation of plan.operations) {
        if (operation.type === "create_table") continue;
        if (operation.type === "add_relationship") names.push(operation.relationship.sourceTable, operation.relationship.targetTable);
        else if (operation.type === "drop_relationship") names.push(operation.sourceTable, operation.targetTable);
        else names.push(operation.tableName);
    }
    return names.filter((name) => !isCreated(name));
}

/** The existing tables, among all of the database's, that the plan refers to but that were not in the scope. Names are matched the way the compiler matches them. */
export function unseenExistingTables(plan: AiSchemaPlan, inScope: Set<string>, whole: { schema: string; name: string }[], defaultSchema: string): string[] {
    const byKey = new Map(whole.map((table) => [qualifiedName(table.schema, table.name).toLowerCase(), qualifiedName(table.schema, table.name)]));
    const found = new Set<string>();
    for (const raw of referencedTableNames(plan)) {
        const { schema, name } = splitQualified(raw.trim());
        let match = byKey.get(qualifiedName(schema ?? defaultSchema, name).toLowerCase());
        if (!match && schema === undefined) {
            const sameName = whole.filter((table) => table.name.toLowerCase() === name.toLowerCase());
            if (sameName.length === 1) match = qualifiedName(sameName[0].schema, sameName[0].name);
        }
        if (match && !inScope.has(match)) found.add(match);
    }
    return [...found].sort();
}

function parseAnswer(output: unknown, redactor: Redactor | undefined): { plan: AiSchemaPlan } | { problems: string[] } {
    const unmasked = redactor ? redactor.unmaskDeep(output) : output;
    const parsed = aiSchemaPlanSchema.safeParse(normalizePlanOutput(unmasked));
    if (parsed.success) return { plan: parsed.data };
    return { problems: parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "answer"}: ${issue.message}`) };
}

export async function planSchemaChange(deps: PlannerDeps, request: PlannerRequest): Promise<PlannerResult> {
    const wanted = [...new Set(request.tables)];
    if (wanted.length > MAX_SCOPE_TABLES) throw new PlannerError(`The scope has ${wanted.length} tables; at most ${MAX_SCOPE_TABLES} can be planned at once.`, 400);

    let facts = await deps.loadFacts(wanted);
    const missing = wanted.filter((name) => !facts.tables.has(name));
    if (missing.length > 0) throw new PlannerError(`Not found in the database: ${missing.join(", ")}.`, 404);

    const whole = await deps.wholeDatabase();
    const expanded: string[] = [];
    const settings: Partial<CompileSettings> = { defaultSchema: mostCommonSchema((facts.tables.size > 0 ? [...facts.tables.values()] : whole.tables).map((table) => table.schema)), ...request.settings };

    // The tables the model is told exist but is not shown in full: their names, so a new table can point at one.
    const otherTables = () => {
        const shown = new Set([...facts.tables.values()].map((table) => qualifiedName(table.schema, table.name)));
        return whole.tables.filter((table) => !shown.has(qualifiedName(table.schema, table.name))).sort((a, b) => qualifiedName(a.schema, a.name).localeCompare(qualifiedName(b.schema, b.name))).slice(0, MAX_OTHER_TABLE_NAMES);
    };
    const omitted = () => Math.max(0, whole.tables.length - facts.tables.size);

    // Placeholders for every name in scope; the request text is also masked for the names of the tables that are not in scope.
    let redactor = request.redact ? new Redactor(namesToRedact(facts, whole.tables)) : undefined;
    const instructions = plannerInstructions();
    const auditIds: number[] = [];
    const usage: ModelUsage = { inputTokens: null, outputTokens: null };
    let modelLatencyMs = 0;
    let requestChars = 0;
    let best: { plan: AiSchemaPlan; runbook: Runbook | null; lint: LintResult | null; errors: number; model: string } | undefined;
    let problems: string[] | undefined;
    let previous: unknown;
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        const others = otherTables();
        const input = plannerInput({ prompt: request.prompt, facts, omittedTables: omitted(), otherTables: others, redactor, problems, previousPlan: previous });

        if (redactor) {
            const scopeNames = [...namesToRedact(facts).map((entry) => entry.name), ...others.flatMap((other) => [other.schema, other.name])];
            const leaks = findLeaks(stringValues(input).join("\n"), scopeNames);
            if (leaks.length > 0) throw new PlannerError(`Name redaction left ${leaks.length} name(s) in the request (${leaks.slice(0, 3).join(", ")}), so nothing was sent.`, 500);
        }

        const result = await deps.callModel({
            instructions,
            input,
            maxOutputTokens: 8_000,
            format: { name: "schema_change_plan", schema: aiSchemaPlanModelSchema },
            signal: request.signal,
            purpose: "schema-plan",
            context: { connectionId: request.connection.id, connectionName: request.connection.name, redacted: Boolean(redactor), detail: { tables: facts.tables.size, omittedTables: omitted(), attempt: attempts } },
        });
        auditIds.push(result.auditId);
        modelLatencyMs += result.latencyMs;
        requestChars += instructions.length + JSON.stringify(input).length;
        if (result.usage.inputTokens !== null) usage.inputTokens = (usage.inputTokens ?? 0) + result.usage.inputTokens;
        if (result.usage.outputTokens !== null) usage.outputTokens = (usage.outputTokens ?? 0) + result.usage.outputTokens;

        const answer = parseAnswer(result.output, redactor);
        if ("problems" in answer) {
            problems = [`The answer did not match the required format: ${answer.problems.join("; ")}`];
            previous = result.output;
            if (attempts >= MAX_ATTEMPTS && !best) throw new PlannerError(`The model's answer was not a valid plan: ${answer.problems.slice(0, 3).join("; ")}`);
            continue;
        }

        const plan = answer.plan;
        if (plan.clarifyingQuestions.length > 0) {
            return { plan, runbook: null, lint: null, findings: [], model: result.model, attempts, usage, auditIds, redacted: Boolean(redactor), scope: [...wanted, ...expanded], expandedTables: expanded, omittedTables: omitted(), requestChars, modelLatencyMs };
        }

        // The plan may refer to existing tables the model was only told the names of. They are read now, so the checks run against the real columns
        // and keys, and if the model has to answer again it sees them.
        const unseen = unseenExistingTables(plan, new Set(facts.tables.keys()), whole.tables, settings.defaultSchema ?? "public");
        if (unseen.length > 0 && facts.tables.size + unseen.length <= MAX_SCOPE_TABLES) {
            const more = await deps.loadFacts([...facts.tables.keys(), ...unseen]);
            const loaded = unseen.filter((name) => more.tables.has(name));
            if (loaded.length > 0) {
                facts = more;
                expanded.push(...loaded);
                if (request.redact) redactor = new Redactor(namesToRedact(facts, whole.tables));
            }
        }

        const probes = await deps.probe(discoverProbes({ plan, facts, settings }));
        const runbook = compilePlan({ plan, facts, probes, settings });
        const errors = runbook.findings.filter((finding) => finding.severity === "error");
        const lint = lintSteps(runbook.steps);
        if (!best || errors.length <= best.errors) best = { plan, runbook, lint, errors: errors.length, model: result.model };

        if (errors.length === 0 || attempts >= MAX_ATTEMPTS) break;
        problems = errors.map((finding) => `operation ${(finding.operation ?? 0) + 1}: ${finding.message}`);
        previous = plan;
    }

    if (!best) throw new PlannerError("The model did not return a plan.");
    return {
        plan: best.plan,
        runbook: best.runbook,
        lint: best.lint,
        findings: best.runbook?.findings ?? [],
        model: best.model,
        attempts,
        usage,
        auditIds,
        redacted: Boolean(redactor),
        scope: [...wanted, ...expanded],
        expandedTables: expanded,
        omittedTables: omitted(),
        requestChars,
        modelLatencyMs,
    };
}
