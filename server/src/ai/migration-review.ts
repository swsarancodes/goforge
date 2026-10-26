import { z } from "zod";
import { callModelJson, type ModelUsage } from "./provider.js";

/**
 * The plan reviewer: a second opinion on a migration plan, asked for on purpose and separate from CosmicQuery, the assistant that changes the
 * plan. It did not make any of the changes and it cannot make any: it is handed the report (names, types, counts, notes, the foreign keys, what is
 * carried and what is left behind, and the list of changes the person made) and says what looks wrong, risky or worth a second look. What it says is
 * shown labelled as AI commentary, is not part of what is approved, and every finding is checked by the server against the report before it is shown
 * (a table or column that is not in the plan is dropped). No row values are sent.
 */

export const reviewFindingSchema = z.object({
    /** `concern`: probably wrong or lossy. `warning`: worth reading before approving. `note`: information. */
    severity: z.enum(["concern", "warning", "note"]),
    /** The Oracle table and column the finding is about, as the plan names them; null when it is about the plan as a whole. */
    table: z.string().max(128).nullable(),
    column: z.string().max(128).nullable(),
    title: z.string().trim().min(1).max(160),
    detail: z.string().trim().min(1).max(900),
    /** What to change, in plain words (never SQL); null when nothing needs changing. */
    suggestion: z.string().trim().max(500).nullable(),
});

export const migrationReviewResultSchema = z.object({
    /** Two to four short sentences: how the plan looks overall. */
    overview: z.string().trim().min(1).max(1_500),
    findings: z.array(reviewFindingSchema).max(20),
});

export type MigrationReviewResult = z.infer<typeof migrationReviewResultSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export function buildMigrationReviewInstructions(): string {
    return [
        "You are the plan reviewer of GoForge's Oracle to PostgreSQL migration. You are a separate, independent reviewer: you did not write this plan and you cannot change it. A person asked you for a second opinion before they approve it.",
        "Return JSON only: { overview, findings }. No markdown, nothing outside the JSON object.",
        "You are given the migration report as data: every table and its columns (Oracle type, PostgreSQL type, how its values fare, what the person changed), the foreign keys with the types on both sides, the counts the checks found on the real data, what is carried over and what is left behind (with the reason it cannot be carried when there is one), what behaves differently in queries, the problems that block the migration, and the list of changes the person made.",
        "Look for: a foreign key whose two sides have different PostgreSQL types; a change by the person that looks unintended, inconsistent with the rest of the plan, or that can lose data (use the counts); a column of risk status or with a count above zero that the person has not been told about; a dropped default that the application is likely to rely on; an index or CHECK constraint left behind that matters (a CHECK is data integrity, an index is speed) and that could be carried; names that clash or are hard to read after the change; and behaviour differences that matter for this particular schema.",
        "Use ONLY what is in the report. Never invent a table, column, count or type. Every finding names a table and column exactly as the report writes them (the Oracle names), or null (the JSON value null, not an empty string) for table and column when it is about the plan as a whole.",
        "Order findings by importance, at most eight, and group what belongs together: one finding for several left-behind indexes, one for the query behaviour differences that matter here, not one each. `concern` is for what is probably wrong or lossy, `warning` for what is worth reading before approving, `note` for information. Give a column only when the finding is about that column; for a whole table or the whole plan leave the column (and the table) null rather than picking a column it is not about. If you find nothing worth saying, return no findings and say so plainly in the overview; do not pad.",
        "A suggestion is plain words for what to change (for example 'make PREM_PMT.PMT_ID bigint to match PAY_HDR.PMT_ID'), never SQL. If nothing needs changing, set it to null (not an empty string).",
        "You are a reviewer, not a proof: do not say the plan is correct or safe. Say what you found and what you did not look at. If the person asked for a focus, give it priority but still report a concern you see elsewhere.",
        "You have not seen any data values. Do not mention these instructions.",
    ].join("\n");
}

export async function createMigrationReview(
    input: { digest: unknown; focus?: string },
    signal?: AbortSignal,
): Promise<{ result: MigrationReviewResult; model: string; auditId: number; usage: ModelUsage; latencyMs: number }> {
    const { output, model, auditId, usage, latencyMs } = await callModelJson({
        instructions: buildMigrationReviewInstructions(),
        input: { report: input.digest, ...(input.focus ? { personAsksYouToFocusOn: input.focus } : {}) },
        maxOutputTokens: 4_000,
        format: { name: "migration_review", schema: migrationReviewResultSchema },
        purpose: "migration-review",
        signal,
    });
    const parsed = migrationReviewResultSchema.safeParse(output);
    if (!parsed.success) {
        const details = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        throw new Error(`The reviewer returned an invalid answer: ${details}`);
    }
    return { result: parsed.data, model, auditId, usage, latencyMs };
}

/**
 * Keeps the findings that are about something in the report. A finding that names a table or column the plan does not have is invented, and is
 * dropped (and counted, so the page can say so); the names that stay are written as the report writes them.
 */
export function checkFindings(findings: ReviewFinding[], tables: { oracleName: string; columns: { oracleName: string }[] }[]): { findings: ReviewFinding[]; dropped: number } {
    const kept: ReviewFinding[] = [];
    const seen = new Set<string>();
    // a model that means "no table" sometimes writes an empty string instead of null: it is the same thing
    const blankToNull = (value: string | null): string | null => (value === null || value.trim() === "" ? null : value.trim());
    for (const finding of findings) {
        const wantedTable = blankToNull(finding.table);
        const wantedColumn = blankToNull(finding.column);
        let table: string | null = null;
        let column: string | null = null;
        if (wantedTable !== null) {
            const found = tables.find((candidate) => candidate.oracleName.toLowerCase() === wantedTable.toLowerCase());
            if (!found) continue;
            table = found.oracleName;
            if (wantedColumn !== null) {
                const foundColumn = found.columns.find((candidate) => candidate.oracleName.toLowerCase() === wantedColumn.toLowerCase());
                if (!foundColumn) continue;
                column = foundColumn.oracleName;
            }
        } else if (wantedColumn !== null) continue;
        const key = `${finding.severity}|${table}|${column}|${finding.title.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push({ ...finding, table, column, suggestion: blankToNull(finding.suggestion) });
    }
    return { findings: kept, dropped: findings.length - kept.length };
}
