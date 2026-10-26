import type { MigrationApproval, MigrationReport, ReportColumn, ReportTable } from "@/lib/migrations-api";

/**
 * The migration report as a Markdown document, for attaching to an approval and keeping. Every fact in it is the report's: the plan and what
 * was read from the data. An AI summary, if there is one, is placed in a block of its own that says what it is, and the approval, if the
 * report was approved, says when and carries the report's fingerprint so the document can be matched to what ran.
 */

export interface MarkdownExtras {
    /** The model's opening paragraph, with the model that wrote it. */
    summary?: { text: string; model: string };
    approval?: MigrationApproval;
}

const VERDICT: Record<MigrationReport["verdict"], string> = {
    ready: "Ready: nothing blocks the migration.",
    "needs-acceptance": "Needs acceptance: some values would change or be lost, and have to be accepted by name before the migration can start.",
    blocked: "Blocked: the migration cannot run as planned.",
};

const STATUS = { exact: "same", changed: "behaves differently", risk: "may lose data" } as const;

/** One table cell: the pipe and the line break would end it. */
const cell = (text: string | null | undefined): string => (text === null || text === undefined ? "" : String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " "));
const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

const countedText = (column: ReportColumn): string => {
    if (!column.facts) return "";
    const parts = [`${column.facts.nulls.toLocaleString("en-US")} NULL of ${(column.facts.nulls + column.facts.values).toLocaleString("en-US")}`];
    for (const entry of column.facts.affected) parts.push(`${entry.count.toLocaleString("en-US")} ${entry.label}`);
    if (column.check) parts.push(column.check.count === null ? `check could not run: ${column.check.error ?? "the query failed"}` : `${column.check.count.toLocaleString("en-US")} ${column.check.description}`);
    return parts.join("; ");
};

function tableSection(table: ReportTable): string[] {
    const lines = [`### ${table.oracleName} to ${table.pgName}${table.renamed ? " (renamed by you)" : ""}`, "", `${plural(table.rows, "row")}; primary key ${table.primaryKey.length > 0 ? table.primaryKey.join(", ") : "none"}.`, ""];
    lines.push("| Oracle column | Oracle type | PostgreSQL column | PostgreSQL type | Values | What the copy does to the value | Counted on the data |", "|---|---|---|---|---|---|---|");
    for (const column of table.columns) {
        const changedBy = column.edited.length > 0 ? ` (changed by you: ${column.edited.join(", ")})` : "";
        lines.push(`| ${cell(column.oracleName)} | ${cell(column.oracleType)} | ${cell(column.pgName)}${changedBy ? cell(changedBy) : ""} | ${cell(column.pgType)} | ${STATUS[column.status]} | ${cell(column.dataChange.summary)} | ${cell(countedText(column))} |`);
    }
    if (table.sample && table.sample.oracle.length > 0) {
        const sample = table.sample;
        lines.push("", `Sample rows, each value as Oracle shows it, then as PostgreSQL will receive it when they differ${sample.ordered ? ", the first by primary key" : " (the table has no key: these are the first rows the database returned)"}:`, "");
        lines.push(`| Column | ${sample.oracle.map((_, index) => `Row ${index + 1}`).join(" | ")} |`, `|---|${sample.oracle.map(() => "---").join("|")}|`);
        sample.columns.forEach((name, columnIndex) => {
            const values = sample.oracle.map((row, rowIndex) => {
                const oracle = row[columnIndex];
                const postgres = sample.postgres[rowIndex][columnIndex];
                const shown = (value: string | null) => (value === null ? "NULL" : value === "" ? '""' : value);
                return oracle === postgres ? shown(oracle) : `${shown(oracle)} → ${shown(postgres)}`;
            });
            lines.push(`| ${cell(name)} | ${values.map(cell).join(" | ")} |`);
        });
    }
    return [...lines, ""];
}

export function reportToMarkdown(report: MigrationReport, extras: MarkdownExtras = {}): string {
    const out: string[] = [];
    const s = report.summary;
    out.push(`# Migration report: ${report.source} to PostgreSQL`, "");
    out.push(`Generated ${report.generatedAt}. Report fingerprint \`${report.hash}\`.`, "", `**${VERDICT[report.verdict]}**`, "");

    if (extras.approval) {
        out.push("## Approval", "", `This report was approved at ${extras.approval.approvedAt}, and the migration ran under it. The fingerprint of the approved report is \`${extras.approval.reportHash}\`${extras.approval.reportHash === report.hash ? ", the same as this document's." : ", which is not this document's: the data or the plan moved after it was approved."}`, "");
    }

    if (extras.summary) {
        out.push("## AI commentary", "", `> Written by the model ${extras.summary.model} from the figures in this report. It is commentary, not part of what was approved: every fact in this document comes from the plan or from reading the database.`, "", extras.summary.text.trim(), "");
    }

    out.push("## Summary", "");
    out.push(`- ${plural(s.tables, "table")}, ${plural(s.columns, "column")}, ${plural(s.rows, "row")}.`);
    out.push(`- Values: ${s.exact} column${s.exact === 1 ? "" : "s"} stay the same, ${s.changed} behave differently, ${s.risk} may lose data.`);
    out.push(`- What the copy does to the values: ${s.values.kept} kept as they are, ${s.values.reformatted} written another way, ${s.values.converted} converted, ${s.values.dropped} with something dropped.`);
    out.push(`- ${plural(s.changesByYou, "change")} made by you; ${plural(s.notCarried, "object")} not carried over; ${plural(s.problems, "blocking problem")}.`);
    out.push(`- ${report.dataRead ? "The counts and sample rows below were read from the Oracle data (read only)." : "The Oracle data was not read for this report: it has no counts or sample rows."}`, "");

    if (report.problems.length > 0) out.push("## Blocking problems", "", ...report.problems.map((problem) => `- ${problem}`), "");
    if (report.editProblems.length > 0) out.push("## Changes that could not be made", "", ...report.editProblems.map((problem) => `- ${problem}`), "");
    if (report.mustAccept.length > 0) {
        out.push("## Values that would change or be lost, to be accepted", "");
        for (const entry of report.mustAccept) out.push(`- ${code(`${entry.table}.${entry.column}`)}: ${entry.count === null ? `the check could not run (${entry.error ?? "the query failed"})` : `${entry.count.toLocaleString("en-US")} ${entry.description}`}`);
        out.push("");
    }

    const byYou = report.renames.filter((rename) => rename.by === "you");
    const byCase = report.renames.filter((rename) => rename.by === "case");
    if (report.renames.length > 0) {
        out.push("## Names", "");
        if (byYou.length > 0) out.push("Chosen by you:", "", ...byYou.map((rename) => `- ${rename.kind} ${code(rename.kind === "column" ? `${rename.table}.${rename.from}` : rename.from)} to ${code(rename.to)}`), "");
        if (byCase.length > 0) out.push(`${plural(byCase.length, "name")} Oracle writes in upper case become lower case, as every unquoted name does (for example ${code(byCase[0].from)} to ${code(byCase[0].to)}).`, "");
    }
    if (report.droppedDefaults.length > 0 || report.rewrittenDefaults.length > 0) {
        out.push("## Defaults", "");
        for (const entry of report.droppedDefaults) out.push(`- Dropped: ${code(`${entry.table}.${entry.column}`)} default ${code(entry.oracleDefault)}, because ${entry.detail}.`);
        for (const entry of report.rewrittenDefaults) out.push(`- Rewritten: ${code(`${entry.table}.${entry.column}`)} default ${code(entry.oracleDefault)} ${entry.detail}.`);
        out.push("");
    }

    out.push("## Tables", "");
    for (const table of report.tables) out.push(...tableSection(table));

    out.push("## Not carried over", "");
    if (report.notCarried.length === 0) out.push("Nothing else in the schema: no indexes beyond the keys, CHECK constraints, sequences, views, triggers or programs.", "");
    else out.push("The migration carries tables, columns, NOT NULL, same-meaning defaults, primary keys, unique constraints and foreign keys. These are left behind:", "", ...report.notCarried.map((entry) => `- ${entry.kind} ${code(entry.name)}${entry.detail ? ` (${entry.detail})` : ""}`), "");

    if (report.behaviour.length > 0) out.push("## Behaves differently in queries, whatever is stored", "", ...report.behaviour.map((note) => `- ${note}`), "");
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
