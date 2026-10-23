import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { PreviewResult } from "@/lib/modernizer-api";
import { SavedConnection, listSavedConnections } from "@/lib/live-connection-api";
import { runSql } from "@/lib/sql-editor-api";
import { MAX_REPORTED, compareOutput, parseExpectedOutput } from "../compare-output";
import { oracleResultToText } from "../oracle-reference";

/**
 * "Does it return what the original returned?": the person pastes the rows the old database gave, and the PostgreSQL rows above are checked
 * against them cell by cell. Numbers and dates are compared by value, and NULL and an empty string are the same (they are, in Oracle).
 */
export const OutputCheck: React.FC<{ result: PreviewResult; dialectLabel: string; /** The query as it was written for the old database. */ originalSql?: string; dialect?: string }> = ({ result, dialectLabel, originalSql, dialect }) => {
    const [text, setText] = useState("");
    const [ignoreOrder, setIgnoreOrder] = useState(false);

    // With an Oracle database of the person's own (created in GoForge), the original can be run there instead of copying its output by hand.
    const [oracleDatabases, setOracleDatabases] = useState<SavedConnection[]>([]);
    const [oracleId, setOracleId] = useState("");
    const [running, setRunning] = useState(false);
    const [runError, setRunError] = useState<string | undefined>(undefined);
    useEffect(() => {
        if (dialect !== "oracle") return;
        let current = true;
        listSavedConnections("oracle")
            .then((list) => {
                if (!current) return;
                setOracleDatabases(list);
                setOracleId((previous) => (list.some((connection) => connection.id === previous) ? previous : (list[0]?.id ?? "")));
            })
            .catch(() => undefined);
        return () => {
            current = false;
        };
    }, [dialect]);

    const runOnOracle = async () => {
        if (!oracleId || !originalSql || running) return;
        setRunning(true);
        setRunError(undefined);
        try {
            const response = await runSql(oracleId, { sessionId: `modernizer-${Date.now()}`, sql: originalSql, transactional: false, expectOpenTransaction: false });
            if (!response.ok) setRunError(response.error.message);
            else {
                const returned = response.results.find((candidate) => candidate.columns.length > 0);
                if (returned) setText(oracleResultToText(returned.columns, returned.rows));
                else setRunError("The original ran but returned no rows, so there is nothing to compare.");
            }
        } catch (error) {
            setRunError(error instanceof Error ? error.message : String(error));
        } finally {
            setRunning(false);
        }
    };
    const outcome = useMemo(() => {
        if (!text.trim()) return undefined;
        const expected = parseExpectedOutput(text);
        if ("error" in expected) return { error: expected.error } as const;
        return { comparison: compareOutput(expected, { columns: result.columns.map((column) => column.name), rows: result.rows, truncated: result.truncated }, { ignoreOrder }) } as const;
    }, [text, ignoreOrder, result]);

    const comparison = outcome && "comparison" in outcome ? outcome.comparison : undefined;
    const shown = (rows: string[][]) => rows.slice(0, MAX_REPORTED);

    return (
        <section className="space-y-2 rounded-lg border bg-card p-3" aria-label={`Compare with the ${dialectLabel} output`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="expected-output" className="text-xs font-medium">Compare with what {dialectLabel} returned</Label>
                <label htmlFor="ignore-order" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Switch id="ignore-order" checked={ignoreOrder} onCheckedChange={setIgnoreOrder} aria-label="Ignore the order of rows" />
                    Ignore row order
                </label>
            </div>
            {oracleDatabases.length > 0 && originalSql && (
                <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="run-on-oracle">
                    <span className="text-muted-foreground">or run the original on</span>
                    <Select value={oracleId || undefined} onValueChange={setOracleId}>
                        <SelectTrigger size="sm" className="h-8 w-48 max-w-full" aria-label="Oracle database to run the original on"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {oracleDatabases.map((connection) => (
                                <SelectItem key={connection.id} value={connection.id}>{connection.name}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => void runOnOracle()} disabled={running || !oracleId}>
                        {running ? "Running…" : "Run on Oracle and compare"}
                    </Button>
                </div>
            )}
            {runError && <p className="text-xs text-destructive" role="alert">Oracle: {runError}</p>}
            <Textarea
                id="expected-output"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={"Paste the result from the original database, with the column names on the first line.\nCopied from a grid, a SQL*Plus or psql table, or a CSV export."}
                className="min-h-24 font-mono text-xs"
                spellCheck={false}
            />

            {outcome && "error" in outcome && <p className="text-xs text-destructive" role="alert">{outcome.error}</p>}

            {comparison && (
                <div className="space-y-1.5 text-xs" role="status">
                    <p className={cn("font-medium", comparison.matches ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
                        {comparison.matches
                            ? comparison.partial
                                ? `The first ${comparison.actualRows} rows match. PostgreSQL had more, and only the first 100 are read.`
                                : `Same result: ${comparison.actualRows} row${comparison.actualRows === 1 ? "" : "s"}, every value matches.`
                            : `Different: ${comparison.expectedRows} row${comparison.expectedRows === 1 ? "" : "s"} from ${dialectLabel}, ${comparison.actualRows} from PostgreSQL.`}
                    </p>
                    {comparison.columnProblem && <p className="text-muted-foreground">{comparison.columnProblem}</p>}
                    {comparison.partial && !comparison.matches && <p className="text-muted-foreground">Only the first {comparison.actualRows} rows were read from PostgreSQL, so only those were checked, in order.</p>}
                    {comparison.differences.length > 0 && (
                        <ul className="space-y-0.5 text-muted-foreground">
                            {comparison.differences.slice(0, MAX_REPORTED).map((difference, index) => (
                                <li key={index} className="break-words">
                                    Row {difference.row}, <span className="font-mono">{difference.column}</span>: {dialectLabel} gave <span className="font-mono text-foreground">{difference.expected}</span>, PostgreSQL gives <span className="font-mono text-foreground">{difference.actual}</span>
                                </li>
                            ))}
                            {comparison.differences.length > MAX_REPORTED && <li>…and {comparison.differences.length - MAX_REPORTED} more.</li>}
                        </ul>
                    )}
                    {comparison.missing.length > 0 && (
                        <div className="text-muted-foreground">
                            <p>{ignoreOrder ? `Rows ${dialectLabel} returned that PostgreSQL did not (${comparison.missing.length}):` : `Rows ${dialectLabel} has beyond what PostgreSQL returned (${comparison.missing.length}):`}</p>
                            <ul className="font-mono">{shown(comparison.missing).map((row, index) => <li key={index} className="break-all">{row.join(" | ")}</li>)}</ul>
                        </div>
                    )}
                    {comparison.extra.length > 0 && (
                        <div className="text-muted-foreground">
                            <p>{ignoreOrder ? `Rows PostgreSQL returned that ${dialectLabel} did not (${comparison.extra.length}):` : `Rows PostgreSQL has beyond what ${dialectLabel} returned (${comparison.extra.length}):`}</p>
                            <ul className="font-mono">{shown(comparison.extra).map((row, index) => <li key={index} className="break-all">{row.join(" | ")}</li>)}</ul>
                        </div>
                    )}
                </div>
            )}
        </section>
    );
};
