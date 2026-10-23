import React, { useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { BATCH_STATUSES, BatchItem, BatchStatus, STATUS_LABELS } from "../batch";
import { ChangesPanel } from "../components/changes-panel";
import { ChecksPanel } from "../components/checks-panel";
import { CompareView } from "../components/compare-view";
import type { Batch } from "./use-batch";

const PAGE = 200;

export const STATUS_STYLE: Record<BatchStatus, string> = {
    converted: "border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
    unchanged: "border-border text-muted-foreground",
    review: "border-amber-500/60 text-amber-700 dark:text-amber-400",
    failed: "border-destructive/60 text-destructive",
    "out-of-scope": "border-dashed border-border text-muted-foreground",
};

export const StatusBadge: React.FC<{ status: BatchStatus }> = ({ status }) => (
    <Badge variant="outline" className={cn("shrink-0 whitespace-nowrap text-[10px] font-normal", STATUS_STYLE[status])}>
        {STATUS_LABELS[status]}
    </Badge>
);

const preview = (text: string, length = 110): string => {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

const Detail: React.FC<{ item: BatchItem; onOpenSingle: (sql: string) => void; onOpenEditor: (sql: string) => void }> = ({ item, onOpenSingle, onOpenEditor }) => {
    const outcome = item.outcome;
    const [tab, setTab] = useState("why");
    const hasConverted = outcome && item.status !== "failed";

    return (
        <div className="border-t bg-muted/20 p-2.5">
            <Tabs value={tab} onValueChange={setTab} className="gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <TabsList className="h-8">
                        <TabsTrigger value="why" className="px-2.5 text-xs">Why</TabsTrigger>
                        {outcome && <TabsTrigger value="compare" className="px-2.5 text-xs">Compare</TabsTrigger>}
                        {outcome && outcome.engine.applied.length > 0 && <TabsTrigger value="changes" className="px-2.5 text-xs">Changes <span className="ml-1 text-muted-foreground">{outcome.engine.applied.length}</span></TabsTrigger>}
                        {outcome && <TabsTrigger value="checks" className="px-2.5 text-xs">Checks</TabsTrigger>}
                    </TabsList>
                    {outcome && (
                        <div className="flex flex-wrap gap-1.5">
                            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => onOpenSingle(item.unit.text)} title="Open this statement in the one-query view to try the model, or to read it with the full Checks tab">
                                <ArrowUpRight className="size-3" /> One-query view
                            </Button>
                            {hasConverted && (
                                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => onOpenEditor(outcome.sql)} title="Open the converted SQL in the SQL Editor to run it against a connection">
                                    <ArrowUpRight className="size-3" /> SQL Editor
                                </Button>
                            )}
                        </div>
                    )}
                </div>

                <TabsContent value="why" className="m-0 space-y-2 text-xs">
                    <ul className="list-disc space-y-1 pl-4 break-words">
                        {item.reasons.map((reason, index) => (
                            <li key={index}>{reason}</li>
                        ))}
                    </ul>
                    {item.notes.length > 0 && (
                        <ul className="list-disc space-y-1 pl-4 text-muted-foreground break-words">
                            {item.notes.map((note, index) => (
                                <li key={index}>{note}</li>
                            ))}
                        </ul>
                    )}
                    {item.repeatOf !== undefined && <p className="text-muted-foreground">Same as statement {item.repeatOf + 1} word for word; the conversion is reused.</p>}
                    {outcome && outcome.engine.unconverted.length > 0 && item.status === "failed" && (
                        <div className="space-y-1.5">
                            {outcome.engine.unconverted.map((left, index) => (
                                <div key={index} className="rounded-md bg-muted/50 p-2">
                                    <code className="break-all font-mono text-[11px]">{left.construct}</code>
                                    <p className="mt-0.5 text-muted-foreground">{left.reason}.</p>
                                    {left.hint && <p>Instead: {left.hint}</p>}
                                </div>
                            ))}
                        </div>
                    )}
                    {!outcome && <pre className="max-h-48 overflow-auto rounded-md border bg-card p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">{item.unit.text}</pre>}
                </TabsContent>
                {outcome && (
                    <>
                        <TabsContent value="compare" className="m-0"><CompareView original={outcome.original} converted={outcome.sql} /></TabsContent>
                        <TabsContent value="changes" className="m-0"><ChangesPanel outcome={outcome} /></TabsContent>
                        <TabsContent value="checks" className="m-0"><ChecksPanel outcome={outcome} hasTables={false} /></TabsContent>
                    </>
                )}
            </Tabs>
        </div>
    );
};

/** The summary, the filters and one row per statement. Selecting a row opens its details under it. */
export const Results: React.FC<{ batch: Batch; onOpenSingle: (sql: string) => void; onOpenEditor: (sql: string) => void }> = ({ batch, onOpenSingle, onOpenEditor }) => {
    const { result } = batch;
    const [shown, setShown] = useState(PAGE);
    const rows = useMemo(() => batch.visible.slice(0, shown), [batch.visible, shown]);
    if (!result) return null;
    const { summary } = result;
    const queries = summary.queries;
    const notFailed = queries - summary.byStatus.failed;

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5">
            <div className="space-y-1">
                <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter by status">
                    <button type="button" onClick={() => batch.setFilter("all")} aria-pressed={batch.filter === "all"} className={cn("shrink-0 rounded-md border px-2.5 py-1 text-xs hover:bg-accent", batch.filter === "all" && "bg-accent font-medium")}>
                        All <span className="ml-1 tabular-nums text-muted-foreground">{summary.units}</span>
                    </button>
                    {BATCH_STATUSES.map((status) => (
                        <button key={status} type="button" disabled={batch.counts[status] === 0} onClick={() => batch.setFilter(status)} aria-pressed={batch.filter === status} className={cn("shrink-0 rounded-md border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent", batch.filter === status && "bg-accent font-medium")}>
                            {STATUS_LABELS[status]} <span className="ml-1 tabular-nums text-muted-foreground">{batch.counts[status]}</span>
                        </button>
                    ))}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {result.connectionName ? `Checked against ${result.connectionName}: ${summary.verification.database} of ${notFailed} statements that did not fail were accepted by PostgreSQL${summary.verification.syntax > 0 ? `, ${summary.verification.syntax} only parsed` : ""}.` : "No connection chosen: statements were only parsed by a PostgreSQL grammar, which does not check names or types."}{" "}
                    {summary.namesUnresolved > 0 && `${summary.namesUnresolved} could not be checked because this connection lacks a table or column they use. `}
                    {summary.repeated > 0 && `${summary.repeated} repeat an earlier statement. `}
                    {summary.convertedByModel > 0 && `${summary.convertedByModel} converted by the model. `}
                    {(result.elapsedMs / 1000).toFixed(1)} s.
                    {result.aborted && ` Stopped early: ${result.skipped} statements were not converted.`}
                </p>
                {result.warnings.map((warning) => (
                    <p key={warning} className="text-[11px] text-amber-700 dark:text-amber-400">{warning}</p>
                ))}
            </div>

            <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={batch.search} onChange={(event) => { batch.setSearch(event.target.value); setShown(PAGE); }} placeholder="Search statements and reasons…" className="h-8 bg-secondary pl-7 dark:bg-background" aria-label="Search the statements" />
            </div>

            <ul className="min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border bg-card">
                {rows.length === 0 && <li className="p-4 text-center text-xs text-muted-foreground">No statement matches.</li>}
                {rows.map((item) => {
                    const open = batch.selected === item.unit.index;
                    return (
                        <li key={item.unit.index}>
                            <button type="button" onClick={() => batch.setSelected(open ? undefined : item.unit.index)} aria-expanded={open} className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-accent/50">
                                <span className="mt-0.5 shrink-0 text-muted-foreground">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</span>
                                <span className="w-12 shrink-0 text-[11px] tabular-nums text-muted-foreground">{item.unit.startLine === item.unit.endLine ? item.unit.startLine : `${item.unit.startLine}-${item.unit.endLine}`}</span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate font-mono text-[11px]">{preview(item.unit.text)}</span>
                                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{item.reasons[0]}</span>
                                </span>
                                <StatusBadge status={item.status} />
                            </button>
                            {open && <Detail item={item} onOpenSingle={onOpenSingle} onOpenEditor={onOpenEditor} />}
                        </li>
                    );
                })}
                {batch.visible.length > shown && (
                    <li className="p-2 text-center">
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShown((count) => count + PAGE)}>
                            Show {Math.min(PAGE, batch.visible.length - shown)} more of {(batch.visible.length - shown).toLocaleString()}
                        </Button>
                    </li>
                )}
            </ul>
        </div>
    );
};
