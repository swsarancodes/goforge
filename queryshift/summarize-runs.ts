/**
 * Reads the *.loop.json traces under a folder (any depth) and prints one table per case: runs, how many were verified or went to a person,
 * the reasons seen, corrections per run, tokens and latency of the model calls. Everything is counted from the traces; nothing is typed in.
 *
 *   node server/node_modules/tsx/dist/cli.mjs queryshift/summarize-runs.ts <folder> [--json] [--markdown]
 *
 * A "correction" is an attempt made by a proposer (attempt 1 and later); attempt 0 is the rule engine and is not one. A run with no
 * correction never called the model. Tokens and latency are summed or averaged over the model calls the traces recorded; a call that
 * failed (reason proposer_failed) leaves no attempt and so no tokens, and is counted in the reasons.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

interface Attempt {
    n: number;
    source: string;
    proposal?: { model?: string; usage?: { inputTokens: number; outputTokens: number }; latencyMs?: number; replayedFrom?: string };
}
interface Trace {
    caseId: string;
    outcome: "verified" | "needs_human_review";
    reasons: { code: string }[];
    attempts: Attempt[];
}

function traces(dir: string): { file: string; trace: Trace }[] {
    return readdirSync(dir)
        .sort()
        .flatMap((name) => {
            const path = resolve(dir, name);
            if (statSync(path).isDirectory()) return traces(path);
            return name.endsWith(".loop.json") ? [{ file: path, trace: JSON.parse(readFileSync(path, "utf8")) as Trace }] : [];
        });
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: number[]) => (values.length ? sum(values) / values.length : 0);
const fixed = (value: number, digits = 1) => value.toFixed(digits);

export interface CaseSummary {
    caseId: string;
    runs: number;
    verified: number;
    needsHumanReview: number;
    reasons: Record<string, number>;
    runsThatCalledTheModel: number;
    corrections: { average: number; max: number };
    modelCalls: number;
    tokens: { input: number; output: number; inputPerRun: number; outputPerRun: number };
    latencyMs: { averagePerCall: number; maxPerCall: number; averageTotalPerRun: number };
    models: string[];
    replayed: boolean;
}

export function summarize(all: Trace[]): CaseSummary[] {
    const byCase = new Map<string, Trace[]>();
    for (const trace of all) byCase.set(trace.caseId, [...(byCase.get(trace.caseId) ?? []), trace]);
    return [...byCase.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([caseId, group]) => {
            const corrections = group.map((trace) => trace.attempts.filter((attempt) => attempt.n >= 1).length);
            const calls = group.map((trace) => trace.attempts.filter((attempt) => attempt.n >= 1 && attempt.proposal?.usage));
            const everyCall = calls.flat();
            const reasons: Record<string, number> = {};
            for (const trace of group) for (const reason of trace.reasons) reasons[reason.code] = (reasons[reason.code] ?? 0) + 1;
            const input = everyCall.map((attempt) => attempt.proposal!.usage!.inputTokens);
            const output = everyCall.map((attempt) => attempt.proposal!.usage!.outputTokens);
            const latency = everyCall.map((attempt) => attempt.proposal!.latencyMs ?? 0);
            return {
                caseId,
                runs: group.length,
                verified: group.filter((trace) => trace.outcome === "verified").length,
                needsHumanReview: group.filter((trace) => trace.outcome === "needs_human_review").length,
                reasons,
                runsThatCalledTheModel: calls.filter((list) => list.length > 0).length,
                corrections: { average: mean(corrections), max: Math.max(0, ...corrections) },
                modelCalls: everyCall.length,
                tokens: { input: sum(input), output: sum(output), inputPerRun: sum(input) / group.length, outputPerRun: sum(output) / group.length },
                latencyMs: { averagePerCall: mean(latency), maxPerCall: Math.max(0, ...latency), averageTotalPerRun: sum(latency) / group.length },
                models: [...new Set(everyCall.map((attempt) => attempt.proposal!.model ?? "?"))].sort(),
                replayed: everyCall.some((attempt) => attempt.proposal?.replayedFrom),
            };
        });
}

const reasonsText = (reasons: Record<string, number>) => (Object.keys(reasons).length ? Object.entries(reasons).map(([code, count]) => `${code} x${count}`).join(", ") : "none");

export function toMarkdown(summaries: CaseSummary[]): string {
    return summaries
        .map((s) => {
            const rows: [string, string][] = [
                ["Runs", String(s.runs)],
                ["Verified", `${s.verified} of ${s.runs}`],
                ["needs_human_review", `${s.needsHumanReview} of ${s.runs}`],
                ["Reasons seen", reasonsText(s.reasons)],
                ["Runs that called the model", `${s.runsThatCalledTheModel} of ${s.runs}`],
                ["Corrections per run (average, maximum)", `${fixed(s.corrections.average, 2)}, ${s.corrections.max}`],
                ["Model calls", String(s.modelCalls)],
                ["Tokens in / out (total)", `${s.tokens.input.toLocaleString("en-US")} / ${s.tokens.output.toLocaleString("en-US")}`],
                ["Tokens in / out (per run, average)", `${fixed(s.tokens.inputPerRun, 0)} / ${fixed(s.tokens.outputPerRun, 0)}`],
                ["Latency per call (average, maximum)", `${fixed(s.latencyMs.averagePerCall / 1000)} s, ${fixed(s.latencyMs.maxPerCall / 1000)} s`],
                ["Model latency per run (average, all calls added)", `${fixed(s.latencyMs.averageTotalPerRun / 1000)} s`],
                ["Model", s.models.join(", ") || "none called"],
            ];
            return `**${s.caseId}**\n\n| | |\n|---|---|\n${rows.map(([name, value]) => `| ${name} | ${value} |`).join("\n")}\n`;
        })
        .join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const dir = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
    if (!dir) {
        console.error("summarize-runs: give the folder that holds the *.loop.json traces.");
        process.exit(2);
    }
    const found = traces(resolve(dir));
    if (found.length === 0) {
        console.error(`summarize-runs: no *.loop.json under ${dir}`);
        process.exit(2);
    }
    const summaries = summarize(found.map((entry) => entry.trace));
    if (process.argv.includes("--json")) console.log(JSON.stringify(summaries, null, 2));
    else {
        console.log(`${found.length} trace(s) read from ${dir}\n`);
        console.log(toMarkdown(summaries));
    }
}
