import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MigrationReport, ReportColumn, ReportSample, ReportTable } from "@/lib/migrations-api";
import { cn } from "@/lib/utils";
import { ASSISTANT_NAME } from "./assistant";
import { StatusBadge } from "./migration-checklist";
import { reportToMarkdown, type MarkdownExtras } from "./report-markdown";
import type { Migration } from "./use-migration";

const VERDICT: Record<MigrationReport["verdict"], { label: string; text: string; className: string }> = {
    ready: { label: "Ready", text: "Nothing blocks the migration.", className: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400" },
    "needs-acceptance": { label: "Needs acceptance", text: "Some values would change or be lost. They have to be accepted by name before the migration can start.", className: "border-amber-500/50 text-amber-700 dark:text-amber-400" },
    blocked: { label: "Blocked", text: "The migration cannot run as planned.", className: "border-destructive/50 text-destructive" },
};

const n = (value: number) => value.toLocaleString("en-US");
const shown = (value: string | null) => (value === null ? <span className="italic text-muted-foreground">NULL</span> : value === "" ? <span className="text-muted-foreground">""</span> : value);

/** The report as a file: the facts, with the AI commentary and the approval each in a block of its own when there are any. */
export function downloadReport(report: MigrationReport, extras: MarkdownExtras): void {
    const blob = new Blob([reportToMarkdown(report, extras)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `migration-report-${report.source.replace(/[^A-Za-z0-9_-]+/g, "-")}-${report.generatedAt.slice(0, 10)}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

const counted = (column: ReportColumn): React.ReactNode => {
    if (!column.facts) return null;
    const { facts } = column;
    return (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
            Counted on your data: {n(facts.nulls)} NULL of {n(facts.nulls + facts.values)}
            {facts.affected.map((entry) => (
                <span key={entry.label} className={cn(entry.count > 0 && "text-foreground")}>; {n(entry.count)} {entry.label}</span>
            ))}
            .
        </p>
    );
};

const SampleView: React.FC<{ sample: ReportSample }> = ({ sample }) => (
    <div className="space-y-1">
        <p className="font-medium">Sample rows: the value in Oracle, and the value PostgreSQL will receive</p>
        <p className="text-muted-foreground">{sample.ordered ? "The first rows by primary key, read only." : "This table has no key, so these are simply the first rows the database returned."} A value that changes is shown in both.</p>
        <div className="overflow-x-auto rounded border">
            <table className="w-full min-w-[30rem] text-left">
                <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                        <th className="px-2 py-1 font-medium">Column</th>
                        {sample.oracle.map((_, index) => <th key={index} className="px-2 py-1 font-medium">Row {index + 1}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {sample.columns.map((name, columnIndex) => (
                        <tr key={name} className="border-t align-top">
                            <td className="px-2 py-1 font-mono">{name}</td>
                            {sample.oracle.map((row, rowIndex) => {
                                const oracle = row[columnIndex];
                                const postgres = sample.postgres[rowIndex][columnIndex];
                                return (
                                    <td key={rowIndex} className="max-w-[16rem] break-words px-2 py-1 font-mono">
                                        {oracle === postgres ? shown(oracle) : (
                                            <span>
                                                <span className="text-muted-foreground">{shown(oracle)}</span>
                                                <span className="px-1 text-muted-foreground">to</span>
                                                <span className="font-semibold text-foreground">{shown(postgres)}</span>
                                            </span>
                                        )}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
        <details>
            <summary className="cursor-pointer select-none text-muted-foreground">Show the query that read them</summary>
            <pre className="mt-1 select-all overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-1.5 font-mono text-[10px]">{sample.sql}</pre>
        </details>
    </div>
);

const TableView: React.FC<{ table: ReportTable; open: boolean }> = ({ table, open }) => {
    const toRead = table.columns.filter((column) => column.status !== "exact" || column.edited.length > 0).length;
    return (
        <details className="min-w-0 rounded-md border" open={open}>
            <summary className="cursor-pointer select-none px-2 py-1.5">
                <span className="font-mono">{table.oracleName}</span> to <span className={cn("font-mono", table.renamed && "font-semibold")}>{table.pgName}</span>
                {table.renamed && <span className="ml-1 rounded border px-1 py-0.5 text-[10px] text-muted-foreground">renamed by you</span>}
                <span className="text-muted-foreground"> · {n(table.rows)} rows · {table.columns.length} columns{toRead > 0 ? ` · ${toRead} to read` : ""}{table.primaryKey.length > 0 ? ` · primary key ${table.primaryKey.join(", ")}` : " · no primary key"}</span>
            </summary>
            <div className="space-y-3 border-t p-2">
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[36rem] text-left">
                        <thead className="text-muted-foreground">
                            <tr>
                                <th className="px-2 py-1 font-medium">Oracle column</th>
                                <th className="px-2 py-1 font-medium">Oracle type</th>
                                <th className="px-2 py-1 font-medium">PostgreSQL type</th>
                                <th className="px-2 py-1 font-medium">What happens to the value</th>
                            </tr>
                        </thead>
                        <tbody>
                            {table.columns.map((column) => (
                                <tr key={column.oracleName} className={cn("border-t align-top", column.edited.length > 0 && "bg-muted/30")}>
                                    <td className="px-2 py-1 font-mono">
                                        {column.oracleName}
                                        <span className="block font-sans text-[10px] text-muted-foreground">to <span className={cn(column.edited.includes("name") && "font-semibold text-foreground")}>{column.pgName}</span>{column.nullable ? "" : ", NOT NULL"}</span>
                                        {column.edited.length > 0 && <span className="mt-0.5 inline-block rounded border px-1 font-sans text-[10px] text-muted-foreground">changed by you</span>}
                                    </td>
                                    <td className="px-2 py-1 font-mono">{column.oracleType}</td>
                                    <td className={cn("px-2 py-1 font-mono", column.edited.includes("type") && "font-semibold")}>{column.pgType}</td>
                                    <td className="px-2 py-1">
                                        <StatusBadge status={column.dataChange.status} />
                                        <span className="mt-0.5 block text-muted-foreground">{column.dataChange.summary}</span>
                                        {column.dataChange.notes.map((note) => <span key={note} className="block text-[11px] text-muted-foreground">{note}</span>)}
                                        {counted(column)}
                                        {column.check && (
                                            <span className={cn("block text-[11px]", column.check.count === 0 ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
                                                {column.check.count === null ? `Could not be checked on your data (${column.check.error ?? "the query failed"}).` : column.check.count === 0 ? `Checked: no value is affected (${column.check.description}).` : `Checked: ${n(column.check.count)} affected (${column.check.description}).`}
                                            </span>
                                        )}
                                        <details className="mt-0.5">
                                            <summary className="cursor-pointer select-none text-[11px] text-muted-foreground">How it is read and loaded</summary>
                                            <p className="mt-0.5 text-[11px]"><span className="text-muted-foreground">Read from Oracle:</span> <code className="break-all font-mono text-[10px]">{column.dataChange.read}</code></p>
                                            <p className="text-[11px]"><span className="text-muted-foreground">Received by PostgreSQL:</span> <code className="font-mono text-[10px]">{column.dataChange.load}</code></p>
                                            <p className="text-[11px] text-muted-foreground">{column.note}</p>
                                        </details>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {table.sample && table.sample.oracle.length > 0 && <SampleView sample={table.sample} />}
            </div>
        </details>
    );
};

/**
 * The report above the Migrate button. Everything in it is the plan or what was read from the Oracle data; the model's paragraph, if asked
 * for, sits in a box of its own that says what it is. Reading it and approving it is what allows the migration to start.
 */
export const ReportPanel: React.FC<{ migration: Migration; report: MigrationReport }> = ({ migration, report }) => {
    const { summary, summarizing, summaryError, writeSummary, loadingReport } = migration;
    const verdict = VERDICT[report.verdict];
    const s = report.summary;
    const byYou = report.renames.filter((rename) => rename.by === "you");
    const byCase = report.renames.filter((rename) => rename.by === "case");

    return (
        <section className="min-w-0 space-y-3 rounded-lg border bg-card p-3 text-xs" aria-label="Migration report" data-testid="migration-report">
            <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-medium">Migration report</h2>
                <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-medium", verdict.className)}>{verdict.label}</span>
                {loadingReport && <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Reading your data again…</span>}
                <div className="ml-auto flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void writeSummary()} disabled={summarizing || loadingReport}>
                        {summarizing ? <Loader2 className="size-3 animate-spin" /> : null} {summary ? "Write the summary again" : "Write a plain-language summary"}
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => downloadReport(report, { summary: summary ? { text: summary.text, model: summary.model } : undefined })} disabled={loadingReport}>
                        <Download className="size-3" /> Download (.md)
                    </Button>
                </div>
            </div>
            <p className="text-muted-foreground">{verdict.text} Read this before you approve: it says exactly what changes in the schema and in the data. {report.dataRead ? "The counts and sample rows were read from your Oracle data, read only." : "Your data was not read for this report."}</p>

            {(summary || summaryError) && (
                <div className="space-y-1 rounded-md border border-dashed p-2" data-testid="ai-commentary">
                    <p className="flex flex-wrap items-center gap-1.5 font-medium">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">AI commentary</span>
                        {summary && <span className="font-normal text-muted-foreground">written by {summary.model} ({ASSISTANT_NAME}) from the figures below</span>}
                    </p>
                    {summary && <p className="whitespace-pre-wrap">{summary.text}</p>}
                    {summary && <p className="text-[11px] text-muted-foreground">This is commentary. It is not part of the report's facts, and it is not what you approve: every fact below comes from your plan or from reading your database.</p>}
                    {summaryError && <p role="alert" className="text-destructive">{summaryError}</p>}
                </div>
            )}

            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                <p><span className="font-medium">{s.tables}</span> table{s.tables === 1 ? "" : "s"}, <span className="font-medium">{s.columns}</span> columns, <span className="font-medium">{n(s.rows)}</span> rows</p>
                <p><span className="font-medium">{s.exact}</span> stay the same, <span className="font-medium">{s.changed}</span> behave differently, <span className="font-medium">{s.risk}</span> may lose data</p>
                <p>The copy: <span className="font-medium">{s.values.kept}</span> kept as they are, <span className="font-medium">{s.values.reformatted}</span> written another way, <span className="font-medium">{s.values.converted}</span> converted, <span className="font-medium">{s.values.dropped}</span> with something dropped</p>
                <p><span className="font-medium">{s.changesByYou}</span> change{s.changesByYou === 1 ? "" : "s"} by you, <span className="font-medium">{s.notCarried}</span> object{s.notCarried === 1 ? "" : "s"} not carried over, <span className="font-medium">{s.problems}</span> blocking problem{s.problems === 1 ? "" : "s"}</p>
            </div>

            {report.editProblems.length > 0 && (
                <div className="rounded-md border border-amber-500/50 p-2" role="status">
                    <p className="font-medium">These changes could not be made</p>
                    <ul className="list-disc pl-4 text-muted-foreground">{report.editProblems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
                </div>
            )}
            {report.mustAccept.length > 0 && (
                <div className="rounded-md border border-destructive/40 p-2">
                    <p className="font-medium">Values that would change or be lost</p>
                    <ul className="list-disc pl-4">
                        {report.mustAccept.map((entry) => (
                            <li key={`${entry.table}.${entry.column}`}>
                                <span className="font-mono">{entry.table}.{entry.column}</span>: {entry.count === null ? `the check could not run (${entry.error ?? "the query failed"})` : `${n(entry.count)} ${entry.description}`}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {report.renames.length > 0 && (
                <div>
                    <p className="font-medium">Names</p>
                    {byYou.length > 0 && <ul className="list-disc pl-4">{byYou.map((rename) => <li key={`${rename.table}.${rename.from}`}>{rename.kind} <span className="font-mono">{rename.kind === "column" ? `${rename.table}.${rename.from}` : rename.from}</span> to <span className="font-mono font-semibold">{rename.to}</span> <span className="text-muted-foreground">(your change)</span></li>)}</ul>}
                    {byCase.length > 0 && <p className="text-muted-foreground">{n(byCase.length)} name{byCase.length === 1 ? "" : "s"} Oracle writes in upper case become lower case, as every unquoted name does (for example <span className="font-mono">{byCase[0].from}</span> to <span className="font-mono">{byCase[0].to}</span>). A query written without quotes finds them either way.</p>}
                </div>
            )}
            {(report.droppedDefaults.length > 0 || report.rewrittenDefaults.length > 0) && (
                <div>
                    <p className="font-medium">Defaults</p>
                    <ul className="list-disc pl-4">
                        {report.droppedDefaults.map((entry) => <li key={`d${entry.table}.${entry.column}`}><span className="font-mono">{entry.table}.{entry.column}</span> default <span className="font-mono">{entry.oracleDefault}</span> is dropped: {entry.detail}</li>)}
                        {report.rewrittenDefaults.map((entry) => <li key={`r${entry.table}.${entry.column}`}><span className="font-mono">{entry.table}.{entry.column}</span> default <span className="font-mono">{entry.oracleDefault}</span> {entry.detail}</li>)}
                    </ul>
                </div>
            )}

            <div className="space-y-1">
                <p className="font-medium">Table by table</p>
                {report.tables.map((table, index) => <TableView key={table.oracleName} table={table} open={index === 0 && report.tables.length <= 2} />)}
            </div>

            <div>
                <p className="font-medium">Not carried over</p>
                {report.notCarried.length === 0 ? (
                    <p className="text-muted-foreground">Nothing else in the schema: no indexes beyond the keys, CHECK constraints, sequences, views, triggers or programs.</p>
                ) : (
                    <>
                        <p className="text-muted-foreground">The migration carries tables, columns, NOT NULL, same-meaning defaults, primary keys, unique constraints and foreign keys. These are left behind, and would have to be recreated in PostgreSQL by hand:</p>
                        <ul className="list-disc pl-4">{report.notCarried.map((entry) => <li key={`${entry.kind}:${entry.name}`}>{entry.kind} <span className="font-mono">{entry.name}</span>{entry.detail ? <span className="text-muted-foreground"> ({entry.detail})</span> : null}</li>)}</ul>
                    </>
                )}
            </div>
            {report.behaviour.length > 0 && (
                <div>
                    <p className="font-medium">Behaves differently in queries, whatever is stored</p>
                    <ul className="list-disc pl-4 text-muted-foreground">{report.behaviour.map((note) => <li key={note}>{note}</li>)}</ul>
                </div>
            )}
        </section>
    );
};
