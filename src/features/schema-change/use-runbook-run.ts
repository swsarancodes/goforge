import { useCallback, useEffect, useRef, useState } from "react";
import { cancelSql, closeSqlSession, runSql, type SqlRunError } from "@/lib/sql-editor-api";
import type { RunbookStep } from "@/lib/schema-change-api";

export type StepStatus = "pending" | "running" | "done" | "failed" | "undone";

export interface StepRun {
    status: StepStatus;
    elapsedMs?: number;
    /** The statement count and the rows it reported, for a step that finished. */
    summary?: string;
    error?: { message: string; code?: string; detail?: string; hint?: string };
}

const newSessionId = () => `schema-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const describeError = (error: unknown): StepRun["error"] => (error instanceof Error ? { message: error.message } : { message: String(error) });
const fromSql = (error: SqlRunError): StepRun["error"] => ({ message: error.message, code: error.code, detail: error.detail, hint: error.hint });

/**
 * Runs a runbook one step at a time, each on its own (no transaction: CREATE INDEX CONCURRENTLY and the batched backfills need that),
 * in a SQL session of its own on the chosen connection. Only the next step can be run, a failed step stops everything after it, and the
 * most recent finished step can be undone with the statement the compiler wrote for it.
 */
export function useRunbookRun(connectionId: string | undefined, steps: RunbookStep[], resetKey: unknown) {
    const runnable = steps.filter((step) => !step.optional);
    const [runs, setRuns] = useState<Record<number, StepRun>>({});
    const sessionId = useRef<string>(newSessionId());
    const busy = useRef(false);

    const closeSession = useCallback(() => {
        if (connectionId) void closeSqlSession(connectionId, sessionId.current).catch(() => undefined);
    }, [connectionId]);

    // A new plan starts a clean run in a new session; leaving the page closes the session (its connection goes back to the pool).
    useEffect(() => {
        setRuns({});
        sessionId.current = newSessionId();
        return closeSession;
    }, [resetKey, closeSession]);

    const status = (id: number): StepStatus => runs[id]?.status ?? "pending";
    const running = runnable.find((step) => status(step.id) === "running");
    const next = runnable.find((step) => status(step.id) !== "done");
    const finished = runnable.filter((step) => status(step.id) === "done");
    const lastDone = finished.length > 0 ? finished[finished.length - 1] : undefined;

    const execute = useCallback(
        async (step: RunbookStep, sql: string, onDone: StepStatus) => {
            if (!connectionId || busy.current) return;
            busy.current = true;
            setRuns((previous) => ({ ...previous, [step.id]: { status: "running" } }));
            try {
                const response = await runSql(connectionId, { sessionId: sessionId.current, sql, transactional: false, expectOpenTransaction: false });
                if (response.ok) {
                    const rows = response.results.map((result) => (result.rowCount !== null ? `${result.command} ${result.rowCount}` : result.command));
                    setRuns((previous) => ({ ...previous, [step.id]: { status: onDone, elapsedMs: response.elapsedMs, summary: `${response.results.length} statement${response.results.length === 1 ? "" : "s"}${rows.length ? `: ${rows.slice(0, 4).join(", ")}${rows.length > 4 ? ", …" : ""}` : ""}` } }));
                } else {
                    setRuns((previous) => ({ ...previous, [step.id]: { status: "failed", elapsedMs: response.elapsedMs, error: fromSql(response.error) } }));
                }
            } catch (error) {
                setRuns((previous) => ({ ...previous, [step.id]: { status: "failed", error: describeError(error) } }));
            } finally {
                busy.current = false;
            }
        },
        [connectionId],
    );

    const run = useCallback((step: RunbookStep) => execute(step, step.sql, "done"), [execute]);
    const undo = useCallback((step: RunbookStep) => (step.undo ? execute(step, step.undo, "undone") : Promise.resolve()), [execute]);
    const stop = useCallback(() => {
        if (connectionId) void cancelSql(connectionId, sessionId.current).catch(() => undefined);
    }, [connectionId]);

    return { runs, status, runnable, next, running, lastDone, run, undo, stop, allDone: runnable.length > 0 && runnable.every((step) => status(step.id) === "done") };
}
