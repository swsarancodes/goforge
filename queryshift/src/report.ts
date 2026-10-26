import type { LoadedCase } from "./case";
import type { Attempt, LoopResult } from "./loop";
import { oracleLiteral } from "./binds";

/**
 * The validation report for one case, for the person who has to decide whether to trust the translation: what the legacy query is for,
 * what looked risky in it, what was tried, what was measured, and what is still open. It follows the flow of the challenge (input, risk
 * analysis, transformation and proof, decision) and is built from the trace, not from anything a model said about itself. The model's
 * own words appear, labelled as its own and unverified. It contains no dates and no local paths, so the same trace gives the same report.
 */

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();
const cell = (text: string) => oneLine(text).replace(/\|/g, "\\|");
const sql = (text: string) => `\`\`\`sql\n${text.trim()}\n\`\`\``;
const list = (items: string[]) => items.map((item) => `- ${oneLine(item)}`).join("\n");
const rows = (count: number) => `${count} row${count === 1 ? "" : "s"}`;
const word = (verdict: string) => verdict.toUpperCase();

function producedBy(attempt: Attempt): string {
    if (attempt.source === "rule-engine") return "GoForge rule engine, then the schema mapping";
    const model = attempt.proposal?.model;
    if (attempt.proposal?.replayedFrom) return `${model ? `model \`${model}\`` : "a model"}, answer replayed from \`${attempt.proposal.replayedFrom}\` (no model was called in this run)`;
    return model ? `model \`${model}\`` : attempt.source;
}

function evidenceLines(attempt: Attempt): string[] {
    const { evidence } = attempt;
    if (!evidence) return [];
    const lines: string[] = [];
    if (evidence.kind === "mismatch") {
        if (evidence.columnProblem) lines.push(evidence.columnProblem);
        else if (evidence.orderProblem) lines.push(evidence.orderProblem);
        else lines.push(`${rows(evidence.missingCount)} missing, ${rows(evidence.unexpectedCount)} unexpected.`);
        if (evidence.differingColumns.length > 0) lines.push(`The rows differ in: ${evidence.differingColumns.map((entry) => `${entry.column} (${rows(entry.rows)})`).join(", ")}.`);
        for (const broken of evidence.brokenInvariants) lines.push(`Invariant broken: ${broken.name} (${broken.detail}).`);
    }
    return lines;
}

function meaning(loaded: LoadedCase, result: LoopResult): string {
    const { definition, expected, heldOut } = loaded;
    if (result.outcome === "needs_human_review") return "No query was accepted. The reasons are below, with what was measured, so the person who takes over starts from evidence and not from a blank page.";
    const data = result.heldOut === "passed" && heldOut ? `the primary data (${rows(expected.rows.length)}) and the held-out data (${rows(heldOut.expected.rows.length)})` : `the primary data (${rows(expected.rows.length)}); this case has no held-out data`;
    const invariants = definition.invariants.length === 1 ? "the invariant" : `all ${definition.invariants.length} invariants`;
    return `The final query returned the reference result on ${data}${definition.orderSensitive ? ", in the same order" : ""}, and ${invariants} held. That is everything "verified" claims. It is a measurement on these datasets, not a proof that the two queries agree on every possible input.`;
}

export function renderCaseReport(loaded: LoadedCase, result: LoopResult): string {
    const { definition } = loaded;
    const verified = result.outcome === "verified";
    const first = result.attempts[0];
    const last = result.attempts[result.attempts.length - 1];
    const out: string[] = [];

    out.push(`# ${definition.id}: ${definition.title}`);
    out.push(`**Outcome: ${verified ? "VERIFIED" : "NEEDS HUMAN REVIEW"}**\n\n${meaning(loaded, result)}`);

    out.push("## Input");
    out.push(`**What the query is for.** ${definition.businessPurpose}`);
    out.push(`Source dialect ${definition.legacyDialect}, target PostgreSQL. Difficulty ${definition.difficulty}. Risks this case is built to exercise: ${definition.risks.join(", ")}.`);
    out.push(`**Legacy query**\n\n${sql(loaded.legacyTemplate)}`);
    const binds = Object.entries(definition.bindValues);
    if (binds.length > 0) out.push(`**Bind variables.** The reference result was produced with these values, which the case declares and which are written into the query before anything reads it:\n\n${list(binds.map(([name, value]) => `\`:${name}\` = \`${oracleLiteral(value)}\``))}`);
    out.push(
        `**What it is measured against.** A reference result of ${rows(loaded.expected.rows.length)} (columns ${loaded.expected.columns.map((column) => `\`${column}\``).join(", ")})${loaded.heldOut ? `, and a second reference result of ${rows(loaded.heldOut.expected.rows.length)} on a held-out dataset that no model is ever shown anything from` : ""}. ${definition.orderSensitive ? "Row order is compared." : "Row order is not compared."} ${definition.invariants.length} invariant${definition.invariants.length === 1 ? "" : "s"}: ${definition.invariants.map((invariant) => invariant.name).join("; ")}.`,
    );

    out.push("## Risk analysis");
    out.push(`**What the rule engine reported about the legacy query.**\n\n${result.engineWarnings.length > 0 ? list(result.engineWarnings) : "Nothing it could not convert."}`);
    out.push(`**What the static checks saw in the rule engine's query.**\n\n${first.findings.length > 0 ? list(first.findings.map((finding) => `${finding.title} (\`${finding.id}\`, ${finding.severity}). ${finding.detail}`)) : "Nothing."}`);

    out.push("## Transformation and proof");
    out.push(["| # | Produced by | Result | Measured |", "| --- | --- | --- | --- |", ...result.attempts.map((attempt) => `| ${attempt.n} | ${cell(producedBy(attempt))} | ${word(attempt.verdict)}${attempt.heldOut ? ` / held-out ${word(attempt.heldOut.verdict)}` : ""} | ${cell(attempt.summary)} |`)].join("\n"));
    for (const attempt of result.attempts) {
        const part: string[] = [`### Attempt ${attempt.n}: ${producedBy(attempt)}`];
        if (attempt.proposal) {
            const { explanation, changes, risks, usage, latencyMs } = attempt.proposal;
            if (explanation) part.push(`**What the model says it changed and why** (its own words; nothing checks them): ${oneLine(explanation)}`);
            if (changes?.length) part.push(list(changes));
            if (usage || latencyMs !== undefined) part.push(`Request: ${[usage?.inputTokens != null ? `${usage.inputTokens} tokens in` : "", usage?.outputTokens != null ? `${usage.outputTokens} tokens out` : "", latencyMs !== undefined ? `${(latencyMs / 1000).toFixed(1)} s` : ""].filter(Boolean).join(", ")}${attempt.proposal.replayedFrom ? " (of the recorded request)" : ""}.`);
        }
        part.push(sql(attempt.sql));
        part.push(`**Primary data: ${word(attempt.verdict)}.** ${oneLine(attempt.summary)}`);
        const evidence = evidenceLines(attempt);
        if (evidence.length > 0) part.push(list(evidence));
        if (attempt.heldOut) part.push(`**Held-out data: ${word(attempt.heldOut.verdict)}.** ${oneLine(attempt.heldOut.summary)}`);
        part.push(`**Static checks:** ${attempt.findings.length > 0 ? attempt.findings.map((finding) => `${finding.title} (\`${finding.id}\`, ${finding.severity})`).join("; ") : "nothing."}`);
        if (attempt.proposal?.prompt) {
            const { instructions, input, sha256 } = attempt.proposal.prompt;
            part.push(`<details>\n<summary>The exact prompt sent for correction ${attempt.n}${sha256 ? ` (SHA-256 ${sha256.slice(0, 12)}…)` : ""}</summary>\n\n**Instructions**\n\n\`\`\`text\n${instructions}\n\`\`\`\n\n**Input**\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n\n</details>`);
        }
        out.push(part.join("\n\n"));
    }

    out.push("## Decision");
    out.push(`**${verified ? "VERIFIED" : "NEEDS HUMAN REVIEW"}**${verified ? "" : `: ${result.reasons.map((reason) => reason.code).join(", ")}`}`);
    if (result.reasons.length > 0) out.push(list(result.reasons.map((reason) => `\`${reason.code}\`: ${reason.message}`)));
    out.push(`**${verified ? "The accepted query" : "The last query tried"}**\n\n${sql(result.finalSql)}`);
    const open: string[] = [];
    for (const finding of result.findings) open.push(`Static ${finding.severity}: ${finding.title}. ${finding.detail}`);
    for (const risk of result.proposerRisks) open.push(`The model's own uncertainty (unverified): ${risk}`);
    if (last.proposal?.replayedFrom) open.push("The model's answer here was replayed from a recording. Everything measured above was run again, live; the recording shows what a model gave, not that it gives it today.");
    open.push("Static checks point at constructs; they are not complete, and a query with no findings has not been shown to be right.");
    out.push(`**What a reviewer should still read**\n\n${list(open)}`);

    return `${out.join("\n\n")}\n`;
}
