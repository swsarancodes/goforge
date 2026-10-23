import { z } from "zod";
import type { ModelCall, ModelResult } from "../ai/provider.js";
import { findingsForSummary, type HealthReport } from "./health.js";
import { Redactor, type NameEntry } from "./redact.js";

/**
 * The model's part in the health report: put the findings in an order and say why. It is shown the findings by id, category,
 * names and numbers, and may only answer with ids that exist. Anything it says about an id that is not in the report is dropped,
 * and the report itself is never changed by the answer.
 */

export const healthAnswerSchema = z.object({
    headline: z.string().trim().min(1).max(1_000),
    priorities: z
        .array(z.object({ findingIds: z.array(z.string()).min(1).max(20), why: z.string().trim().min(1).max(600) }))
        .max(12),
});

export interface HealthSummary {
    headline: string;
    priorities: { findingIds: string[]; why: string }[];
    /** Ids the model named that are not in the report. */
    droppedIds: number;
    model: string;
    auditId: number;
    redacted: boolean;
}

const INSTRUCTIONS = [
    "You summarise a PostgreSQL schema health report for the person who runs the database. The findings are facts measured from the catalog; you do not add, remove or change them.",
    "Return JSON only: { headline: string, priorities: [{ findingIds: string[], why: string }] }.",
    "headline is one or two sentences about the database as a whole, using only what the findings show.",
    "priorities lists up to 8 groups of findings in the order someone should look at them. findingIds must be ids copied exactly from the findings you were given. why is one sentence about the effect, using the numbers in the findings (bytes, rows, scans).",
    "Do not invent findings, tables, numbers or causes. Do not give SQL. If there are no findings, say so in the headline and return no priorities.",
].join("\n");

const namesOf = (report: HealthReport): NameEntry[] => {
    const entries: NameEntry[] = [];
    for (const finding of report.findings) {
        if (finding.table) {
            const [schema, ...rest] = finding.table.split(".");
            entries.push({ name: schema, kind: "schema" }, { name: rest.join("."), kind: "table" });
        }
        if (finding.object) entries.push({ name: finding.object.includes(".") ? finding.object.split(".").slice(1).join(".") : finding.object, kind: "index" });
        for (const value of Object.values(finding.detail)) {
            if (typeof value === "string") entries.push({ name: value, kind: "column" });
            if (Array.isArray(value)) for (const item of value) entries.push({ name: item, kind: "column" });
        }
    }
    return entries.filter((entry) => entry.name.length > 0 && !/^\d+$/.test(entry.name));
};

export async function summarizeHealth(
    report: HealthReport,
    deps: { callModel(call: ModelCall): Promise<ModelResult> },
    options: { redact: boolean; connection: { id: string; name: string }; signal?: AbortSignal },
): Promise<HealthSummary> {
    const redactor = options.redact ? new Redactor(namesOf(report)) : undefined;
    const shown = findingsForSummary(report);
    const ids = new Map(shown.map((finding) => [redactor ? redactor.maskDeep(finding.id) : finding.id, finding.id]));
    const input = {
        tables: report.tables,
        counts: report.categories.map(({ category, count }) => ({ category, count })),
        findings: redactor ? redactor.maskDeep(shown) : shown,
    };

    const result = await deps.callModel({
        instructions: INSTRUCTIONS,
        input,
        maxOutputTokens: 2_000,
        format: { name: "health_summary", schema: healthAnswerSchema },
        signal: options.signal,
        purpose: "health-summary",
        context: { connectionId: options.connection.id, connectionName: options.connection.name, redacted: Boolean(redactor), detail: { findings: shown.length } },
    });

    const parsed = healthAnswerSchema.safeParse(result.output);
    if (!parsed.success) throw new Error(`The model's summary was not in the expected format: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);

    let droppedIds = 0;
    const priorities = parsed.data.priorities
        .map((priority) => {
            const known = priority.findingIds.flatMap((id) => {
                const real = ids.get(id) ?? (redactor ? undefined : ids.get(id));
                if (real === undefined) droppedIds++;
                return real === undefined ? [] : [real];
            });
            return { findingIds: known, why: redactor ? redactor.unmask(priority.why) : priority.why };
        })
        .filter((priority) => priority.findingIds.length > 0);

    return { headline: redactor ? redactor.unmask(parsed.data.headline) : parsed.data.headline, priorities, droppedIds, model: result.model, auditId: result.auditId, redacted: Boolean(redactor) };
}
