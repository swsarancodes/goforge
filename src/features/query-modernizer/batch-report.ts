import { BATCH_STATUSES, BatchItem, BatchResult, BatchStatus, STATUS_LABELS } from "./batch";
import { LEGACY_DIALECTS } from "./types";

/**
 * What leaves the tool after a batch run: the converted file, a report a person can read in a review meeting, and a
 * spreadsheet row per statement. Every number is a count of statements with a given fact; nothing is a score.
 */

const dialectLabel = (result: BatchResult): string => LEGACY_DIALECTS.find((option) => option.value === result.dialect)?.label ?? result.dialect;
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const commented = (text: string, prefix = "-- "): string => text.split("\n").map((line) => `${prefix}${line}`.replace(/\s+$/, "")).join("\n");
const plural = (count: number, word: string): string => `${count.toLocaleString("en-US")} ${count === 1 ? word : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`;

/** The statement as it should appear in a script: the converted SQL for what converted, the original in comments for what did not. */
export interface ScriptOptions {
    /** Write statements that need review as SQL (default) or as comments, so the file can be run without them. */
    reviewAsSql?: boolean;
}

const asStatement = (sql: string): string => `${sql.replace(/[\s;]+$/, "")};`;

export function convertedScript(result: BatchResult, options: ScriptOptions = {}): string {
    const reviewAsSql = options.reviewAsSql ?? true;
    const { summary } = result;
    const lines: string[] = [
        `-- ${dialectLabel(result)} script converted to PostgreSQL by GoForge.`,
        `-- ${plural(summary.queries, "query")} (${summary.byStatus.converted} converted, ${summary.byStatus.unchanged} already PostgreSQL, ${summary.byStatus.review} to review, ${summary.byStatus.failed} not converted); ${summary.units - summary.queries} other statement${summary.units - summary.queries === 1 ? "" : "s"} left alone.`,
        "-- A statement marked NEEDS REVIEW is written as SQL but behaves differently, has bind variables, or was converted by a model: read it before running it.",
        "-- A statement that could not be converted, and everything that is not a query, is kept below as a comment with the reason. Nothing is dropped.",
        "-- Converting does not prove the new statement returns the same rows. Compare results on real data.",
        "",
    ];

    for (const item of result.items) {
        const { unit } = item;
        const place = unit.startLine === unit.endLine ? `line ${unit.startLine}` : `lines ${unit.startLine}-${unit.endLine}`;
        const original = unit.comments.trim();
        if (original) lines.push(original, "");

        if ((item.status === "converted" || item.status === "unchanged" || (item.status === "review" && reviewAsSql)) && item.outcome) {
            lines.push(`-- ${place}: ${STATUS_LABELS[item.status].toUpperCase()}${item.status === "review" ? ` - ${oneLine(item.reasons[0] ?? "")}` : ""}`);
            if (item.status === "review") for (const reason of item.reasons.slice(1)) lines.push(`--   ${oneLine(reason)}`);
            lines.push(asStatement(item.outcome.sql), "");
            continue;
        }
        const label = item.status === "out-of-scope" ? "NOT A QUERY" : item.status === "failed" ? "NOT CONVERTED" : "NEEDS REVIEW (kept as a comment)";
        lines.push(`-- ${place}: ${label}`);
        for (const reason of item.reasons) lines.push(`--   ${oneLine(reason)}`);
        lines.push(commented(unit.text), "");
    }
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

const table = (header: string[], rows: (string | number)[][]): string[] => [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, "\\|")).join(" | ")} |`)];

export interface ReportMeta {
    fileName?: string;
    generatedAt: string;
}

export function readinessMarkdown(result: BatchResult, meta: ReportMeta): string {
    const { summary } = result;
    const checkedBy = result.connectionName ? `PostgreSQL itself, through the connection "${result.connectionName}"` : "a PostgreSQL grammar only (no database connection was chosen)";
    const accepted = summary.verification.database;
    const parsedOnly = summary.verification.syntax;
    const out: string[] = [];
    out.push(`# Migration report: ${meta.fileName ?? "pasted script"} (${dialectLabel(result)} to PostgreSQL)`, "");
    out.push(`Generated ${meta.generatedAt}. ${plural(summary.units, "statement")} in ${plural(result.lineCount, "line")}; ${plural(summary.queries, "query")} and ${plural(summary.units - summary.queries, "statement")} that are not queries.`, "");
    if (result.aborted) out.push(`> The run was stopped early: ${plural(result.skipped, "statement")} were not converted and are not in this report.`, "");
    for (const warning of result.warnings) out.push(`> Warning: ${warning}`, "");

    out.push("## Where the statements stand", "");
    out.push(...table(["Status", "Statements", "What it means"], BATCH_STATUSES.map((status) => [STATUS_LABELS[status], summary.byStatus[status], MEANING[status]])), "");
    out.push(`Checked by: ${checkedBy}. ${accepted} of the ${plural(summary.queries - summary.byStatus.failed, "query")} that were not failures ${accepted === 1 ? "was" : "were"} accepted by the database${parsedOnly > 0 ? `; ${parsedOnly} ${parsedOnly === 1 ? "was" : "were"} only parsed` : ""}.`, "");
    if (summary.namesUnresolved > 0) out.push(`${plural(summary.namesUnresolved, "statement")} could not be checked against the database because it does not have a table, column or schema they use. Load the target schema, or choose a connection that has it, and run the file again.`, "");
    if (summary.convertedByModel > 0) out.push(`${plural(summary.convertedByModel, "statement")} ${summary.convertedByModel === 1 ? "was" : "were"} converted by a language model after the rules could not finish; each is marked for review.`, "");
    if (summary.repeated > 0) out.push(`${plural(summary.repeated, "statement")} repeated an earlier one word for word and reuse its conversion.`, "");

    const failed = result.items.filter((item) => item.status === "failed");
    out.push("## What blocks the migration", "");
    if (failed.length === 0) out.push("No statement failed.", "");
    else {
        if (summary.unconverted.length > 0) out.push("Constructs the rules could not convert:", "", ...table(["Construct", "Statements", "Why"], summary.unconverted.map((entry) => [`\`${entry.construct}\``, entry.statements, entry.reason])), "");
        if (summary.errors.length > 0) out.push("What PostgreSQL rejected:", "", ...table(["Message", "Statements"], summary.errors.map((entry) => [entry.message, entry.statements])), "");
    }

    out.push("## What needs a person", "");
    const review = result.items.filter((item) => item.status === "review");
    if (review.length === 0 && summary.traps.length === 0) out.push("Nothing was flagged.", "");
    else {
        if (summary.traps.length > 0) out.push("Behaviour that differs from the source database, by how many statements it appears in:", "", ...table(["Difference", "Statements", "Kind"], summary.traps.map((trap) => [trap.title, trap.statements, trap.severity === "changes-results" ? "can change results" : "worth checking"])), "");
        out.push(`${plural(review.length, "statement")} need review in total (see the list below).`, "");
    }

    out.push("## Not covered by this tool", "");
    const others = result.items.filter((item) => item.status === "out-of-scope");
    if (others.length === 0) out.push("Every statement in the file was a query.", "");
    else {
        const byKeyword = new Map<string, number>();
        for (const item of others) byKeyword.set(`${item.unit.kind}: ${item.unit.keyword}`, (byKeyword.get(`${item.unit.kind}: ${item.unit.keyword}`) ?? 0) + 1);
        out.push("These are listed, counted and left alone. Procedures, functions, packages and triggers need to be rewritten by hand or with another tool; the queries inside them were not checked.", "", ...table(["Kind and first word", "Statements"], [...byKeyword.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)), "");
    }

    out.push("## Rules that did the work", "");
    if (summary.rules.length === 0) out.push("No rule changed anything.", "");
    else out.push(...table(["Rule", "Family", "Statements", "Changes"], summary.rules.slice(0, 15).map((rule) => [rule.title, rule.family, rule.statements, rule.count])), "");

    out.push("## Statements that need attention", "");
    const attention = result.items.filter((item) => item.status === "failed" || item.status === "review");
    if (attention.length === 0) out.push("None.", "");
    else {
        out.push(...table(["Lines", "Status", "Why"], attention.slice(0, 200).map((item) => [item.unit.startLine === item.unit.endLine ? item.unit.startLine : `${item.unit.startLine}-${item.unit.endLine}`, STATUS_LABELS[item.status], oneLine(item.reasons.join(" "))])), "");
        if (attention.length > 200) out.push(`${plural(attention.length - 200, "more statement")} are in the CSV export.`, "");
    }

    out.push("## How to read this report", "");
    out.push("- A status is a fact about checks, not a probability. \"Converted\" means the rules finished and the result was accepted; it does not mean the new statement returns the same rows as the old one. Run both on the same data and compare.");
    out.push("- \"Accepted by the database\" means PostgreSQL planned the statement with EXPLAIN against the connection's tables, without running it. \"Only parsed\" means a PostgreSQL grammar read it; names and types were not checked.");
    out.push(`- Statements were converted in ${(result.elapsedMs / 1000).toFixed(1)} s. The model is only asked about statements the rules cannot finish, at most ${result.aiLimit} different statements per run${result.aiStatementsAsked > 0 ? ` (it was asked about ${result.aiStatementsAsked})` : ""}.`, "");
    return `${out.join("\n").trimEnd()}\n`;
}

const MEANING: Record<BatchStatus, string> = {
    converted: "The rules finished and the result was accepted.",
    unchanged: "No rule had anything to change; accepted as it is.",
    review: "Converted, but behaviour differs, there are bind variables, a model did it, or names could not be checked.",
    failed: "Not converted, or the result is not accepted.",
    "out-of-scope": "Not a query: procedure, schema statement or client command.",
};

// ---- CSV -------------------------------------------------------------------------------------------------------------------------------

const CELL_LIMIT = 30_000;

/** A cell that starts with = + - @ is read as a formula by spreadsheet programs; a leading quote makes it text. */
const cell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    let text = String(value);
    if (text.length > CELL_LIMIT) text = `${text.slice(0, CELL_LIMIT)}…[truncated]`;
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const CSV_COLUMNS = ["statement", "first_line", "last_line", "kind", "first_word", "status", "checked_by", "reasons", "notes", "rules_applied", "constructs_not_converted", "behaviour_differences", "repeats_statement", "source_sql", "converted_sql"] as const;

export function resultsCsv(result: BatchResult): string {
    const rows = result.items.map((item: BatchItem) => [
        item.unit.index + 1,
        item.unit.startLine,
        item.unit.endLine,
        item.unit.kind,
        item.unit.keyword,
        item.status,
        item.status === "out-of-scope" || item.status === "failed" ? "" : item.verification === "database" ? "database" : "grammar only",
        item.reasons.join(" "),
        item.notes.join(" "),
        item.outcome?.engine.applied.map((rule) => `${rule.id}${rule.count > 1 ? `x${rule.count}` : ""}`).join(" ") ?? "",
        item.outcome?.engine.unconverted.map((left) => oneLine(left.construct)).join(" | ") ?? "",
        item.outcome?.engine.traps.map((trap) => trap.title).join(" | ") ?? "",
        item.repeatOf !== undefined ? item.repeatOf + 1 : "",
        item.unit.text,
        item.status === "failed" || item.status === "out-of-scope" ? "" : (item.outcome?.sql ?? ""),
    ]);
    return `${[CSV_COLUMNS.join(","), ...rows.map((row) => row.map(cell).join(","))].join("\r\n")}\r\n`;
}
