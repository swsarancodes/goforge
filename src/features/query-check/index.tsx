import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ComparisonSummary } from "@/features/query-modernizer/components/comparison-summary";
import { connectionLabel } from "@/lib/live-connection-api";
import { cn } from "@/lib/utils";
import { ResultGrid } from "./result-grid";
import { useQueryCheck } from "./use-query-check";

/**
 * The query check: one question asked of both databases. An Oracle query runs on the Oracle database, is converted, and the conversion runs
 * on the PostgreSQL one; the rows each returned are shown side by side, with the row counts, a comparison by value, and the rows that have
 * no equal on the other side marked in both grids. Either query can be edited and run again.
 */
const QueryCheckPage: React.FC = () => {
    const check = useQueryCheck();
    const { oracleDatabases, postgresDatabases, oracleId, postgresId, select, busy, oracleRows, pgRows, comparison, marked, ignoreOrder } = check;
    const ready = Boolean(oracleId && postgresId && check.oracleSql.trim());
    const nothingToCheck = !check.loading && (oracleDatabases.length === 0 || postgresDatabases.length === 0);

    return (
        <div className="flex h-full min-h-0 w-full flex-col bg-background">
            <header className="flex flex-wrap items-end gap-3 border-b px-3 py-2">
                <div className="min-w-0">
                    <h1 className="text-sm font-medium">Query check</h1>
                    <p className="text-[11px] text-muted-foreground">Ask the same question of Oracle and PostgreSQL and see the rows each returns, side by side.</p>
                </div>
                <div className="ml-auto flex flex-wrap items-end gap-2">
                    <div className="space-y-0.5">
                        <Label className="text-[11px] text-muted-foreground">Oracle database</Label>
                        <Select value={oracleId} onValueChange={(value) => select({ oracle: value })} disabled={check.loading || oracleDatabases.length === 0 || Boolean(busy)}>
                            <SelectTrigger size="sm" className="h-8 w-48 max-w-full" aria-label="Oracle database"><SelectValue placeholder={oracleDatabases.length === 0 ? "None" : "Pick one"} /></SelectTrigger>
                            <SelectContent>{oracleDatabases.map((connection) => <SelectItem key={connection.id} value={connection.id}>{connectionLabel(connection, oracleDatabases)}</SelectItem>)}</SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-0.5">
                        <Label className="text-[11px] text-muted-foreground">PostgreSQL database</Label>
                        <Select value={postgresId} onValueChange={(value) => select({ postgres: value })} disabled={check.loading || postgresDatabases.length === 0 || Boolean(busy)}>
                            <SelectTrigger size="sm" className="h-8 w-48 max-w-full" aria-label="PostgreSQL database"><SelectValue placeholder={postgresDatabases.length === 0 ? "None" : "Pick one"} /></SelectTrigger>
                            <SelectContent>{postgresDatabases.map((connection) => <SelectItem key={connection.id} value={connection.id}>{connectionLabel(connection, postgresDatabases)}</SelectItem>)}</SelectContent>
                        </Select>
                    </div>
                </div>
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                {nothingToCheck && (
                    <div className="rounded-lg border p-4 text-sm">
                        <p className="font-medium">The query check needs an Oracle database and a PostgreSQL database.</p>
                        <p className="mt-1 text-muted-foreground">Migrate an Oracle database to PostgreSQL on the Migrate page, and come back.</p>
                    </div>
                )}

                <div className="grid gap-3 lg:grid-cols-2">
                    <div className="min-w-0 space-y-1">
                        <Label htmlFor="check-oracle-sql" className="text-xs">Oracle query</Label>
                        <Textarea id="check-oracle-sql" value={check.oracleSql} onChange={(event) => check.setOracleSql(event.target.value)} placeholder="SELECT * FROM CUST_MST ORDER BY CUST_ID FETCH FIRST 100 ROWS ONLY" className="min-h-24 font-mono text-xs" spellCheck={false} />
                    </div>
                    <div className="min-w-0 space-y-1">
                        <Label htmlFor="check-pg-sql" className="text-xs">PostgreSQL query <span className="font-normal text-muted-foreground">(made from the Oracle one; you can edit it and run it again)</span></Label>
                        <Textarea id="check-pg-sql" value={check.pgSql} onChange={(event) => check.setPgSql(event.target.value)} placeholder="Filled in when the Oracle query is converted." className="min-h-24 font-mono text-xs" spellCheck={false} />
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <Button size="sm" onClick={() => void check.runBoth()} disabled={!ready || Boolean(busy)}>
                        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} {busy ?? "Run on both and compare"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void check.runPostgresOnly()} disabled={Boolean(busy) || !check.pgSql.trim() || !oracleRows}>Run my PostgreSQL query and compare</Button>
                    <label htmlFor="check-ignore-order" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Switch id="check-ignore-order" checked={ignoreOrder} onCheckedChange={check.setIgnoreOrder} aria-label="Ignore the order of rows" />
                        Ignore row order
                    </label>
                    {!check.aiReady && check.ai !== undefined && <span className="text-[11px] text-muted-foreground">No model is set up, so the conversion uses the rules only.</span>}
                </div>

                {check.error && <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{check.error}</p>}
                {check.notes.length > 0 && <ul className="list-disc pl-5 text-xs text-muted-foreground">{check.notes.map((note) => <li key={note} className="break-words">{note}</li>)}</ul>}

                {(oracleRows || pgRows) && (
                    <p className="text-sm font-medium" data-testid="row-counts">
                        Oracle returned {oracleRows ? `${oracleRows.rows.length.toLocaleString()}${oracleRows.truncated ? "+" : ""}` : "…"} row{oracleRows?.rows.length === 1 ? "" : "s"}
                        <span className="text-muted-foreground"> · </span>
                        PostgreSQL returned {pgRows ? `${pgRows.rows.length.toLocaleString()}${pgRows.truncated ? "+" : ""}` : "…"} row{pgRows?.rows.length === 1 ? "" : "s"}
                    </p>
                )}
                {comparison && <ComparisonSummary comparison={comparison} dialectLabel="Oracle" ignoreOrder={ignoreOrder} />}
                {marked && (marked.left.size > 0 || marked.right.size > 0) && <p className={cn("text-xs text-muted-foreground")}>Rows marked in red have no equal row on the other side.</p>}

                <div className="grid gap-3 lg:grid-cols-2">
                    <ResultGrid title="Oracle" rows={oracleRows} marked={marked?.left} waiting={Boolean(busy)} />
                    <ResultGrid title="PostgreSQL" rows={pgRows} marked={marked?.right} waiting={Boolean(busy) && Boolean(oracleRows)} />
                </div>
            </div>
        </div>
    );
};

export default QueryCheckPage;
