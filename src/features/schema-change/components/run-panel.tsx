import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fetchPreflight, verifyRun, type PlanResponse, type PreflightReport, type PreflightStatus, type VerifyResult } from "@/lib/schema-change-api";
import { useRunbookRun, type StepRun } from "../use-runbook-run";
import { RiskBadge } from "./risk-badge";

const STATUS_STYLE: Record<PreflightStatus, string> = {
    ok: "border-border text-muted-foreground",
    warn: "border-foreground/40 text-foreground",
    block: "border-destructive bg-destructive/10 text-destructive",
    unknown: "border-dashed text-muted-foreground",
};
const STATUS_LABEL: Record<PreflightStatus, string> = { ok: "ok", warn: "look at this", block: "blocked", unknown: "can't tell" };

const Preflight: React.FC<{ connectionId: string; tables: string[]; report: PreflightReport | undefined; onReport: (report: PreflightReport | undefined) => void }> = ({ connectionId, tables, report, onReport }) => {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const check = async () => {
        setLoading(true);
        setError(undefined);
        try {
            onReport(await fetchPreflight(connectionId, tables));
        } catch (caught) {
            onReport(undefined);
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLoading(false);
        }
    };
    return (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => void check()} disabled={loading}>
                    {loading ? <Loader2 className="size-3.5 animate-spin" /> : null} {report ? "Check again" : "Check the database first"}
                </Button>
                <span className="text-[11px] text-muted-foreground">Read-only: who is using {tables.length > 0 ? tables.join(", ") : "the database"}, replicas, replication slots, timeouts. Disk space cannot be read from a connection: make sure there is room for the largest rewrite or index build.</span>
            </div>
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            {report && (
                <ul className="space-y-1">
                    {report.checks.map((item) => (
                        <li key={item.id} className="rounded-md border bg-background px-2.5 py-1.5 text-xs">
                            <div className="flex items-start gap-2">
                                <Badge variant="outline" className={cn("mt-0.5 shrink-0 text-[10px] uppercase", STATUS_STYLE[item.status])}>{STATUS_LABEL[item.status]}</Badge>
                                <div className="min-w-0 flex-1">
                                    <p className="font-medium">{item.title}</p>
                                    <p className="break-words text-muted-foreground">{item.detail}</p>
                                    {item.items.length > 0 && (
                                        <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono text-[11px] text-muted-foreground">
                                            {item.items.map((line, index) => <li key={index} className="break-words">{line}</li>)}
                                        </ul>
                                    )}
                                </div>
                            </div>
                        </li>
                    ))}
                    <li className="px-1 text-[11px] text-muted-foreground">Checked {new Date(report.generatedAt).toLocaleTimeString()} on PostgreSQL {report.serverVersion}. It is a snapshot: look again right before you start.</li>
                </ul>
            )}
        </div>
    );
};

/** After the last step: read the catalog again and compare it with the state the compiler said it would leave. */
const Verification: React.FC<{ connectionId: string; response: PlanResponse }> = ({ connectionId, response }) => {
    const [result, setResult] = useState<VerifyResult | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [loading, setLoading] = useState(false);
    const check = async () => {
        setLoading(true);
        setError(undefined);
        try {
            setResult(await verifyRun(connectionId, response.runbook!.expected));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void check();
        // once, when the last step has run
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
        <div className="space-y-1.5 rounded-md border bg-background p-2.5 text-xs" role="status">
            <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">Does the database match the plan?</p>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void check()} disabled={loading}>
                    {loading ? <Loader2 className="size-3 animate-spin" /> : null} Check again
                </Button>
            </div>
            {error && <p role="alert" className="text-destructive">{error}</p>}
            {result && result.mismatches.length === 0 && <p className="text-muted-foreground">Yes. The catalog was read again after the run: {result.tables} table{result.tables === 1 ? "" : "s"} checked for columns, types, NOT NULL, keys, constraints and indexes, and every one is as the plan said.</p>}
            {result && result.mismatches.length > 0 && (
                <>
                    <p className="text-destructive">{result.mismatches.length} difference{result.mismatches.length === 1 ? "" : "s"} between what the plan expected and what the database has. Either a step did not do what it said, or something was not known when the plan was made.</p>
                    <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                        {result.mismatches.map((mismatch, index) => <li key={index} className="break-words"><span className="font-mono text-foreground">{mismatch.table}</span>: {mismatch.message}</li>)}
                    </ul>
                </>
            )}
        </div>
    );
};

const STATE_LABEL: Record<StepRun["status"], string> = { pending: "waiting", running: "running", done: "done", failed: "failed", undone: "undone" };

/** Runs the runbook here, one step at a time, after a look at the database. Nothing runs until Run is pressed on a step. */
export const RunPanel: React.FC<{ connectionId: string; response: PlanResponse; allowed: boolean; blockedReason?: string }> = ({ connectionId, response, allowed, blockedReason }) => {
    const runbook = response.runbook!;
    const [report, setReport] = useState<PreflightReport | undefined>(undefined);
    useEffect(() => setReport(undefined), [response, connectionId]);
    const tables = useMemo(() => [...new Set(runbook.steps.map((step) => step.table).filter((name): name is string => name !== null))], [runbook]);
    const runner = useRunbookRun(connectionId, runbook.steps, response);
    const blocked = report?.checks.some((item) => item.status === "block") ?? false;
    const ready = report !== undefined && !blocked && allowed;
    const why = !report ? "Check the database first." : blocked ? "The database check found something that blocks the change." : !allowed ? (blockedReason ?? "Review the destructive steps first.") : undefined;

    return (
        <div className="space-y-3 rounded-lg border bg-card p-3">
            <div>
                <h3 className="text-xs font-semibold">Run it here, one step at a time</h3>
                <p className="text-[11px] text-muted-foreground">Each step runs on its own, in order, and the run stops at the first one that fails. A finished step that has an undo can be undone. Nothing runs until you press Run.</p>
            </div>
            <Preflight connectionId={connectionId} tables={tables} report={report} onReport={setReport} />
            <ol className="space-y-1.5">
                {runner.runnable.map((step) => {
                    const state = runner.runs[step.id];
                    const status = runner.status(step.id);
                    const isNext = runner.next?.id === step.id;
                    return (
                        <li key={step.id} className={cn("rounded-md border bg-background p-2 text-xs", status === "failed" && "border-destructive", status === "done" && "bg-muted/30")}>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{step.id}</span>
                                <span className="min-w-0 flex-1 break-words font-medium">{step.title}</span>
                                <RiskBadge risk={step.risk} />
                                {step.destructive && <Badge variant="outline" className="border-destructive text-[10px] text-destructive">destructive</Badge>}
                                <Badge variant="outline" className={cn("text-[10px]", status === "failed" && "border-destructive text-destructive")}>{STATE_LABEL[status]}</Badge>
                            </div>
                            {state?.summary && <p className="mt-1 text-[11px] text-muted-foreground">{state.summary}{state.elapsedMs !== undefined ? ` in ${(state.elapsedMs / 1000).toFixed(1)} s` : ""}</p>}
                            {state?.error && (
                                <Alert variant="destructive" className="mt-1.5 px-2.5 py-2">
                                    <AlertTitle className="text-xs">{state.error.code ? `${state.error.code}: ` : ""}{state.error.message}</AlertTitle>
                                    {(state.error.detail || state.error.hint) && <AlertDescription className="text-xs">{[state.error.detail, state.error.hint].filter(Boolean).join(" ")}</AlertDescription>}
                                </Alert>
                            )}
                            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                {status === "running" ? (
                                    <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={runner.stop}>
                                        <Loader2 className="size-3 animate-spin" /> Stop <Square className="size-3" />
                                    </Button>
                                ) : (
                                    isNext && (
                                        <Button size="sm" className="h-7 gap-1.5 text-xs" variant={step.destructive ? "destructive" : "default"} disabled={!ready || runner.running !== undefined} title={why} onClick={() => void runner.run(step)}>
                                            <Play className="size-3" /> {status === "failed" ? "Run again" : step.destructive ? "Run destructive step" : "Run step"}
                                        </Button>
                                    )
                                )}
                                {runner.lastDone?.id === step.id && step.undo && runner.running === undefined && (
                                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void runner.undo(step)}>Undo this step</Button>
                                )}
                                {status === "failed" && <span className="text-[11px] text-muted-foreground">Nothing after this step has run. A step that fails on a lock changed nothing.</span>}
                            </div>
                        </li>
                    );
                })}
            </ol>
            {why && runner.next && <p className="text-[11px] text-muted-foreground">Run is off: {why}</p>}
            {runner.allDone && (
                <>
                    <p className="text-xs font-medium">Every step has run.{runbook.steps.some((step) => step.optional) ? " The optional clean-up steps were not run: do them once applications have switched." : ""}</p>
                    <Verification connectionId={connectionId} response={response} />
                </>
            )}
        </div>
    );
};
