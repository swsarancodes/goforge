import { Loader2, Play } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { HealthFinding, HealthReport, HealthSummary } from "@/lib/schema-change-api";
import { formatBytes, formatCount, formatRows, formatTime } from "../format";
import type { SchemaChange } from "../use-schema-change";

const HealthSkeleton: React.FC = () => (
    <div role="status" aria-busy="true" className="space-y-2">
        <span className="sr-only">Reading the catalog</span>
        {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border p-3">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3.5 w-8" />
            </div>
        ))}
    </div>
);

const Detail: React.FC<{ finding: HealthFinding }> = ({ finding }) => (
    <li className="flex items-start gap-2 py-1.5 text-xs">
        <span className="min-w-0 flex-1 break-words">{finding.summary}</span>
        {finding.bytes !== null && <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(finding.bytes)}</span>}
    </li>
);

const Summary: React.FC<{ summary: HealthSummary; report: HealthReport }> = ({ summary, report }) => {
    const byId = new Map(report.findings.map((finding) => [finding.id, finding]));
    return (
        <section className="space-y-2 rounded-lg border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-xs font-semibold">Summary written by {summary.model}</h3>
                {summary.redacted && <Badge variant="outline" className="text-[10px]">names redacted</Badge>}
            </div>
            <p className="text-xs">{summary.headline}</p>
            <ol className="list-decimal space-y-2 pl-4 text-xs">
                {summary.priorities.map((priority, index) => (
                    <li key={index} className="space-y-1">
                        <p>{priority.why}</p>
                        <ul className="space-y-0.5 text-muted-foreground">
                            {priority.findingIds.map((id) => <li key={id} className="break-words">{byId.get(id)?.summary ?? id}</li>)}
                        </ul>
                    </li>
                ))}
            </ol>
            <p className="text-[11px] text-muted-foreground">
                The order and the sentences are the model&apos;s. Each finding listed under them is a fact from the catalog.{summary.droppedIds > 0 ? ` ${summary.droppedIds} item(s) it named were not in the report and were dropped.` : ""}
            </p>
        </section>
    );
};

/** A read-only report from the catalog and statistics views. The model, when asked, only orders and explains the findings. */
export const HealthPanel: React.FC<{ state: SchemaChange }> = ({ state }) => {
    const report = state.health;
    const canSummarize = state.aiStatus?.configured === true && !!report && report.findings.length > 0;

    return (
        <div className="space-y-3 p-3">
            <div className="space-y-1">
                <h2 className="text-sm font-semibold">Schema health</h2>
                <p className="text-xs text-muted-foreground max-w-3xl">Checks the whole database from the catalog: tables without a primary key, foreign keys no index serves, duplicate and unused indexes, failed index builds, wide tables, stale statistics, sequences running out. Nothing is changed and no rows are read.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" className="h-8 gap-1.5" onClick={() => void state.loadHealth()} disabled={!state.connectionId || state.loadingHealth}>
                    {state.loadingHealth ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} {report ? "Run again" : "Run the checks"}
                </Button>
                <Button size="sm" variant="outline" className="h-8" onClick={() => void state.summarize()} disabled={!canSummarize || state.summarizing} title={state.aiStatus?.configured ? "Ask the model to put the findings in order" : "No model can be used (AI settings)"}>
                    {state.summarizing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null} Summarise with the model
                </Button>
                {report && <span className="text-[11px] text-muted-foreground">{report.tables.toLocaleString()} tables · PostgreSQL {report.serverVersion.split(" ")[0]} · {formatTime(report.generatedAt)}</span>}
            </div>

            {state.healthError && (
                <Alert variant="destructive" className="px-3 py-2.5">
                    <AlertTitle className="text-xs">Could not read the catalog</AlertTitle>
                    <AlertDescription className="break-words text-xs">{state.healthError}</AlertDescription>
                </Alert>
            )}
            {state.loadingHealth && !report && <HealthSkeleton />}

            {report && state.summary && <Summary summary={state.summary} report={report} />}

            {report && (
                <>
                    <ul className="space-y-1.5">
                        {report.categories.map((category) => {
                            const findings = report.findings.filter((finding) => finding.category === category.category);
                            return (
                                <li key={category.category} className="rounded-lg border bg-card">
                                    <details>
                                        <summary className="flex cursor-pointer list-none items-center gap-2 p-2.5">
                                            <span className="min-w-0 flex-1 text-xs font-medium">{category.label}</span>
                                            <Badge variant={category.count === 0 ? "outline" : "secondary"} className="shrink-0 tabular-nums">{category.count}</Badge>
                                        </summary>
                                        <div className="space-y-1 border-t p-2.5">
                                            <p className="text-[11px] text-muted-foreground">{category.why}</p>
                                            {findings.length === 0 ? <p className="text-xs text-muted-foreground">None found.</p> : <ul className="divide-y">{findings.map((finding) => <Detail key={finding.id} finding={finding} />)}</ul>}
                                            {category.count > category.shown && <p className="text-[11px] text-muted-foreground">{formatCount(category.count - category.shown)} more not listed (the largest first).</p>}
                                        </div>
                                    </details>
                                </li>
                            );
                        })}
                    </ul>

                    <section className="space-y-1">
                        <h3 className="text-xs font-semibold">Largest tables</h3>
                        <ul className="divide-y rounded-lg border bg-card px-3">
                            {report.largest.map((table) => (
                                <li key={table.table} className="flex items-center gap-2 py-1.5 text-xs">
                                    <span className="min-w-0 flex-1 truncate">{table.table}</span>
                                    <span className="shrink-0 tabular-nums text-muted-foreground">{formatRows(table.rows)} · {formatBytes(table.bytes)}</span>
                                </li>
                            ))}
                        </ul>
                    </section>

                    <section className="space-y-1">
                        <h3 className="text-xs font-semibold">What this report cannot tell you</h3>
                        <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                            {report.limits.map((limit) => <li key={limit}>{limit}</li>)}
                        </ul>
                    </section>
                </>
            )}
        </div>
    );
};
