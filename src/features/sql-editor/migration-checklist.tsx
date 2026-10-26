import { cn } from "@/lib/utils";
import type { ConversionStatus, MigrationPlanPreview } from "@/lib/migrations-api";

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

/**
 * The checklist shown before anything runs: for every column what it becomes and how its values fare, what can be lost, what is not carried
 * over at all, and what behaves differently in queries. Everything here comes from the Oracle dictionary and the migration's own type rules.
 */
export const MigrationChecklist: React.FC<{ plan: MigrationPlanPreview }> = ({ plan }) => {
    const counts = summarize(plan);
    const risky = plan.tables.flatMap((table) => table.columns.filter((column) => column.note.status === "risk").map((column) => ({ table: table.pgName, column })));
    const tablesTotal = plan.tables.length;

    return (
        <div className="min-w-0 space-y-3 text-xs" data-testid="migration-checklist">
            <p className="text-muted-foreground">
                {counts.columns} column{counts.columns === 1 ? "" : "s"} in {tablesTotal} table{tablesTotal === 1 ? "" : "s"}:{" "}
                <span className="text-foreground">{counts.exact} stay the same</span>, <span className="text-foreground">{counts.changed} behave differently</span>,{" "}
                <span className="text-foreground">{counts.risk} may lose data</span>; <span className="text-foreground">{plan.notCarried.length} object{plan.notCarried.length === 1 ? "" : "s"} not carried over</span>.
            </p>

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
                    const changed = table.columns.filter((column) => column.note.status !== "exact").length;
                    return (
                        <details key={table.oracleName} className="min-w-0 rounded-md border" open={index === 0 && tablesTotal <= 2}>
                            <summary className="cursor-pointer select-none px-2 py-1.5">
                                <span className="font-mono">{table.oracleName}</span> to <span className="font-mono">{table.pgName}</span>
                                <span className="text-muted-foreground"> · {table.rows.toLocaleString()} rows · {table.columns.length} columns{changed > 0 ? ` · ${changed} to read` : ""}{table.oraclePrimaryKey.length > 0 ? ` · primary key ${table.oraclePrimaryKey.join(", ")}` : " · no primary key"}</span>
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
                                            <tr key={column.oracleName} className="border-t align-top">
                                                <td className="px-2 py-1 font-mono">{column.oracleName}<span className="block font-sans text-[10px] text-muted-foreground">to {column.pgName}{column.nullable ? "" : ", NOT NULL"}</span></td>
                                                <td className="px-2 py-1 font-mono">{column.oracleType}</td>
                                                <td className="px-2 py-1 font-mono">{column.pgType}</td>
                                                <td className="px-2 py-1"><StatusBadge status={column.note.status} /><span className="mt-0.5 block text-muted-foreground">{column.note.text}</span></td>
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
