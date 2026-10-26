import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TableVerification } from "@/lib/migrations-api";

const cell = (value: string | null) => (value === null ? <span className="italic text-muted-foreground">NULL</span> : value);

/**
 * The proof shown after a migration: for every table the comparisons that were made, each with the expression run on Oracle and on
 * PostgreSQL and the two answers, the first rows by primary key side by side, and the two statements, so they can be run again by hand.
 */
export const MigrationProof: React.FC<{ verification: TableVerification[]; onRerun?: () => void; rerunning?: boolean }> = ({ verification, onRerun, rerunning }) => {
    const comparisons = verification.reduce((sum, entry) => sum + entry.checks, 0);
    const different = verification.reduce((sum, entry) => sum + entry.mismatches.length, 0);

    return (
        <div className="min-w-0 space-y-2 text-xs" data-testid="migration-proof">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                    Proof: {comparisons} comparisons by queries run on both databases, {different === 0 ? "all equal" : `${different} different`}
                </p>
                {onRerun && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onRerun} disabled={rerunning}>
                        {rerunning ? <Loader2 className="size-3 animate-spin" /> : null} Run the proof again
                    </Button>
                )}
            </div>
            {verification.map((entry) => (
                <details key={entry.table} className="min-w-0 rounded-md border">
                    <summary className="cursor-pointer select-none px-2 py-1.5">
                        <span className="font-mono">{entry.table}</span>
                        <span className={cn("text-muted-foreground", entry.mismatches.length > 0 && "text-destructive")}>
                            {" "}· {entry.oracleRows.toLocaleString()} rows in Oracle, {entry.postgresRows.toLocaleString()} in PostgreSQL · {entry.checks} comparisons, {entry.mismatches.length === 0 ? "all equal" : `${entry.mismatches.length} different`}
                        </span>
                    </summary>
                    <div className="space-y-2 border-t p-2">
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[36rem] text-left">
                                <thead className="text-muted-foreground">
                                    <tr><th className="px-1 py-1 font-medium">What</th><th className="px-1 py-1 font-medium">Oracle</th><th className="px-1 py-1 font-medium">PostgreSQL</th><th className="px-1 py-1 font-medium">Result</th></tr>
                                </thead>
                                <tbody>
                                    {entry.proof.checks.map((check) => (
                                        <tr key={check.label} className="border-t align-top">
                                            <td className="px-1 py-1">{check.label}</td>
                                            <td className="px-1 py-1"><code className="block break-all text-[10px] text-muted-foreground">{check.oracleExpression}</code>{cell(check.oracle)}</td>
                                            <td className="px-1 py-1"><code className="block break-all text-[10px] text-muted-foreground">{check.postgresExpression}</code>{cell(check.postgres)}</td>
                                            <td className={cn("px-1 py-1", check.match ? "text-emerald-700 dark:text-emerald-400" : "font-medium text-destructive")}>{check.match ? "equal" : "DIFFERENT"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {entry.proof.sample && (
                            <div className="space-y-1">
                                <p className="font-medium">First {entry.proof.sample.oracleRows.length} rows by primary key, {entry.proof.sample.match ? "equal" : "DIFFERENT"}</p>
                                <div className="grid gap-2 lg:grid-cols-2">
                                    {([["Oracle", entry.proof.sample.oracleRows], ["PostgreSQL", entry.proof.sample.postgresRows]] as const).map(([name, rows]) => (
                                        <div key={name} className="min-w-0 overflow-x-auto rounded border">
                                            <p className="bg-muted/50 px-2 py-0.5 text-muted-foreground">{name}</p>
                                            <table className="w-full text-left">
                                                <thead className="text-muted-foreground"><tr>{entry.proof.sample!.columns.map((column) => <th key={column} className="px-1 py-0.5 font-medium">{column}</th>)}</tr></thead>
                                                <tbody>
                                                    {rows.map((row, at) => (
                                                        <tr key={at} className="border-t">{row.map((value, column) => <td key={column} className="max-w-[10rem] truncate px-1 py-0.5 font-mono" title={value ?? "NULL"}>{cell(value)}</td>)}</tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <details>
                            <summary className="cursor-pointer select-none text-muted-foreground">Show the SQL, to run it yourself</summary>
                            <div className="mt-1 space-y-1">
                                {([
                                    ["Oracle: checks", entry.proof.oracleSql],
                                    ["PostgreSQL: checks", entry.proof.postgresSql],
                                    ...(entry.proof.sample ? ([["Oracle: first rows", entry.proof.sample.oracleSql], ["PostgreSQL: first rows", entry.proof.sample.postgresSql]] as const) : []),
                                ] as const).map(([title, sql]) => (
                                    <div key={title}>
                                        <p className="text-muted-foreground">{title}</p>
                                        <pre className="select-all overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-1.5 font-mono text-[10px]">{sql}</pre>
                                    </div>
                                ))}
                            </div>
                        </details>

                        {entry.mismatches.length > 0 && (
                            <ul className="list-disc pl-4 text-destructive">{entry.mismatches.map((line) => <li key={line}>{line}</li>)}</ul>
                        )}
                    </div>
                </details>
            ))}
        </div>
    );
};
