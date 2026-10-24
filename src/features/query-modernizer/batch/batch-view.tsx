import React, { useRef, useState } from "react";
import { Download, FileText, Loader2, Play, Square, Upload, X } from "lucide-react";
import CodeEditor from "@/components/code-editor";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useOpenInSqlEditor } from "@/features/sql-editor/use-open-in-sql-editor";
import { UNIT_KIND_LABELS, UnitKind } from "../engine/script";
import { LEGACY_DIALECTS, LegacyDialect } from "../types";
import { Results } from "./results";
import { EDITOR_LIMIT, MAX_FILE_BYTES, useBatch } from "./use-batch";

const NO_CONNECTION = "__none__";

const formatSize = (characters: number): string => (characters >= 1_000_000 ? `${(characters / 1_000_000).toFixed(1)} MB` : characters >= 1000 ? `${Math.round(characters / 1000)} KB` : `${characters} bytes`);

const Skeletons: React.FC<{ done: number; total: number }> = ({ done, total }) => (
    <div role="status" aria-busy="true" className="space-y-2">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Converted {done.toLocaleString()} of {total.toLocaleString()} statements…
        </p>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="h-full bg-foreground/60 transition-[width]" style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }} />
        </div>
        {[0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className="flex items-center gap-2 rounded-lg border p-2.5">
                <Skeleton className="h-3 w-8" />
                <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-2.5 w-1/2" />
                </div>
                <Skeleton className="h-5 w-16" />
            </div>
        ))}
    </div>
);

const EmptyState: React.FC = () => (
    <div className="flex h-full flex-col justify-center gap-3 p-4 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">What happens when you convert a script</p>
        <ol className="list-decimal space-y-2 pl-5 text-xs leading-relaxed">
            <li>The file is split into statements the way its own tool ran them: <code>;</code>, a lone <code>/</code> line, <code>GO</code> batches, <code>DELIMITER</code>.</li>
            <li>Every query goes through the same rules as in the one-query view. With a connection chosen, PostgreSQL itself says whether it accepts each result. The model is only asked about what the rules cannot finish, for as many different statements as the limit allows.</li>
            <li>Each statement gets one status and the facts behind it. Procedures, packages, schema statements and client commands are listed as out of scope: they are not converted and not counted as failures.</li>
            <li>You can download the converted file (what did not convert stays as a comment, never dropped), a Markdown report and a CSV.</li>
        </ol>
        <p className="text-xs leading-relaxed">A status says what was checked, not how likely the new statement is to be right. Run old and new on the same data and compare the results.</p>
    </div>
);

/** Convert a whole legacy SQL file: statements in, one status per statement out. */
export const ScriptView: React.FC<{ onOpenSingle: (sql: string, dialect: LegacyDialect) => void }> = ({ onOpenSingle }) => {
    const batch = useBatch();
    const openInSqlEditor = useOpenInSqlEditor();
    const input = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);
    const dialectLabel = LEGACY_DIALECTS.find((option) => option.value === batch.dialect)?.label ?? batch.dialect;
    const large = batch.script.length > EDITOR_LIMIT;
    const total = batch.found?.units.length ?? 0;

    const pick = (files: FileList | null) => {
        const file = files?.[0];
        if (file) void batch.loadFile(file);
    };

    const kinds = (batch.found ? (Object.entries(batch.found.byKind) as [UnitKind, number][]) : []).filter(([, count]) => count > 0);

    return (
        <div className="h-full min-h-0 w-full overflow-y-auto bg-background">
            <div className="flex flex-col gap-3 p-4 lg:h-full lg:min-h-0">
                <p className="max-w-3xl text-sm text-muted-foreground">
                    Converts every query in a legacy SQL file to PostgreSQL and says, statement by statement, what converted, what needs a person, and what could not be converted. It does not prove the new queries return the same rows.
                </p>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-2.5">
                    <div className="flex items-center gap-2">
                        <Select value={batch.dialect} onValueChange={(value) => batch.setDialect(value as LegacyDialect)}>
                            <SelectTrigger size="sm" className="h-8 w-44 text-xs" aria-label="Convert from">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {LEGACY_DIALECTS.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <span className="text-xs text-muted-foreground">to PostgreSQL</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            Check against
                            <Select value={batch.connection?.id ?? NO_CONNECTION} onValueChange={(value) => batch.changeConnection(value === NO_CONNECTION ? undefined : value)}>
                                <SelectTrigger size="sm" className="h-8 w-48 text-xs" aria-label="Check against">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NO_CONNECTION}>No database (syntax only)</SelectItem>
                                    {batch.connections.map((connection) => (
                                        <SelectItem key={connection.id} value={connection.id}>{connection.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground" title={batch.aiConfigured ? `Let ${batch.aiStatus?.model || "the model"} try what the rules cannot finish` : (batch.aiStatus?.problem ?? "Set OPENAI_API_KEY in server/.env to turn this on (Schema Change → AI settings has the model)")}>
                            <Switch id="batch-ai" checked={batch.useAi && batch.aiConfigured} onCheckedChange={batch.changeUseAi} disabled={!batch.aiConfigured || batch.running} aria-label="Use AI for what the rules cannot convert" />
                            <label htmlFor="batch-ai">Use AI for the rest, for at most</label>
                            <input type="number" min={0} max={500} value={batch.aiLimit} onChange={(event) => batch.changeAiLimit(Number(event.target.value))} disabled={!batch.aiConfigured || !batch.useAi || batch.running} aria-label="Most statements sent to the model" className="h-7 w-14 rounded-md border bg-secondary px-1.5 text-xs tabular-nums disabled:opacity-50 dark:bg-background" />
                            <span>statements</span>
                        </div>
                        {batch.hasSchema && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Switch id="batch-schema" checked={batch.useSchema} onCheckedChange={batch.setUseSchema} disabled={batch.running} aria-label="Use the tables of the open project" />
                                <label htmlFor="batch-schema" title="Column types from the open project let rules such as TRUNC pick the right replacement">Use the open project&apos;s tables</label>
                            </div>
                        )}
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                    <section
                        className={cn("flex min-h-[320px] flex-col overflow-hidden rounded-lg border bg-card lg:min-h-0", dragging && "ring-2 ring-foreground/30")}
                        onDragOver={(event) => {
                            event.preventDefault();
                            setDragging(true);
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={(event) => {
                            event.preventDefault();
                            setDragging(false);
                            pick(event.dataTransfer.files);
                        }}
                        aria-label="The script"
                    >
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                            <div className="flex min-w-0 items-center gap-2">
                                <h2 className="text-sm font-medium">Script</h2>
                                {batch.fileName && (
                                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                                        <FileText className="size-3 shrink-0" />
                                        <span className="truncate">{batch.fileName}</span>
                                    </span>
                                )}
                                {batch.script && <span className="shrink-0 text-xs text-muted-foreground">{formatSize(batch.script.length)}</span>}
                            </div>
                            <div className="flex items-center gap-1.5">
                                <input ref={input} type="file" accept=".sql,.txt,.ddl,.pls,.pks,.pkb,.prc,.fnc,text/plain" className="sr-only" onChange={(event) => { pick(event.target.files); event.target.value = ""; }} aria-label="Choose a SQL file" tabIndex={-1} />
                                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => input.current?.click()} disabled={batch.running}>
                                    <Upload className="size-3.5" /> Choose a file
                                </Button>
                                {batch.script && (
                                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={batch.clear} disabled={batch.running} aria-label="Clear the script" title="Clear the script">
                                        <X className="size-3.5" />
                                    </Button>
                                )}
                                {batch.running ? (
                                    <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={batch.stop}>
                                        <Square className="size-3" /> Stop
                                    </Button>
                                ) : (
                                    <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void batch.run()} disabled={!batch.script.trim()} title="Convert the script">
                                        <Play className="size-3.5" /> Convert
                                    </Button>
                                )}
                            </div>
                        </div>
                        {batch.useAi && batch.aiConfigured && batch.aiLimit > 0 && <p className="border-b bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">If the rules cannot finish a statement, it (and the names of your project&apos;s tables and columns, if used) is sent to the model, for at most {batch.aiLimit} different statements. No data is.</p>}
                        <div className="min-h-0 flex-1 p-1">
                            {large ? (
                                <div className="flex h-full flex-col items-start justify-center gap-2 p-4 text-xs text-muted-foreground">
                                    <p className="font-medium text-foreground">{batch.fileName ?? "The script"} is loaded ({formatSize(batch.script.length)}).</p>
                                    <p>It is not shown in an editor, which would slow this page down. The statements are in the results once it is converted.</p>
                                    <p>Files up to {MAX_FILE_BYTES / 1_000_000} MB are accepted; the conversion runs in this browser tab.</p>
                                </div>
                            ) : (
                                <CodeEditor value={batch.script} onChange={batch.setScript} onRun={() => void batch.run()} placeholder={`Paste a ${dialectLabel} script here, or drop a .sql file on this box.`} className="h-full min-h-[240px] font-mono text-xs" />
                            )}
                        </div>
                        {batch.found && (
                            <div className="space-y-0.5 border-t px-3 py-2 text-[11px] text-muted-foreground">
                                <p>
                                    {total.toLocaleString()} statement{total === 1 ? "" : "s"} found{kinds.length > 0 ? `: ${kinds.map(([kind, count]) => `${count.toLocaleString()} ${kind === "query" ? (count === 1 ? "query" : "queries") : UNIT_KIND_LABELS[kind].split(",")[0].split(" (")[0]}`).join(", ")}` : ""}.
                                </p>
                                {batch.found.warnings.slice(0, 3).map((warning) => (
                                    <p key={warning} className="text-amber-700 dark:text-amber-400">{warning}</p>
                                ))}
                            </div>
                        )}
                    </section>

                    <section className="flex min-h-[320px] flex-col overflow-hidden rounded-lg border bg-card lg:min-h-0" aria-label="Results">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                            <h2 className="text-sm font-medium">Results</h2>
                            <div className="flex flex-wrap items-center gap-1.5">
                                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={batch.exportScript} disabled={!batch.result || batch.running} title="The converted file. What did not convert stays in it as a comment with the reason.">
                                    <Download className="size-3.5" /> Converted .sql
                                </Button>
                                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={batch.exportReport} disabled={!batch.result || batch.running} title="A Markdown report for a review meeting">
                                    <Download className="size-3.5" /> Report
                                </Button>
                                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={batch.exportCsv} disabled={!batch.result || batch.running} title="One row per statement, for a spreadsheet">
                                    <Download className="size-3.5" /> CSV
                                </Button>
                            </div>
                        </div>
                        {batch.result && !batch.running && (
                            <label className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground" htmlFor="batch-review-comment">
                                <Switch id="batch-review-comment" checked={!batch.reviewAsSql} onCheckedChange={(value) => batch.setReviewAsSql(!value)} aria-label="Keep statements that need review as comments in the converted file" />
                                Keep statements that need review as comments in the converted file
                            </label>
                        )}
                        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2.5">
                            {batch.running ? <Skeletons done={batch.progress.done} total={batch.progress.total} /> : batch.result ? <Results batch={batch} onOpenSingle={(sql) => onOpenSingle(sql, batch.dialect)} onOpenEditor={(sql) => openInSqlEditor(sql, "Modernizer (script)")} /> : <EmptyState />}
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
};
