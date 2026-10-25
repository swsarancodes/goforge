import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, Info, Loader2, Play, Square, XCircle } from "lucide-react";
import { Link } from "react-router-dom";
import Clipboard from "@/components/clipboard";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { fetchAuditEntry, type AuditEntry, type PlanResponse, type Risk, type RunbookStep } from "@/lib/schema-change-api";
import { formatBytes, formatCount } from "../format";
import type { SchemaChange } from "../use-schema-change";
import { RiskBadge } from "./risk-badge";
import { RunPanel } from "./run-panel";

export { RiskBadge };

const PlanSkeleton: React.FC<{ stage: string }> = ({ stage }) => (
    <div role="status" aria-busy="true" className="space-y-3">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> {stage}…
        </p>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2 rounded-lg border p-3">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
            </div>
        ))}
    </div>
);

const StepCard: React.FC<{ step: RunbookStep; total: number }> = ({ step, total }) => (
    <li className={cn("rounded-lg border bg-card", step.optional && "border-dashed")}>
        <details className="group">
            <summary className="flex cursor-pointer list-none items-start gap-2 p-2.5">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{step.id}</span>
                <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium leading-5 break-words">{step.title}</span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        {step.lock === "none" ? "no lock on existing objects" : step.lock.toLowerCase()} · {step.work}
                        {step.table && step.tableBytes !== null ? ` · ${formatBytes(step.tableBytes)}` : ""}
                        {step.optional ? " · not run by default" : ""}
                    </span>
                </span>
                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                    {step.destructive && <Badge variant="outline" className="border-destructive text-[10px] text-destructive">destructive</Badge>}
                    {step.breaksClients && <Badge variant="outline" className="text-[10px]">breaks callers</Badge>}
                    <RiskBadge risk={step.risk} />
                </span>
            </summary>
            <div className="space-y-2 border-t p-2.5 text-xs">
                <p className="text-muted-foreground">{step.reason}</p>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words">{step.optional ? step.sql.split("\n").map((line) => `-- ${line}`).join("\n") : step.sql}</pre>
                {step.alsoLocks.length > 0 && <p className="text-muted-foreground">Also locks {step.alsoLocks.join(", ")}.</p>}
                {step.notes.length > 0 && (
                    <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                        {step.notes.map((note, index) => (
                            <li key={index} className="break-words">{note}</li>
                        ))}
                    </ul>
                )}
                {step.undo && (
                    <div>
                        <p className="mb-1 text-muted-foreground">To undo:</p>
                        <pre className="overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words">{step.undo}</pre>
                    </div>
                )}
                <p className="text-[11px] text-muted-foreground">Step {step.id} of {total}</p>
            </div>
        </details>
    </li>
);

const SentToModel: React.FC<{ auditIds: number[]; redacted: boolean }> = ({ auditIds, redacted }) => {
    const [open, setOpen] = useState(false);
    const [entries, setEntries] = useState<AuditEntry[] | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    useEffect(() => {
        if (!open || entries) return;
        Promise.all(auditIds.map((id) => fetchAuditEntry(id)))
            .then(setEntries)
            .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [open, entries, auditIds]);

    return (
        <details onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)} className="rounded-lg border bg-card">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium">What was sent to the model</summary>
            <div className="space-y-2 border-t p-3 text-xs">
                <p className="text-muted-foreground">
                    Exactly this left the server{redacted ? ", with names replaced by placeholders" : ""}: table definitions, sizes and counts, and your request. No rows and no credentials.
                </p>
                {error && <p className="text-destructive">{error}</p>}
                {!entries && !error && <Skeleton className="h-20 w-full" />}
                {entries?.map((entry, index) => {
                    const sent = entry.payload ? (JSON.parse(entry.payload) as { instructions: string; input: string }) : undefined;
                    return (
                        <div key={entry.id} className="space-y-1">
                            <p className="font-medium">Request {index + 1} · {entry.model} · {formatCount(entry.requestChars ?? 0)} characters</p>
                            <pre className="max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all">{sent ? `${sent.instructions}\n\n${sent.input}` : "(not stored)"}</pre>
                        </div>
                    );
                })}
            </div>
        </details>
    );
};

const OperationList: React.FC<{ response: PlanResponse }> = ({ response }) => {
    const refused = new Set(response.runbook?.uncompiled ?? []);
    return (
        <ol className="space-y-1">
            {response.plan.operations.map((operation, index) => (
                <li key={index} className="flex items-start gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{index + 1}</span>
                    <code className="min-w-0 flex-1 break-all font-mono text-[11px] leading-5">{describeOperation(operation)}</code>
                    {response.runbook && <Badge variant="outline" className={cn("shrink-0 text-[10px]", refused.has(index) && "border-destructive text-destructive")}>{refused.has(index) ? "not compiled" : "compiled"}</Badge>}
                </li>
            ))}
        </ol>
    );
};

function describeOperation(operation: PlanResponse["plan"]["operations"][number]): string {
    const get = (key: string) => String(operation[key] ?? "");
    switch (operation.type) {
        case "create_table":
            return `create table ${(operation.table as { name: string }).name}`;
        case "rename_table":
            return `rename ${get("tableName")} to ${get("newName")}`;
        case "drop_table":
            return `drop table ${get("tableName")}`;
        case "add_column":
            return `add ${get("tableName")}.${(operation.field as { name: string }).name}`;
        case "alter_column":
            return `change ${get("tableName")}.${get("columnName")}: ${Object.keys(operation.changes as object).join(", ")}`;
        case "drop_column":
            return `drop ${get("tableName")}.${get("columnName")}`;
        case "add_relationship": {
            const r = operation.relationship as Record<string, string>;
            return `foreign key ${r.targetTable}.${r.targetColumn} → ${r.sourceTable}.${r.sourceColumn}`;
        }
        case "drop_relationship":
            return `drop foreign key ${get("targetTable")}.${get("targetColumn")} → ${get("sourceTable")}.${get("sourceColumn")}`;
        case "add_index":
            return `index ${(operation.index as { name: string }).name} on ${get("tableName")} (${((operation.index as { columns: string[] }).columns ?? []).join(", ")})`;
        case "drop_index":
            return `drop index ${get("indexName")} on ${get("tableName")}`;
        case "add_unique":
            return `unique${operation.constraintName ? ` ${get("constraintName")}` : ""} on ${get("tableName")} (${((operation.columns as string[]) ?? []).join(", ")})`;
        case "add_check":
            return `check${operation.constraintName ? ` ${get("constraintName")}` : ""} on ${get("tableName")}: ${get("expression")}`;
        case "drop_constraint":
            return `drop constraint ${get("constraintName")} on ${get("tableName")}`;
        default:
            return String(operation.type);
    }
}

const PlanResult: React.FC<{ state: SchemaChange; response: PlanResponse }> = ({ state, response }) => {
    const [acknowledged, setAcknowledged] = useState(false);
    useEffect(() => setAcknowledged(false), [response]);
    const runbook = response.runbook;
    const errors = response.findings.filter((finding) => finding.severity === "error");
    const others = response.findings.filter((finding) => finding.severity !== "error");
    const destructive = runbook?.steps.filter((step) => step.destructive && !step.optional) ?? [];
    const runnable = runbook?.steps.some((step) => !step.optional) ?? false;
    const canOpen = runnable && (destructive.length === 0 || acknowledged);
    const totalTokens = response.usage.inputTokens !== null ? `${formatCount(response.usage.inputTokens)} in / ${formatCount(response.usage.outputTokens ?? 0)} out tokens (reported by the endpoint)` : `${formatCount(response.requestChars)} characters sent (about ${formatCount(response.requestChars / 4)} tokens, estimated)`;

    return (
        <div className="space-y-3">
            <div className="space-y-1">
                <p className="text-sm font-medium break-words">{response.plan.summary}</p>
                <p className="text-[11px] text-muted-foreground">
                    {response.model} · {response.attempts === 1 ? "1 request" : `${response.attempts} requests`} · {(response.modelLatencyMs / 1000).toFixed(1)} s · {totalTokens}
                    {response.redacted ? " · names redacted" : ""} · {response.scope.length - response.expandedTables.length} existing table{response.scope.length - response.expandedTables.length === 1 ? "" : "s"} sent in full, {formatCount(response.omittedTables)} not
                    {response.expandedTables.length > 0 ? ` · also read to check the plan: ${response.expandedTables.join(", ")}` : ""}
                </p>
            </div>

            {response.plan.clarifyingQuestions.length > 0 && (
                <Alert className="px-3 py-2.5">
                    <Info />
                    <AlertTitle className="text-xs">The model needs a few details first</AlertTitle>
                    <AlertDescription className="text-xs">
                        <ol className="list-decimal space-y-1 pl-4">
                            {response.plan.clarifyingQuestions.map((question) => <li key={question}>{question}</li>)}
                        </ol>
                        <p className="mt-2">Add the answers to your request and plan again.</p>
                    </AlertDescription>
                </Alert>
            )}

            {errors.length > 0 && (
                <Alert variant="destructive" className="px-3 py-2.5">
                    <XCircle />
                    <AlertTitle className="text-xs">{errors.length} thing{errors.length === 1 ? "" : "s"} the checks against your database refused</AlertTitle>
                    <AlertDescription className="text-xs">
                        <ul className="list-disc space-y-1 pl-4">
                            {errors.map((finding, index) => <li key={index} className="break-words">{finding.operation !== undefined ? `Change ${finding.operation + 1}: ` : ""}{finding.message}</li>)}
                        </ul>
                    </AlertDescription>
                </Alert>
            )}

            {response.plan.operations.length > 0 && (
                <section className="space-y-1.5">
                    <h3 className="text-xs font-semibold">Changes proposed ({response.plan.operations.length})</h3>
                    <OperationList response={response} />
                </section>
            )}

            {(others.length > 0 || response.plan.assumptions.length > 0 || response.plan.warnings.length > 0) && (
                <Alert className="px-3 py-2.5">
                    <AlertTriangle />
                    <AlertTitle className="text-xs">Review notes</AlertTitle>
                    <AlertDescription className="text-xs">
                        <ul className="list-disc space-y-1 pl-4">
                            {others.map((finding, index) => <li key={`f${index}`} className="break-words">{finding.message}</li>)}
                            {response.plan.warnings.map((warning) => <li key={warning} className="break-words">{warning} <span className="text-muted-foreground">(from the model)</span></li>)}
                            {response.plan.assumptions.map((assumption) => <li key={assumption} className="break-words">{assumption} <span className="text-muted-foreground">(assumed by the model)</span></li>)}
                        </ul>
                    </AlertDescription>
                </Alert>
            )}

            {runbook && runbook.steps.length > 0 && (
                <section className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-xs font-semibold">Runbook ({runbook.steps.length} steps)</h3>
                        {response.summary && (
                            <p className="text-[11px] text-muted-foreground">
                                {response.summary.byRisk.high} high · {response.summary.byRisk.medium} medium · {response.summary.byRisk.low} low risk
                                {response.summary.rewrites > 0 ? ` · ${response.summary.rewrites} rewrite${response.summary.rewrites === 1 ? "" : "s"}` : " · no table rewrites"}
                            </p>
                        )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                        Risk follows from the lock a step takes, the work it does and how much data the table holds ({runbook.server.version}, read {new Date(runbook.server.collectedAt).toLocaleTimeString()}). It is not a prediction of how long a step takes.
                    </p>
                    <ol className="space-y-1.5">
                        {runbook.steps.map((step) => <StepCard key={step.id} step={step} total={runbook.steps.length} />)}
                    </ol>
                </section>
            )}

            {response.lint && (
                <p className={cn("text-xs", response.lint.violations.length > 0 ? "text-destructive" : "text-muted-foreground")}>
                    {response.lint.violations.length === 0
                        ? `Checked ${response.lint.statements} statements for the usual ways of locking a large table (non-concurrent indexes, unvalidated constraints, whole-table updates, missing lock timeouts): none found.`
                        : `${response.lint.violations.length} statement(s) break a rule: ${response.lint.violations.slice(0, 3).map((violation) => `step ${violation.step}: ${violation.message}`).join(" ")}`}
                </p>
            )}

            {runbook && runnable && (
                <div className="space-y-2 rounded-lg border bg-card p-3">
                    {destructive.length > 0 && (
                        <label className="flex cursor-pointer items-start gap-2 text-xs">
                            <input type="checkbox" className="mt-0.5 size-4 accent-destructive" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                            <span><strong className="block">I reviewed the destructive steps</strong>{destructive.map((step) => step.title).join("; ")}. They cannot be undone by another statement.</span>
                        </label>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" className="gap-1.5" disabled={!canOpen} onClick={() => state.openRunbook(runbook.script, response)}>
                            <ArrowUpRight className="size-3.5" /> Open runbook in SQL Editor
                        </Button>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <Clipboard text={runbook.script} /> Copy the script
                        </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">Nothing is run for you. The SQL Editor opens with each statement set to run on its own, and you run it there, one step at a time if you prefer.</p>
                </div>
            )}

            {runbook && runnable && state.connectionId && <RunPanel connectionId={state.connectionId} response={response} allowed={canOpen} />}

            <SentToModel auditIds={response.auditIds} redacted={response.redacted} />
        </div>
    );
};

export const PlanPanel: React.FC<{ state: SchemaChange }> = ({ state }) => {
    const running = state.plan.status === "running";
    const ai = state.aiStatus;
    const aiBlocked = ai !== undefined && !ai.configured;
    const scopeNote = state.scope
        ? `${state.selected.length} table${state.selected.length === 1 ? "" : "s"} in scope of ${state.scope.totalTables.toLocaleString()}${state.scope.truncated ? ` · ${state.scope.matched} matched, the best ${state.scope.tables.filter((t) => t.origin === "match").length} kept` : ""}`
        : state.selected.length > 0
          ? `${state.selected.length} table${state.selected.length === 1 ? "" : "s"} chosen by hand`
          : "No tables chosen (optional)";

    return (
        <div className="space-y-3 p-3">
            <div className="space-y-2">
                <label htmlFor="schema-change-request" className="text-sm font-medium">Describe the change</label>
                <Textarea
                    id="schema-change-request"
                    value={state.prompt}
                    onChange={(event) => state.setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void state.generate();
                    }}
                    placeholder="Describe the change in your own words. For example: add a testimonials table with an author, a quote and a rating, linked to customers."
                    className="min-h-28 resize-y bg-secondary dark:bg-background"
                    disabled={running}
                />
                <p className="text-[11px] text-muted-foreground">You do not have to choose tables. The ones your request names are found by matching its words with table, schema and column names and following foreign keys (names, not meanings), and a request for new tables needs none. Tick tables on the left to make sure they are included.</p>
                <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => void state.findTables()} disabled={!state.connectionId || !state.prompt.trim() || state.finding || running}>
                        {state.finding ? <Loader2 className="size-3.5 animate-spin" /> : null} Find tables
                    </Button>
                    {running ? (
                        <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={state.stop}>
                            <Square className="size-3" /> Stop
                        </Button>
                    ) : (
                        <Button size="sm" className="h-8 gap-1.5" onClick={() => void state.generate()} disabled={!state.connectionId || !state.prompt.trim() || aiBlocked} title="Plan the change (Ctrl or ⌘ + Enter)">
                            <Play className="size-3.5" /> Plan the change
                        </Button>
                    )}
                    <span className="text-xs text-muted-foreground">{scopeNote}</span>
                </div>
            </div>

            {aiBlocked && (
                <Alert className="px-3 py-2.5">
                    <AlertTriangle />
                    <AlertTitle className="text-xs">No model can be used yet</AlertTitle>
                    <AlertDescription className="text-xs">
                        <p>
                            {ai?.problem ?? "OpenAI is not set up."}{" "}
                            <button type="button" className="underline underline-offset-2" onClick={() => state.setTab("governance")}>Open the AI settings.</button>
                        </p>
                        <p>Finding tables, the health report and the audit log still work.</p>
                    </AlertDescription>
                </Alert>
            )}

            {state.plan.status === "running" && <PlanSkeleton stage={state.plan.stage} />}
            {state.plan.status === "failed" && (
                <Alert variant="destructive" className="px-3 py-2.5">
                    <AlertTriangle />
                    <AlertTitle className="text-xs">{state.plan.blocked ? "Blocked by the workspace's AI policy" : "Could not plan this change"}</AlertTitle>
                    <AlertDescription className="break-words text-xs">
                        <p>
                            {state.plan.message}
                            {state.plan.blocked && <> <button type="button" className="underline underline-offset-2" onClick={() => state.setTab("governance")}>Open the AI settings.</button></>}
                        </p>
                    </AlertDescription>
                </Alert>
            )}
            {state.plan.status === "done" && <PlanResult state={state} response={state.plan.response} />}
            {state.plan.status === "idle" && !aiBlocked && (
                <div className="space-y-2 rounded-lg border bg-muted/20 p-4 text-xs text-muted-foreground">
                    <p className="font-medium text-foreground">What happens when you plan</p>
                    <ol className="list-decimal space-y-1.5 pl-4 leading-relaxed">
                        <li>The tables your request is about, if any, are read: columns, keys, indexes and how often each index was used, row estimates and sizes. No rows. The model is also told the names of the other tables, so a new table can point at one.</li>
                        <li>A model proposes the changes, including new tables. It never writes SQL.</li>
                        <li>Fixed rules check every change against the real catalog and write the SQL with its locks, size and risk stated: <code>CONCURRENTLY</code>, <code>NOT VALID</code> then validate, batched updates, a lock timeout.</li>
                        <li>You open the runbook in the SQL Editor. <Link to="/database/ai-schema" className="underline underline-offset-2">Designing tables on the diagram instead?</Link></li>
                    </ol>
                </div>
            )}
        </div>
    );
};
