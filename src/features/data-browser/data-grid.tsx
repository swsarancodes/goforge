import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircleIcon, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Database, KeyRound, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import RowDetail from "./row-detail";
import { PAGE_SIZES, type DataBrowser } from "./use-data-browser";

interface DataGridProps {
    browser: DataBrowser;
    /** Rendered at the start of the toolbar: the list collapse toggle (desktop) or the "Tables" button (mobile). */
    toolbarStart?: React.ReactNode;
}

const CELL_WIDTHS = ["w-24", "w-40", "w-28", "w-48", "w-20", "w-32"];

/** True once `active` has stayed true for `delayMs`, so fast reloads don't flash a skeleton. */
function useDelayedFlag(active: boolean, delayMs: number): boolean {
    const [flag, setFlag] = useState<boolean>(false);
    useEffect(() => {
        if (!active) {
            setFlag(false);
            return;
        }
        const id = setTimeout(() => setFlag(true), delayMs);
        return () => clearTimeout(id);
    }, [active, delayMs]);
    return flag;
}

/** Placeholder table with the same structure as the real grid (row numbers, header, cells) while rows load. */
const GridSkeleton: React.FC<{ columnCount?: number; rowCount?: number }> = ({ columnCount = 6, rowCount = 14 }) => (
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

/** Toolbar, rows grid and pager for the selected table or view (or the row detail view). */
const DataGrid: React.FC<DataGridProps> = ({ browser, toolbarStart }) => {
    const { t } = useTranslation();
    const { page, formatted, selected, sort, error } = browser;

    const isBusy = browser.isLoadingConnections || browser.isLoadingRelations;
    // First load of a table: skeleton right away. Reloading one that is already on screen (sort, page, refresh):
    // keep the rows, dimmed, and only swap in the skeleton if it turns out to be slow.
    const isSlowReload = useDelayedFlag(browser.isLoadingPage && !!page, 200);
    const showSkeleton = browser.isLoadingPage && (!page || isSlowReload);

    return (
        <div className="flex flex-col h-full min-h-0 min-w-0 bg-background">
            <div className="flex items-center gap-2 px-3 h-12 shrink-0 border-b min-w-0">
                {toolbarStart}
                {selected ? (
                    <>
                        <span className="font-medium text-sm truncate" title={`${selected.schema}.${selected.name}`}>
                            {selected.schema}.{selected.name}
                        </span>
                        {selected.kind !== "table" && <Badge variant="outline">{selected.kind}</Badge>}
                        <Button
                            variant="ghost"
                            size="icon"
                            className="ml-auto h-8 w-8 shrink-0"
                            onClick={browser.refreshPage}
                            disabled={browser.isLoadingPage}
                            aria-label={t("data_browser.refresh", { defaultValue: "Refresh" })}
                            title={t("data_browser.refresh", { defaultValue: "Refresh" })}
                        >
                            <RefreshCw className={cn("size-4", browser.isLoadingPage && "animate-spin")} />
                        </Button>
                    </>
                ) : (
                    <span className="text-sm text-muted-foreground">{t("data_browser.title", { defaultValue: "Data" })}</span>
                )}
            </div>

            {error && (
                <p className="text-destructive text-sm flex items-start gap-1 break-words p-3 shrink-0">
                    <AlertCircleIcon className="size-4 shrink-0 mt-0.5" /> <span className="min-w-0">{error}</span>
                </p>
            )}

            {!selected && isBusy && (
                <div className="flex-1 min-h-0 overflow-hidden">
                    <GridSkeleton />
                </div>
            )}

            {!selected && !isBusy && (
                <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
                    <Database className="size-8 opacity-40" />
                    <p className="text-sm">
                        {browser.relations.length > 0
                            ? t("data_browser.pick_relation_hint", { defaultValue: "Pick a table or view to see its rows." })
                            : browser.connections.length === 0
                              ? t("data_browser.no_connections_hint", { defaultValue: "No saved connections yet. Add one from File > Connect Live Database." })
                              : t("data_browser.pick_connection_hint", { defaultValue: "Pick a connection to list its tables." })}
                    </p>
                </div>
            )}

            {selected && browser.showingDetail && <RowDetail browser={browser} />}

            {selected && !browser.showingDetail && (
                <>
                    <div className={cn("flex-1 min-h-0 overflow-auto transition-opacity", browser.isLoadingPage && page && !isSlowReload && "opacity-60")}>
                        {showSkeleton && <GridSkeleton columnCount={page ? Math.min(page.columns.length, 10) : 6} rowCount={page ? Math.min(Math.max(page.rows.length, 8), 20) : 14} />}
                        {!showSkeleton && page && (
                            <table className="w-max min-w-full text-xs border-separate border-spacing-0">
                                <thead>
                                    <tr>
                                        <th className="sticky top-0 z-10 bg-card border-b px-2 py-2 text-right font-normal text-muted-foreground">#</th>
                                        {page.columns.map((column) => {
                                            const active = sort?.column === column.name;
                                            return (
                                                <th key={column.name} className="sticky top-0 z-10 bg-card border-b p-0 text-left font-medium whitespace-nowrap">
                                                    <button
                                                        type="button"
                                                        onClick={() => browser.sortBy(column.name)}
                                                        className="flex w-full items-center gap-1 px-3 py-2 text-left hover:bg-accent"
                                                        title={`${column.name} (${column.dataType})`}
                                                    >
                                                        {column.isPrimaryKey && <KeyRound className="size-3 shrink-0 text-muted-foreground" />}
                                                        <span>{column.name}</span>
                                                        <span className="font-normal text-muted-foreground">{column.dataType}</span>
                                                        {active && sort?.dir === "asc" ? (
                                                            <ArrowUp className="size-3 shrink-0" />
                                                        ) : active && sort?.dir === "desc" ? (
                                                            <ArrowDown className="size-3 shrink-0" />
                                                        ) : (
                                                            <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground/50" />
                                                        )}
                                                    </button>
                                                </th>
                                            );
                                        })}
                                    </tr>
                                </thead>
                                <tbody>
                                    {formatted.map((row, rowIndex) => (
                                        <tr key={rowIndex} className="hover:bg-accent/50 cursor-pointer" onClick={() => browser.setDetailRow(rowIndex)}>
                                            <td className="border-b px-2 py-1.5 text-right text-muted-foreground tabular-nums">{page.offset + rowIndex + 1}</td>
                                            {row.map(({ cell, truncated }, columnIndex) => (
                                                <td
                                                    key={columnIndex}
                                                    title={cell.kind === "null" ? "SQL NULL" : cell.full.slice(0, 500)}
                                                    className={cn(
                                                        "border-b px-3 py-1.5 max-w-[360px] truncate font-mono",
                                                        cell.align === "right" && "text-right",
                                                        cell.kind === "null" && "italic text-muted-foreground",
                                                    )}
                                                >
                                                    {/* An empty string is a value, not NULL: make it visible. */}
                                                    {cell.kind !== "null" && cell.full === "" ? <span className="text-muted-foreground">""</span> : cell.display}
                                                    {cell.meta && <span className="ml-1 text-muted-foreground">({cell.meta})</span>}
                                                    {truncated && <span className="ml-1 text-muted-foreground">…</span>}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                    {formatted.length === 0 && (
                                        <tr>
                                            <td colSpan={page.columns.length + 1} className="px-3 py-6 text-center text-muted-foreground">
                                                {t("data_browser.empty", { defaultValue: "This table has no rows." })}
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        )}
                    </div>

                    {showSkeleton && !page && (
                        <div className="flex items-center justify-between gap-2 px-3 py-3 border-t shrink-0" aria-hidden="true">
                            <Skeleton className="h-3.5 w-40" />
                            <div className="flex items-center gap-1">
                                <Skeleton className="h-8 w-[110px]" />
                                <Skeleton className="size-8" />
                                <Skeleton className="size-8" />
                            </div>
                        </div>
                    )}

                    {page && (
                        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground border-t shrink-0">
                            <span>
                                {page.rows.length > 0 ? `${(page.offset + 1).toLocaleString()}–${(page.offset + page.rows.length).toLocaleString()}` : "0"}
                                {browser.total !== null && (
                                    <>
                                        {" "}
                                        {t("data_browser.of", { defaultValue: "of" })} {browser.exactTotal === undefined ? "~" : ""}
                                        {browser.total.toLocaleString()}
                                        {browser.exactTotal === undefined ? ` (${t("data_browser.estimate", { defaultValue: "estimate" })})` : ""}
                                    </>
                                )}
                                {browser.exactTotal === undefined && (
                                    <Button variant="link" size="sm" className="h-auto p-0 ml-2 text-xs" onClick={browser.countExactly} disabled={browser.isLoadingPage}>
                                        {t("data_browser.count_exactly", { defaultValue: "Count exactly" })}
                                    </Button>
                                )}
                            </span>
                            <div className="flex items-center gap-1">
                                <Select value={String(browser.pageSize)} onValueChange={(value) => browser.changePageSize(Number(value))}>
                                    <SelectTrigger size="sm" className="h-8 w-[110px] text-xs" aria-label={t("data_browser.rows_per_page", { defaultValue: "Rows per page" })}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {PAGE_SIZES.map((size) => (
                                            <SelectItem key={size} value={String(size)}>
                                                {size} {t("data_browser.per_page", { defaultValue: "/ page" })}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={() => browser.goToOffset(page.offset - page.limit)}
                                    disabled={browser.isLoadingPage || page.offset === 0}
                                    aria-label={t("data_browser.prev", { defaultValue: "Previous page" })}
                                >
                                    <ChevronLeft className="size-4" />
                                </Button>
                                <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={() => browser.goToOffset(page.offset + page.limit)}
                                    disabled={browser.isLoadingPage || !browser.canGoNext}
                                    aria-label={t("data_browser.next", { defaultValue: "Next page" })}
                                >
                                    <ChevronRight className="size-4" />
                                </Button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default DataGrid;
