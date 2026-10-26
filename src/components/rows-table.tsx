import { ArrowDown, ArrowUp, ChevronsUpDown, KeyRound } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { FormattedRowCell } from "@/utils/data-view/format-rows";

export interface RowsTableColumn {
    name: string;
    dataType: string;
    isPrimaryKey?: boolean;
}

interface RowsTableProps {
    columns: RowsTableColumn[];
    rows: FormattedRowCell[][];
    /** Number shown for the first row (row numbers continue across pages). */
    firstRowNumber?: number;
    sort?: { column: string; dir: "asc" | "desc" };
    /** When given, column headers become sort buttons. */
    onSort?: (column: string) => void;
    onRowClick?: (rowIndex: number) => void;
    /** Extra classes for one row, for example to mark the rows that differ from another result. */
    rowClassName?: (rowIndex: number) => string | undefined;
    emptyText: string;
}

/** Sticky-header grid for rows of text values: used by the table browser and the SQL editor's results. */
export const RowsTable: React.FC<RowsTableProps> = ({ columns, rows, firstRowNumber = 1, sort, onSort, onRowClick, rowClassName, emptyText }) => (
    <table className="w-max min-w-full text-xs border-separate border-spacing-0">
        <thead>
            <tr>
                <th className="sticky top-0 z-10 bg-card border-b px-2 py-2 text-right font-normal text-muted-foreground">#</th>
                {columns.map((column, columnIndex) => {
                    const active = sort?.column === column.name;
                    const label = (
                        <>
                            {column.isPrimaryKey && <KeyRound className="size-3 shrink-0 text-muted-foreground" />}
                            <span>{column.name}</span>
                            <span className="font-normal text-muted-foreground">{column.dataType}</span>
                            {onSort &&
                                (active && sort?.dir === "asc" ? (
                                    <ArrowUp className="size-3 shrink-0" />
                                ) : active && sort?.dir === "desc" ? (
                                    <ArrowDown className="size-3 shrink-0" />
                                ) : (
                                    <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground/50" />
                                ))}
                        </>
                    );
                    return (
                        // Column names can repeat in a query result (SELECT 1 AS a, 2 AS a), so the index is part of the key.
                        <th key={`${columnIndex}:${column.name}`} className="sticky top-0 z-10 bg-card border-b p-0 text-left font-medium whitespace-nowrap">
                            {onSort ? (
                                <button type="button" onClick={() => onSort(column.name)} className="flex w-full items-center gap-1 px-3 py-2 text-left hover:bg-accent" title={`${column.name} (${column.dataType})`}>
                                    {label}
                                </button>
                            ) : (
                                <div className="flex items-center gap-1 px-3 py-2" title={`${column.name} (${column.dataType})`}>
                                    {label}
                                </div>
                            )}
                        </th>
                    );
                })}
            </tr>
        </thead>
        <tbody>
            {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className={cn("hover:bg-accent/50", onRowClick && "cursor-pointer", rowClassName?.(rowIndex))} onClick={onRowClick ? () => onRowClick(rowIndex) : undefined}>
                    <td className="border-b px-2 py-1.5 text-right text-muted-foreground tabular-nums">{firstRowNumber + rowIndex}</td>
                    {row.map(({ cell, truncated }, columnIndex) => (
                        <td
                            key={columnIndex}
                            title={cell.kind === "null" ? "SQL NULL" : cell.full.slice(0, 500)}
                            className={cn("border-b px-3 py-1.5 max-w-[360px] truncate font-mono", cell.align === "right" && "text-right", cell.kind === "null" && "italic text-muted-foreground")}
                        >
                            {/* An empty string is a value, not NULL: make it visible. */}
                            {cell.kind !== "null" && cell.full === "" ? <span className="text-muted-foreground">""</span> : cell.display}
                            {cell.meta && <span className="ml-1 text-muted-foreground">({cell.meta})</span>}
                            {truncated && <span className="ml-1 text-muted-foreground">…</span>}
                        </td>
                    ))}
                </tr>
            ))}
            {rows.length === 0 && (
                <tr>
                    <td colSpan={columns.length + 1} className="px-3 py-6 text-center text-muted-foreground">
                        {emptyText}
                    </td>
                </tr>
            )}
        </tbody>
    </table>
);

const CELL_WIDTHS = ["w-24", "w-40", "w-28", "w-48", "w-20", "w-32"];

/** Placeholder table with the same structure as the real grid (row numbers, header, cells) while rows load. */
export const RowsTableSkeleton: React.FC<{ columnCount?: number; rowCount?: number }> = ({ columnCount = 6, rowCount = 14 }) => (
    <table role="status" aria-busy="true" className="w-max min-w-full text-xs border-separate border-spacing-0">
        <caption className="sr-only">Loading rows</caption>
        <thead>
            <tr>
                <th className="bg-card border-b px-2 py-3">
                    <Skeleton className="h-3 w-4 ml-auto" />
                </th>
                {Array.from({ length: columnCount }, (_, column) => (
                    <th key={column} className="bg-card border-b px-3 py-3 text-left">
                        <Skeleton className={cn("h-3.5", CELL_WIDTHS[(column + 2) % CELL_WIDTHS.length])} />
                    </th>
                ))}
            </tr>
        </thead>
        <tbody>
            {Array.from({ length: rowCount }, (_, row) => (
                <tr key={row}>
                    <td className="border-b px-2 py-3">
                        <Skeleton className="h-3 w-4 ml-auto" />
                    </td>
                    {Array.from({ length: columnCount }, (_, column) => (
                        <td key={column} className="border-b px-3 py-3 min-w-36">
                            <Skeleton className={cn("h-3", CELL_WIDTHS[(row + column) % CELL_WIDTHS.length])} />
                        </td>
                    ))}
                </tr>
            ))}
        </tbody>
    </table>
);
