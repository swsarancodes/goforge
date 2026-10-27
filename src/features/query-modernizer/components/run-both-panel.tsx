import React, { useMemo } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ResultGrid } from "@/features/query-check/result-grid";
import { compareSides, postgresHint, sideSummary, takesUnorderedFirstRows, type BothState, type Side } from "../run-both";
import { ComparisonSummary } from "./comparison-summary";

const rowsOf = (side: Side | undefined) => (side?.ok ? { columns: side.result.columns, rows: side.result.rows, truncated: side.result.truncated } : undefined);

/**
 * The original query on Oracle and the converted query on PostgreSQL, run together, with what each returned side by side: the row counts,
 * whether every value matches, and the rows that have no equal on the other side marked in both grids. Both runs read the first 100 rows
 * and change nothing.
 */
export const RunBothPanel: React.FC<{
    state: BothState;
    oracleName: string | undefined;
    postgresName: string | undefined;
    /** The original query as it was written, to tell when "the first N rows" are an arbitrary N. */
    originalSql: string;
    /** Why it cannot run yet, if it cannot. */
    blocker: string | undefined;
    onRun: () => void;
    ignoreOrder: boolean;
    onIgnoreOrderChange: (value: boolean) => void;
}> = ({ state, oracleName, postgresName, originalSql, blocker, onRun, ignoreOrder, onIgnoreOrderChange }) => {
    const running = state.status === "running";
    const done = state.status === "done" ? state : undefined;
    const compared = useMemo(() => (done ? compareSides(done.oracle, done.postgres, ignoreOrder) : undefined), [done, ignoreOrder]);
    const truncated = Boolean((done?.oracle.ok && done.oracle.result.truncated) || (done?.postgres.ok && done.postgres.result.truncated));
    const hint = done ? postgresHint(done.postgres) : undefined;

    return (
        <div className="@container flex flex-col gap-3 p-1" data-testid="run-both">
            <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" onClick={onRun} disabled={Boolean(blocker) || running} className="h-8 gap-1.5 text-xs" title={blocker ?? "Run the original on Oracle and the conversion on PostgreSQL at the same time"}>
                    {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    {running ? "Running both…" : done ? "Run both again" : "Run both and compare"}
                </Button>
                <label htmlFor="run-both-ignore-order" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Switch id="run-both-ignore-order" checked={ignoreOrder} onCheckedChange={onIgnoreOrderChange} aria-label="Ignore the order of rows" />
                    Ignore row order
                </label>
                {blocker && <span className="text-[11px] text-muted-foreground">{blocker}</span>}
            </div>

            <p className="text-[11px] text-muted-foreground">
                The original runs on Oracle{oracleName ? ` (${oracleName})` : ""} and the conversion on PostgreSQL{postgresName ? ` (${postgresName})` : ""}, at the same time. Each is read-only and returns its first 100 rows; nothing is changed.
            </p>

            {done && (
                <div className="space-y-2" aria-live="polite">
                    <p className="text-sm font-medium" data-testid="run-both-counts">
                        {sideSummary("Oracle", done.oracle)}
                        <span className="text-muted-foreground"> · </span>
                        {sideSummary("PostgreSQL", done.postgres)}
                    </p>
                    {!done.oracle.ok && (
                        <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
                            Oracle: {done.oracle.message}
                        </p>
                    )}
                    {!done.postgres.ok && (
                        <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
                            PostgreSQL: {done.postgres.message}
                            {hint ? ` ${hint}` : ""}
                        </p>
                    )}
                    {compared && <ComparisonSummary comparison={compared.comparison} dialectLabel="Oracle" ignoreOrder={ignoreOrder} />}
                    {compared && (compared.marked.left.size > 0 || compared.marked.right.size > 0) && <p className="text-xs text-muted-foreground">Rows marked in red have no equal row on the other side.</p>}
                    {compared && takesUnorderedFirstRows(originalSql) && (
                        <p className="text-xs text-muted-foreground">The original takes its first rows with no ORDER BY, so Oracle and PostgreSQL may each pick different rows. Add an ORDER BY to compare the same ones.</p>
                    )}
                    {truncated && <p className="text-xs text-muted-foreground">One side had more than 100 rows. Only the first 100 of each are read and compared.</p>}
                </div>
            )}

            {(running || done) && (
                <div className="grid gap-2 @xl:grid-cols-2">
                    <ResultGrid title="Oracle" rows={rowsOf(done?.oracle)} marked={compared?.marked.left} waiting={running} truncatedCells={done?.oracle.ok ? done.oracle.result.truncatedCells : undefined} emptyMessage={done && !done.oracle.ok ? "Oracle did not return rows." : undefined} />
                    <ResultGrid title="PostgreSQL" rows={rowsOf(done?.postgres)} marked={compared?.marked.right} waiting={running} truncatedCells={done?.postgres.ok ? done.postgres.result.truncatedCells : undefined} emptyMessage={done && !done.postgres.ok ? "PostgreSQL did not return rows." : undefined} />
                </div>
            )}
        </div>
    );
};
