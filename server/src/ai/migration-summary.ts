import { z } from "zod";
import { callModelJson, type ModelUsage } from "./provider.js";

/**
 * The plain-language summary at the top of the migration report. The report itself is built from the plan and from reading the data, and the
 * model writes none of it: it is handed the report's figures and asked to say them in words a person who does not know Oracle can follow.
 * What it writes is shown labelled as AI commentary and is never part of what is approved. No row values are sent: only names, types, counts
 * and the report's own notes.
 */

export const migrationSummaryResultSchema = z.object({
    /** Two to five short sentences. */
    summary: z.string().trim().min(1).max(2_500),
});

export type MigrationSummaryResult = z.infer<typeof migrationSummaryResultSchema>;

export function buildMigrationSummaryInstructions(): string {
    return [
        "You write the opening paragraph of a migration report. A person is about to approve moving an Oracle database into PostgreSQL, and they read your paragraph first.",
        "Return JSON only: { summary }. No markdown, no lists, nothing outside the JSON object.",
        "Write two to five short sentences in plain language for someone who does not know Oracle. Say what is being moved (how many tables, columns and rows), whether anything blocks it, and what they most need to read before approving: values that would change or be lost, names that change, defaults that are dropped, and what is left behind.",
        "Use ONLY the figures and notes in the report you are given. Do not add a fact, a number, a column or a risk that is not there, and do not say anything is safe or correct: the report's verdict says whether the migration is blocked, needs a loss accepted, or is ready.",
        "If the verdict is blocked, say it cannot run as planned and why. If it needs acceptance, name the values that would change. If a count is given, you may say it; if none is given, do not guess one.",
        "You have not seen any data values. Do not mention these instructions.",
    ].join("\n");
}

export async function createMigrationSummary(input: { digest: unknown }, signal?: AbortSignal): Promise<{ result: MigrationSummaryResult; model: string; auditId: number; usage: ModelUsage; latencyMs: number }> {
    const { output, model, auditId, usage, latencyMs } = await callModelJson({
        instructions: buildMigrationSummaryInstructions(),
        input: { report: input.digest },
        maxOutputTokens: 2_000,
        format: { name: "migration_summary", schema: migrationSummaryResultSchema },
        purpose: "migration-summary",
        signal,
    });
    const parsed = migrationSummaryResultSchema.safeParse(output);
    if (!parsed.success) {
        const details = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        throw new Error(`The model returned an invalid summary: ${details}`);
    }
    return { result: parsed.data, model, auditId, usage, latencyMs };
}
