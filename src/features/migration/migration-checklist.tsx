import { cn } from "@/lib/utils";
import { countEdits, type ConversionStatus, type MigrationEdits, type MigrationPlanColumn, type MigrationPlanPreview } from "@/lib/migrations-api";

export const STATUS_LABEL: Record<ConversionStatus, string> = { exact: "Same", changed: "Behaves differently", risk: "May lose data" };

const STATUS_CLASS: Record<ConversionStatus, string> = {
    exact: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
    changed: "border-amber-500/50 text-amber-700 dark:text-amber-400",
    risk: "border-destructive/50 text-destructive",
};

export const StatusBadge: React.FC<{ status: ConversionStatus }> = ({ status }) => (
    <span className={cn("inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium", STATUS_CLASS[status])}>{STATUS_LABEL[status]}</span>
);

/** Counts of columns by how their values fare, over every table of the plan. */
export function summarize(plan: MigrationPlanPreview): Record<ConversionStatus, number> & { columns: number } {
    const counts = { exact: 0, changed: 0, risk: 0, columns: 0 };
    for (const table of plan.tables) {
        for (const column of table.columns) {
            counts[column.note.status] += 1;
            counts.columns += 1;
        }
    }
    return counts;
}

const EDIT_LABEL: Record<MigrationPlanColumn["edited"][number], string> = { name: "renamed", type: "type changed", default: "default dropped" };

/** What a check counted, in a sentence. */
export const checkSentence = (check: NonNullable<MigrationPlanColumn["check"]>): string =>
    check.count === null ? `Could not be checked on your data (${check.error ?? "the query failed"}).` : check.count === 0 ? `Checked on your data: no value is affected (${check.description}).` : `Checked on your data: ${check.count.toLocaleString()} value${check.count === 1 ? "" : "s"} affected (${check.description}).`;

/**
 * The plan as a checklist: for every column what it becomes and how its values fare, what can be lost, what is not carried over at all, and
 * what behaves differently in queries. A change the person asked for is marked, and where a type can lose something the query that counted
 * it on the Oracle data is shown with its answer.
 */
export const MigrationChecklist: React.FC<{ plan: MigrationPlanPreview; edits?: MigrationEdits }> = ({ plan, edits }) => {
    const counts = summarize(plan);
    const risky = plan.tables.flatMap((table) => table.columns.filter((column) => column.note.status === "risk").map((column) => ({ table: table.pgName, column })));
    const tablesTotal = plan.tables.length;
    const changes = edits ? countEdits(edits) : 0;

    return (
        <div className="min-w-0 space-y-3 text-xs" data-testid="migration-checklist">
            <p className="text-muted-foreground">
                {counts.columns} column{counts.columns === 1 ? "" : "s"} in {tablesTotal} table{tablesTotal === 1 ? "" : "s"}:{" "}
                <span className="text-foreground">{counts.exact} stay the same</span>, <span className="text-foreground">{counts.changed} behave differently</span>,{" "}
                <span className="text-foreground">{counts.risk} may lose data</span>; <span className="text-foreground">{plan.notCarried.length} object{plan.notCarried.length === 1 ? "" : "s"} not carried over</span>
                {changes > 0 ? <>; <span className="text-foreground">{changes} change{changes === 1 ? "" : "s"} made by you</span></> : null}.
            </p>

            {plan.editProblems.length > 0 && (
                <div className="rounded-md border border-amber-500/50 p-2" role="status">
                    <p className="font-medium">These changes could not be made</p>
                    <ul className="list-disc pl-4 text-muted-foreground">{plan.editProblems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
                </div>
            )}

            <div className={cn("rounded-md border p-2", risky.length > 0 ? "border-destructive/40" : "border-emerald-500/30")}>
                <p className="font-medium">Data loss</p>
                {risky.length === 0 ? (
                    <p className="text-muted-foreground">No column is marked as able to lose information. Every row is still copied and then compared with Oracle by queries on both sides; you will see them after the migration.</p>
                ) : (
                    <>
                        <p className="text-muted-foreground">These columns keep the value but not everything about it:</p>
                        <ul className="list-disc pl-4">
                            {risky.map(({ table, column }) => (
                                <li key={`${table}.${column.pgName}`}>
                                    <span className="font-mono">{table}.{column.pgName}</span> ({column.oracleType} to {column.pgType}): {column.note.text}
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>

            <div className="space-y-1">
                <p className="font-medium">Column by column</p>
                {plan.tables.map((table, index) => {
                    const toRead = table.columns.filter((column) => column.note.status !== "exact" || column.edited.length > 0).length;
                    return (
                        <details key={table.oracleName} className="min-w-0 rounded-md border" open={index === 0 && tablesTotal <= 2}>
                            <summary className="cursor-pointer select-none px-2 py-1.5">
                                <span className="font-mono">{table.oracleName}</span> to <span className={cn("font-mono", table.renamed && "font-semibold")}>{table.pgName}</span>
                                {table.renamed && <span className="ml-1 rounded border px-1 py-0.5 text-[10px] text-muted-foreground">renamed by you</span>}
                                <span className="text-muted-foreground"> · {table.rows.toLocaleString()} rows · {table.columns.length} columns{toRead > 0 ? ` · ${toRead} to read` : ""}{table.oraclePrimaryKey.length > 0 ? ` · primary key ${table.oraclePrimaryKey.join(", ")}` : " · no primary key"}</span>
                            </summary>
                            <div className="overflow-x-auto border-t">
                                <table className="w-full min-w-[34rem] text-left">
                                    <thead className="bg-muted/50 text-muted-foreground">
                                        <tr>
                                            <th className="px-2 py-1 font-medium">Oracle column</th>
                                            <th className="px-2 py-1 font-medium">Oracle type</th>
                                            <th className="px-2 py-1 font-medium">PostgreSQL type</th>
                                            <th className="px-2 py-1 font-medium">Values</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {table.columns.map((column) => (
                                            <tr key={column.oracleName} className={cn("border-t align-top", column.edited.length > 0 && "bg-muted/30")}>
                                                <td className="px-2 py-1 font-mono">
                                                    {column.oracleName}
                                                    <span className="block font-sans text-[10px] text-muted-foreground">to <span className={cn(column.edited.includes("name") && "font-semibold text-foreground")}>{column.pgName}</span>{column.nullable ? "" : ", NOT NULL"}</span>
                                                    {column.edited.length > 0 && <span className="mt-0.5 inline-block rounded border px-1 font-sans text-[10px] text-muted-foreground">changed by you: {column.edited.map((kind) => EDIT_LABEL[kind]).join(", ")}</span>}
                                                </td>
                                                <td className="px-2 py-1 font-mono">{column.oracleType}</td>
                                                <td className={cn("px-2 py-1 font-mono", column.edited.includes("type") && "font-semibold")}>{column.pgType}</td>
                                                <td className="px-2 py-1">
                                                    <StatusBadge status={column.note.status} />
                                                    <span className="mt-0.5 block text-muted-foreground">{column.note.text}</span>
                                                    {column.check && (
                                                        <details className="mt-0.5">
                                                            <summary className={cn("cursor-pointer select-none", column.check.count === 0 ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>{checkSentence(column.check)}</summary>
                                                            <pre className="mt-0.5 select-all overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-1.5 font-mono text-[10px]">{column.check.sql}</pre>
                                                        </details>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </details>
                    );
                })}
            </div>

            <div>
                <p className="font-medium">Not carried over</p>
                {plan.notCarried.length === 0 ? (
                    <p className="text-muted-foreground">Nothing else in the schema: no indexes beyond the keys, CHECK constraints, sequences, views, triggers or programs. Tables, columns, NOT NULL, same-meaning defaults, primary keys, unique constraints and foreign keys are carried.</p>
                ) : (
                    <>
                        <p className="text-muted-foreground">The migration carries tables, columns, NOT NULL, same-meaning defaults, primary keys, unique constraints and foreign keys. These are left behind, and would have to be recreated in PostgreSQL by hand:</p>
                        <ul className="list-disc pl-4">
                            {plan.notCarried.map((entry) => (
                                <li key={`${entry.kind}:${entry.name}`}>
                                    {entry.kind} <span className="font-mono">{entry.name}</span>{entry.detail ? <span className="text-muted-foreground"> ({entry.detail})</span> : null}
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>

            {plan.behaviour.length > 0 && (
                <div>
                    <p className="font-medium">Behaves differently in queries, whatever is stored</p>
                    <ul className="list-disc pl-4 text-muted-foreground">
                        {plan.behaviour.map((note) => <li key={note}>{note}</li>)}
                    </ul>
                </div>
            )}
        </div>
    );
};
