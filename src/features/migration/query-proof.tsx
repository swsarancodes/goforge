import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ComparisonSummary } from "@/features/query-modernizer/components/comparison-summary";
import { compareOutput, type OutputComparison } from "@/features/query-modernizer/compare-output";
import { checkPostgresSyntax } from "@/features/query-modernizer/engine/checks";
import { applyMapping } from "@/features/query-modernizer/engine/mapping-apply";
import { modernize } from "@/features/query-modernizer/modernize";
import { AiStatus, fetchAiStatus, requestQueryModernization } from "@/lib/ai-api";
import { previewQueryOnConnection, validateSqlOnConnection } from "@/lib/modernizer-api";
import type { MigrationPlanPreview } from "@/lib/migrations-api";
import { runSql } from "@/lib/sql-editor-api";
import { defaultProofQuery, mappingFromPlan } from "./name-mapping";

interface Rows {
    columns: string[];
    rows: (string | null)[][];
    truncated: boolean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const hasOrderBy = (sql: string): boolean => /\border\s+by\b/i.test(sql);

const RowsPreview: React.FC<{ title: string; data: Rows }> = ({ title, data }) => (
    <div className="min-w-0 overflow-x-auto rounded border">
        <p className="bg-muted/50 px-2 py-0.5 text-muted-foreground">{title}</p>
        <table className="w-full text-left">
            <thead className="text-muted-foreground"><tr>{data.columns.map((column) => <th key={column} className="px-1 py-0.5 font-medium">{column}</th>)}</tr></thead>
            <tbody>
                {data.rows.slice(0, 10).map((row, at) => (
                    <tr key={at} className="border-t">{row.map((value, column) => <td key={column} className="max-w-[10rem] truncate px-1 py-0.5 font-mono" title={value ?? "NULL"}>{value === null ? <span className="italic text-muted-foreground">NULL</span> : value}</td>)}</tr>
                ))}
            </tbody>
        </table>
    </div>
);

/**
 * "Does the same question get the same answer?", asked after the migration. A person writes (or keeps) an Oracle query that returns, say,
 * 100 rows; it runs on the Oracle database, is converted, runs on the new PostgreSQL database, and the two results are compared by value,
 * with the row counts side by side. The PostgreSQL query can be edited and run again, which is how a query written by hand to mean the same
 * thing is checked too. Names the person changed in the plan are rewritten in the converted query.
 */
export const QueryProof: React.FC<{ oracleId: string; postgresId: string; plan: MigrationPlanPreview }> = ({ oracleId, postgresId, plan }) => {
    const mapping = useMemo(() => mappingFromPlan(plan), [plan]);
    const [oracleSql, setOracleSql] = useState(() => defaultProofQuery(plan));
    const [pgSql, setPgSql] = useState("");
    const [oracleRows, setOracleRows] = useState<Rows | undefined>(undefined);
    const [pgRows, setPgRows] = useState<Rows | undefined>(undefined);
    const [comparison, setComparison] = useState<OutputComparison | undefined>(undefined);
    const [converted, setConverted] = useState<{ source: "rules" | "ai"; notes: string[] } | undefined>(undefined);
    const [ignoreOrder, setIgnoreOrder] = useState(() => !hasOrderBy(defaultProofQuery(plan)));
    const [busy, setBusy] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [ai, setAi] = useState<AiStatus | undefined>(undefined);
    const aiReady = Boolean(ai?.configured && ai.allowed !== false);

    useEffect(() => {
        fetchAiStatus().then(setAi).catch(() => setAi(undefined));
    }, []);

    const compare = (oracle: Rows, postgres: Rows, order: boolean) =>
        compareOutput({ columns: oracle.columns, rows: oracle.rows.map((row) => row.map((cell) => cell ?? "")) }, { columns: postgres.columns, rows: postgres.rows, truncated: postgres.truncated }, { ignoreOrder: order });

    const runOnPostgres = async (sql: string, oracle: Rows, order: boolean) => {
        setBusy("Running it on PostgreSQL");
        const response = await previewQueryOnConnection(postgresId, sql);
        if (!response.ok) {
            setPgRows(undefined);
            setComparison(undefined);
            setError(`PostgreSQL: ${response.error.message}`);
            return;
        }
        const rows: Rows = { columns: response.result.columns.map((column) => column.name), rows: response.result.rows, truncated: response.result.truncated };
        setPgRows(rows);
        setComparison(compare(oracle, rows, order));
    };

    const runOnOracle = async (): Promise<Rows | undefined> => {
        setBusy("Running it on Oracle");
        const response = await runSql(oracleId, { sessionId: `migration-proof-${Date.now()}`, sql: oracleSql, transactional: false, expectOpenTransaction: false });
        if (!response.ok) {
            setError(`Oracle: ${response.error.message}`);
            return undefined;
        }
        const returned = response.results.find((candidate) => candidate.columns.length > 0);
        if (!returned) {
            setError("The query ran on Oracle but returned no rows, so there is nothing to compare.");
            return undefined;
        }
        const rows: Rows = { columns: returned.columns.map((column) => column.name), rows: returned.rows, truncated: returned.truncated };
        setOracleRows(rows);
        return rows;
    };

    const runAll = async () => {
        if (!oracleSql.trim() || busy) return;
        setError(undefined);
        setComparison(undefined);
        setPgRows(undefined);
        setConverted(undefined);
        const order = !ignoreOrder;
        try {
            const oracle = await runOnOracle();
            if (!oracle) return;
            const withNames = (text: string) => (mapping.length > 0 ? applyMapping(text, mapping, "oracle").sql : text);
            const outcome = await modernize(
                { sql: oracleSql, dialect: "oracle" },
                { syntax: checkPostgresSyntax, validate: (text) => validateSqlOnConnection(postgresId, withNames(text)), ask: aiReady ? (request) => requestQueryModernization(request) : undefined, onStage: setBusy },
            );
            const mapped = mapping.length > 0 ? applyMapping(outcome.sql, mapping, "oracle") : { sql: outcome.sql, issues: [] as string[] };
            const notes = [
                outcome.source === "ai" ? `Converted by the model (${outcome.ai?.model ?? "model"}), after the rules could not finish it.` : "Converted by the rules.",
                ...outcome.engine.unconverted.map((item) => `Not converted: ${item.construct} (${item.reason})`),
                ...(outcome.aiNotice ? [outcome.aiNotice] : []),
                ...mapped.issues,
                ...(mapping.length > 0 && mapped.issues.length === 0 ? ["The tables and columns you renamed are written with their new names."] : []),
            ];
            setConverted({ source: outcome.source, notes });
            setPgSql(mapped.sql);
            await runOnPostgres(mapped.sql, oracle, order);
        } catch (caught) {
            setError(messageOf(caught));
        } finally {
            setBusy(undefined);
        }
    };

    const rerunPostgres = async () => {
        if (!pgSql.trim() || !oracleRows || busy) return;
        setError(undefined);
        try {
            await runOnPostgres(pgSql, oracleRows, !ignoreOrder);
        } catch (caught) {
            setError(messageOf(caught));
        } finally {
            setBusy(undefined);
        }
    };

    return (
        <section className="min-w-0 space-y-3 rounded-lg border bg-card p-3 text-xs" aria-label="Prove it with a query" data-testid="query-proof">
            <div>
                <p className="text-sm font-medium">Prove it with a query</p>
                <p className="text-muted-foreground">Run a query on Oracle, and the same question on PostgreSQL, and compare what each returns. The one below reads up to 100 rows; write your own to ask something else.</p>
            </div>

            <div className="space-y-1">
                <Label htmlFor="proof-oracle-sql" className="text-xs">Oracle query</Label>
                <Textarea id="proof-oracle-sql" value={oracleSql} onChange={(event) => setOracleSql(event.target.value)} className="min-h-20 font-mono text-xs" spellCheck={false} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="proof-ignore-order" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Switch id="proof-ignore-order" checked={ignoreOrder} onCheckedChange={setIgnoreOrder} aria-label="Ignore the order of rows" />
                    Ignore row order
                </label>
                <Button size="sm" onClick={() => void runAll()} disabled={Boolean(busy) || !oracleSql.trim()}>
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} {busy ?? "Run on both and compare"}
                </Button>
            </div>
            {!aiReady && ai !== undefined && <p className="text-muted-foreground">No model is set up, so the conversion uses the rules only.</p>}
            {error && <p role="alert" className="whitespace-pre-wrap text-destructive">{error}</p>}

            {(oracleRows || pgRows) && (
                <p className="font-medium" data-testid="row-counts">
                    Oracle returned {oracleRows ? `${oracleRows.rows.length.toLocaleString()}${oracleRows.truncated ? "+" : ""}` : "…"} row{oracleRows?.rows.length === 1 ? "" : "s"}
                    <span className="text-muted-foreground"> · </span>
                    PostgreSQL returned {pgRows ? `${pgRows.rows.length.toLocaleString()}${pgRows.truncated ? "+" : ""}` : "…"} row{pgRows?.rows.length === 1 ? "" : "s"}
                </p>
            )}

            {converted && (
                <div className="space-y-1">
                    <Label htmlFor="proof-pg-sql" className="text-xs">PostgreSQL query <span className="font-normal text-muted-foreground">(you can edit it and run it again)</span></Label>
                    <Textarea id="proof-pg-sql" value={pgSql} onChange={(event) => setPgSql(event.target.value)} className="min-h-20 font-mono text-xs" spellCheck={false} />
                    <ul className="list-disc pl-4 text-muted-foreground">{converted.notes.map((note) => <li key={note} className="break-words">{note}</li>)}</ul>
                    <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => void rerunPostgres()} disabled={Boolean(busy) || !pgSql.trim()}>Run this on PostgreSQL and compare</Button>
                    </div>
                </div>
            )}

            {comparison && <ComparisonSummary comparison={comparison} dialectLabel="Oracle" ignoreOrder={ignoreOrder} />}

            {oracleRows && pgRows && (
                <details>
                    <summary className="cursor-pointer select-none text-muted-foreground">Show the first rows of each</summary>
                    <div className="mt-1 grid gap-2 lg:grid-cols-2">
                        <RowsPreview title="Oracle" data={oracleRows} />
                        <RowsPreview title="PostgreSQL" data={pgRows} />
                    </div>
                </details>
            )}
        </section>
    );
};
