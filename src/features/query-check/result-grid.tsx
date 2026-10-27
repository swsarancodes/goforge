import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { RowsTable } from "@/components/rows-table";
import { formatRows } from "@/utils/data-view/format-rows";
import type { Rows } from "./use-query-check";

/**
 * The rows one database returned, under its name, with how many there were. Rows with no equal on the other side can be marked, so two grids
 * shown next to each other say which rows differ. Used by the query check page and by the Modernizer's "run both".
 */
export const ResultGrid: React.FC<{
    title: string;
    rows: Rows | undefined;
    marked: Set<number> | undefined;
    waiting: boolean;
    /** Cells cut to the cell limit, as [row, column]. */
    truncatedCells?: [number, number][];
    /** Said after the row count, for example how long the query took. */
    note?: string;
    /** What to show when there are no rows and nothing is running, for example why the query could not run. */
    emptyMessage?: string;
}> = ({ title, rows, marked, waiting, truncatedCells, note, emptyMessage }) => {
    const formatted = useMemo(() => (rows ? formatRows(rows.columns, rows.rows, truncatedCells) : []), [rows, truncatedCells]);
    return (
        <section className="flex min-h-0 min-w-0 flex-col rounded-lg border bg-card" aria-label={`${title} result`}>
            <header className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
                <p className="font-medium">{title}</p>
                <p className="text-muted-foreground" data-testid={`${title.toLowerCase()}-count`}>
                    {rows ? `${rows.rows.length.toLocaleString()}${rows.truncated ? "+" : ""} row${rows.rows.length === 1 ? "" : "s"}, ${rows.columns.length} column${rows.columns.length === 1 ? "" : "s"}${note ? `, ${note}` : ""}` : waiting ? "Running…" : "Not run yet"}
                </p>
            </header>
            <div className="max-h-[60vh] min-h-48 overflow-auto">
                {rows ? (
                    <RowsTable columns={rows.columns} rows={formatted} emptyText="No rows returned." rowClassName={(index) => (marked?.has(index) ? "bg-destructive/10" : undefined)} />
                ) : (
                    <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
                        {waiting && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                        {waiting ? "Waiting for the database…" : (emptyMessage ?? "Run the query to see the rows here.")}
                    </p>
                )}
            </div>
        </section>
    );
};
