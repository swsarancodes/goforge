import type { TableFacts } from "./facts.js";
import { formatBytes, formatCount } from "./sql-render.js";

/**
 * What a compiled plan looks like: an ordered list of steps, each with the SQL to run, the lock it takes, what kind of
 * work it does and a risk class that follows from those (see `riskOf`). Nothing here is a prediction of how long
 * something takes; it states how much data a step touches.
 */

export type LockMode = "ACCESS EXCLUSIVE" | "SHARE ROW EXCLUSIVE" | "SHARE" | "SHARE UPDATE EXCLUSIVE" | "ROW EXCLUSIVE" | "ROW SHARE" | "ACCESS SHARE" | "none";

/** What a step does to the table: only catalog entries, one read of the table, building an index, rewriting the table, or updating rows in batches. */
export type Work = "none" | "metadata" | "scan" | "index-build" | "rewrite" | "backfill";

export type Risk = "low" | "medium" | "high";

export type SizeClass = "new" | "small" | "medium" | "large";

/** A rule of thumb, stated in the report: under 16 MiB of table data is small, under 1 GiB medium, anything bigger large. */
export const SIZE_LIMITS = { smallBytes: 16 * 1024 * 1024, largeBytes: 1024 * 1024 * 1024 };

export function sizeClass(table: TableFacts | undefined): SizeClass {
    if (!table || table.isNew) return "new";
    const bytes = table.heapBytes;
    if (bytes < SIZE_LIMITS.smallBytes) return "small";
    return bytes < SIZE_LIMITS.largeBytes ? "medium" : "large";
}

/** The sentence under a step: how big the table is, as measured. */
export function describeSize(table: TableFacts | undefined): string {
    if (!table) return "";
    if (table.isNew) return `${table.qualified} is created by this plan.`;
    const rows = table.estimatedRows === null ? "never analyzed, row count unknown" : `about ${formatCount(table.estimatedRows)} rows`;
    return `${table.qualified}: ${formatBytes(table.heapBytes)} of data (${formatBytes(table.totalBytes)} with indexes), ${rows}.`;
}

export interface RiskInput {
    lock: LockMode;
    work: Work;
    size: SizeClass;
}

const BLOCKS_WRITES: LockMode[] = ["SHARE", "SHARE ROW EXCLUSIVE", "ACCESS EXCLUSIVE"];

/**
 * The risk class is a fixed rule on three facts: the lock, the kind of work, and the size class of the table.
 *  - metadata only: low, except an ACCESS EXCLUSIVE lock on a large table, which still has to queue behind every running transaction on it (medium)
 *  - one read of the table (or an index build) while the lock blocks writes: low when small, medium when medium, high when large
 *  - the same read under a lock that doesn't block writes (CONCURRENTLY, VALIDATE): low
 *  - rewrite: medium when small, high otherwise
 *  - batched updates: low, medium on a large table (sustained write load, replica lag, bloat)
 */
export function riskOf({ lock, work, size }: RiskInput): { risk: Risk; reason: string } {
    if (size === "new" || work === "none") return { risk: "low", reason: "Nothing running uses the objects this step touches." };

    switch (work) {
        case "metadata":
            return lock === "ACCESS EXCLUSIVE" && size === "large"
                ? { risk: "medium", reason: "Only the catalog changes, but ACCESS EXCLUSIVE has to wait for every running transaction on a large, busy table, and everything queues behind it while it waits." }
                : { risk: "low", reason: "Only the catalog changes; the lock is held for a moment." };
        case "scan":
        case "index-build":
            if (!BLOCKS_WRITES.includes(lock)) return { risk: "low", reason: `Reads the table without blocking reads or writes (${lock}).` };
            if (size === "small") return { risk: "low", reason: `Holds ${lock} while it reads a small table.` };
            return size === "medium"
                ? { risk: "medium", reason: `Holds ${lock} for the whole read of a medium-sized table; writes${lock === "ACCESS EXCLUSIVE" ? " and reads" : ""} wait.` }
                : { risk: "high", reason: `Holds ${lock} for the whole read of a large table; writes${lock === "ACCESS EXCLUSIVE" ? " and reads" : ""} wait.` };
        case "rewrite":
            return size === "small"
                ? { risk: "medium", reason: "Rewrites the table and its indexes under ACCESS EXCLUSIVE; the table is small." }
                : { risk: "high", reason: "Rewrites the whole table and every index under ACCESS EXCLUSIVE; nothing can read or write it until it finishes." };
        case "backfill":
            return size === "large"
                ? { risk: "medium", reason: "Updates every row in small committed batches: no long lock, but a sustained write load, replica lag and dead rows to vacuum." }
                : { risk: "low", reason: "Updates rows in small committed batches; no long lock." };
    }
}

export interface RunbookStep {
    /** 1-based position in the runbook. */
    id: number;
    /** Index of the plan operation this step belongs to; null for a step the compiler added on its own (pre-flight). */
    operation: number | null;
    title: string;
    /** What is run, ready for the SQL Editor in autocommit mode. For an optional step every line is a comment. */
    sql: string;
    lock: LockMode;
    /** Other tables locked by the same statement (a foreign key also locks the table it points at). */
    alsoLocks: string[];
    work: Work;
    risk: Risk;
    reason: string;
    table: string | null;
    sizeClass: SizeClass;
    tableBytes: number | null;
    tableRows: number | null;
    notes: string[];
    /** The step removes data or an object that can't be brought back by running a statement. */
    destructive: boolean;
    /** Running it changes what applications see (a rename, a dropped column). */
    breaksClients: boolean;
    /** Not run by default: written as comments. Used for the clean-up that must wait until applications have switched. */
    optional: boolean;
    /** SQL that reverses the step, where there is one. */
    undo?: string;
}

export type FindingSeverity = "error" | "warning" | "info";

export interface Finding {
    severity: FindingSeverity;
    code: string;
    message: string;
    /** Index into plan.operations. */
    operation?: number;
    table?: string;
}

export interface Runbook {
    steps: RunbookStep[];
    findings: Finding[];
    /** The whole runbook as one SQL script with a comment header per step. */
    script: string;
    /** Operations that could not be compiled (an error finding explains each). */
    uncompiled: number[];
    server: { version: string; collectedAt: string };
    settings: CompileSettings;
}

export interface CompileSettings {
    /** How long one attempt may wait for a lock. */
    lockTimeoutSeconds: number;
    /** Attempts a step that takes a strong lock makes before it gives up (1 means it does not retry). */
    lockAttempts: number;
    backfillBatchRows: number;
    backfillPauseMs: number;
    defaultSchema: string;
}

export const DEFAULT_COMPILE_SETTINGS: CompileSettings = { lockTimeoutSeconds: 2, lockAttempts: 8, backfillBatchRows: 10_000, backfillPauseMs: 50, defaultSchema: "public" };

const statementLines = (sql: string): string[] => sql.replace(/\s+$/, "").split("\n");

/** One step as script text: a comment header, then the SQL (or the SQL as comments for an optional step). */
export function renderStep(step: RunbookStep, total: number): string {
    const header = [
        `-- ── Step ${step.id} of ${total}: ${step.title}${step.optional ? "  [NOT RUN BY DEFAULT]" : ""}`,
        `-- Risk: ${step.risk} · Lock: ${step.lock}${step.alsoLocks.length ? ` (+ ${step.alsoLocks.join(", ")})` : ""} · Work: ${step.work}${step.destructive ? " · DESTRUCTIVE" : ""}${step.breaksClients ? " · changes what applications see" : ""}`,
        `-- ${step.reason}`,
        ...step.notes.map((note) => `-- ${note}`),
    ];
    const body = step.optional ? statementLines(step.sql).map((line) => `-- ${line}`) : statementLines(step.sql);
    const undo = step.undo ? ["-- To undo:", ...statementLines(step.undo).map((line) => `--   ${line}`)] : [];
    return [...header, ...body, ...undo].join("\n");
}

export function renderScript(steps: RunbookStep[], server: { version: string; collectedAt: string }, settings: CompileSettings): string {
    const active = steps.filter((step) => !step.optional).length;
    const head = [
        `-- GoForge runbook: ${steps.length} step${steps.length === 1 ? "" : "s"} (${active} to run now) for PostgreSQL ${server.version}.`,
        `-- Built from the catalog as it was at ${server.collectedAt}. If the schema changed since then, build it again.`,
        "-- Run it in the SQL Editor with each statement run on its own (no transaction): CREATE INDEX CONCURRENTLY and the batched backfills need that.",
        "-- Select one step to run only that step.",
        `-- A step that takes a strong lock waits at most ${settings.lockTimeoutSeconds}s per attempt, so a busy table can't pile up a queue behind it, and ${settings.lockAttempts > 1 ? `tries up to ${settings.lockAttempts} times, backing off between tries` : "does not try again"}.`,
        "-- One that gives up changed nothing and says what is holding the table: run it again when that is gone.",
        "",
    ];
    const tail = ["", "-- ── Clean up the session settings used above", "RESET lock_timeout;", "RESET statement_timeout;", ""];
    return [...head, ...steps.map((step) => renderStep(step, steps.length)), ...tail].join("\n\n").replace(/\n{3,}/g, "\n\n");
}

export function summarizeRunbook(runbook: Pick<Runbook, "steps">): { steps: number; byRisk: Record<Risk, number>; rewrites: number; destructive: number; optional: number } {
    const byRisk: Record<Risk, number> = { low: 0, medium: 0, high: 0 };
    for (const step of runbook.steps) if (!step.optional) byRisk[step.risk]++;
    return {
        steps: runbook.steps.length,
        byRisk,
        rewrites: runbook.steps.filter((step) => step.work === "rewrite" && !step.optional).length,
        destructive: runbook.steps.filter((step) => step.destructive && !step.optional).length,
        optional: runbook.steps.filter((step) => step.optional).length,
    };
}
