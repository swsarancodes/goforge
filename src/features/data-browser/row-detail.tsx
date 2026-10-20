import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronLeft, ChevronRight, Copy, KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DataBrowser } from "./use-data-browser";

/** Every column of one row in full, replacing the grid in place (no overlay on top of the page). */
const RowDetail: React.FC<{ browser: DataBrowser }> = ({ browser }) => {
    const { t } = useTranslation();
    const { page, detailRow, formatted, selected, setDetailRow, copyText, copyRowAsJson } = browser;

    if (!page || detailRow === undefined || !formatted[detailRow]) return null;

    return (
        <>
            <div className="flex items-center gap-2 px-3 py-2 min-w-0 shrink-0">
                <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0" onClick={() => setDetailRow(undefined)}>
                    <ArrowLeft className="size-4" /> {t("data_browser.back", { defaultValue: "Rows" })}
                </Button>
                <span className="text-sm font-medium truncate">
                    {t("data_browser.row", { defaultValue: "Row" })} {(page.offset + detailRow + 1).toLocaleString()}
                    {selected && (
                        <span className="font-normal text-muted-foreground">
                            {" "}
                            · {selected.schema}.{selected.name}
                        </span>
                    )}
                </span>
                <div className="ml-auto flex items-center gap-1 shrink-0">
                    <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setDetailRow(detailRow - 1)}
                        disabled={detailRow === 0}
                        aria-label={t("data_browser.prev_row", { defaultValue: "Previous row" })}
                    >
                        <ChevronLeft className="size-4" />
                    </Button>
                    <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setDetailRow(detailRow + 1)}
                        disabled={detailRow >= page.rows.length - 1}
                        aria-label={t("data_browser.next_row", { defaultValue: "Next row" })}
                    >
                        <ChevronRight className="size-4" />
                    </Button>
                    <Button variant="outline" size="sm" className="h-7" onClick={() => copyRowAsJson(detailRow)}>
                        <Copy className="size-3.5" /> JSON
                    </Button>
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto border-t px-3 py-3 space-y-4">
                {page.columns.map((column, columnIndex) => {
                    const { cell, truncated } = formatted[detailRow][columnIndex];
                    return (
                        <div key={column.name} className="space-y-1 min-w-0 max-w-4xl">
                            <div className="flex items-center gap-2 min-w-0">
                                {column.isPrimaryKey && <KeyRound className="size-3 shrink-0 text-muted-foreground" />}
                                <span className="text-sm font-medium truncate">{column.name}</span>
                                <Badge variant="outline" className="shrink-0">
                                    {column.dataType}
                                </Badge>
                                {cell.meta && <span className="text-xs text-muted-foreground shrink-0">{cell.meta}</span>}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="ml-auto h-6 px-1.5"
                                    onClick={() => copyText(page.rows[detailRow][columnIndex] ?? "")}
                                    disabled={page.rows[detailRow][columnIndex] === null}
                                    aria-label={t("data_browser.copy", { defaultValue: "Copy value" })}
                                >
                                    <Copy className="size-3.5" />
                                </Button>
                            </div>
                            <pre
                                className={cn(
                                    "rounded-md border bg-muted/40 p-2 text-xs font-mono whitespace-pre-wrap break-all max-h-64 overflow-auto",
                                    (cell.kind === "null" || cell.full === "") && "text-muted-foreground",
                                    cell.kind === "null" && "italic",
                                )}
                            >
                                {cell.kind !== "null" && cell.full === "" ? '""' : cell.full}
                            </pre>
                            {truncated && (
                                <p className="text-xs text-muted-foreground">
                                    {t("data_browser.truncated", { defaultValue: "Long value - only the first 4,000 characters are shown." })}
                                </p>
                            )}
                        </div>
                    );
                })}
            </div>
        </>
    );
};

export default RowDetail;
