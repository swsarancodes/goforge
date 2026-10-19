import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal, { ModalProps } from "@/components/modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AlertCircleIcon, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Copy, Eye, KeyRound, Loader2, Table2 } from "lucide-react";
import useToast from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
    SavedConnection,
    TableDataPage,
    fetchTableRows,
    introspectSavedConnection,
    listSavedConnections,
} from "@/lib/live-connection-api";
import { formatCell } from "@/utils/data-view/format-cell";

const PAGE_SIZES = [50, 100, 250, 500];
const DEFAULT_PAGE_SIZE = 100;

interface Relation {
    key: string;
    schema: string;
    name: string;
    kind: "table" | "view" | "materialized view";
}

type SortState = { column: string; dir: "asc" | "desc" } | undefined;

const relationKey = (schema: string, name: string) => `${schema}\u001f${name}`;

const BrowseLiveDataModal: React.FC<ModalProps> = (props) => {
    const { t } = useTranslation();
    const raise = useToast();
    const { isOpen, onOpenChange } = props;

    const [connections, setConnections] = useState<SavedConnection[]>([]);
    const [connectionId, setConnectionId] = useState<string | undefined>(undefined);
    const [relations, setRelations] = useState<Relation[]>([]);
    const [isLoadingRelations, setIsLoadingRelations] = useState<boolean>(false);
    const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
    const [filter, setFilter] = useState<string>("");

    const [page, setPage] = useState<TableDataPage | undefined>(undefined);
    const [exactTotal, setExactTotal] = useState<number | undefined>(undefined);
    const [isLoadingPage, setIsLoadingPage] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>(undefined);

    const [sort, setSort] = useState<SortState>(undefined);
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
    const [detailRow, setDetailRow] = useState<number | undefined>(undefined);

    // Ignore responses from requests that were superseded (fast clicking between tables/pages).
    const latestRequest = useRef<number>(0);

    const selected = useMemo(() => relations.find((relation) => relation.key === selectedKey), [relations, selectedKey]);

    const resetData = useCallback(() => {
        latestRequest.current++;
        setPage(undefined);
        setExactTotal(undefined);
        setError(undefined);
        setSort(undefined);
        setDetailRow(undefined);
        setIsLoadingPage(false);
    }, []);

    const loadPage = useCallback(
        async (args: { connectionId: string; relation: Relation; sort: SortState; offset: number; pageSize: number; exactCount?: boolean }) => {
            const requestId = ++latestRequest.current;
            setIsLoadingPage(true);
            setError(undefined);
            try {
                const result = await fetchTableRows(args.connectionId, {
                    schema: args.relation.schema,
                    table: args.relation.name,
                    limit: args.pageSize,
                    offset: args.offset,
                    sort: args.sort?.column,
                    dir: args.sort?.dir,
                    exactCount: args.exactCount,
                });
                if (requestId !== latestRequest.current) return;
                setPage(result);
                if (result.exactTotal !== undefined) setExactTotal(result.exactTotal);
            } catch (err) {
                if (requestId !== latestRequest.current) return;
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                if (requestId === latestRequest.current) setIsLoadingPage(false);
            }
        },
        [],
    );

    const onConnectionChange = useCallback(
        async (id: string) => {
            setConnectionId(id);
            setRelations([]);
            setSelectedKey(undefined);
            setFilter("");
            resetData();
            setIsLoadingRelations(true);
            try {
                const introspection = await introspectSavedConnection(id);
                // information_schema.columns also lists plain views, so introspection reports them as both a
                // table and a view: key by schema+name and let the view entry win.
                const byKey = new Map<string, Relation>();
                for (const table of introspection.tables) {
                    const schema = table.namespace ?? "public";
                    byKey.set(relationKey(schema, table.name), { key: relationKey(schema, table.name), schema, name: table.name, kind: "table" });
                }
                for (const view of introspection.views ?? []) {
                    const schema = view.namespace ?? "public";
                    byKey.set(relationKey(schema, view.name), {
                        key: relationKey(schema, view.name),
                        schema,
                        name: view.name,
                        kind: view.materialized ? "materialized view" : "view",
                    });
                }
                setRelations(Array.from(byKey.values()).sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name)));
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setIsLoadingRelations(false);
            }
        },
        [resetData],
    );

    useEffect(() => {
        if (!isOpen) {
            // Rows are only ever held in memory while the modal is open.
            resetData();
            setRelations([]);
            setSelectedKey(undefined);
            setConnectionId(undefined);
            return;
        }
        listSavedConnections()
            .then((list) => {
                setConnections(list);
                if (list.length === 1) onConnectionChange(list[0].id);
            })
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, [isOpen, onConnectionChange, resetData]);

    const onSelectRelation = useCallback(
        (key: string) => {
            const relation = relations.find((candidate) => candidate.key === key);
            if (!connectionId || !relation) return;
            setSelectedKey(key);
            resetData();
            loadPage({ connectionId, relation, sort: undefined, offset: 0, pageSize });
        },
        [relations, connectionId, pageSize, resetData, loadPage],
    );

    const onSort = useCallback(
        (column: string) => {
            if (!connectionId || !selected) return;
            // none -> asc -> desc -> none
            const next: SortState = sort?.column !== column ? { column, dir: "asc" } : sort.dir === "asc" ? { column, dir: "desc" } : undefined;
            setSort(next);
            setDetailRow(undefined);
            loadPage({ connectionId, relation: selected, sort: next, offset: 0, pageSize });
        },
        [connectionId, selected, sort, pageSize, loadPage],
    );

    const goToOffset = useCallback(
        (offset: number) => {
            if (!connectionId || !selected) return;
            setDetailRow(undefined);
            loadPage({ connectionId, relation: selected, sort, offset: Math.max(0, offset), pageSize });
        },
        [connectionId, selected, sort, pageSize, loadPage],
    );

    const onPageSizeChange = useCallback(
        (value: string) => {
            const size = Number(value);
            setPageSize(size);
            if (!connectionId || !selected) return;
            setDetailRow(undefined);
            loadPage({ connectionId, relation: selected, sort, offset: 0, pageSize: size });
        },
        [connectionId, selected, sort, loadPage],
    );

    const onCountExactly = useCallback(() => {
        if (!connectionId || !selected || !page) return;
        loadPage({ connectionId, relation: selected, sort, offset: page.offset, pageSize, exactCount: true });
    }, [connectionId, selected, page, sort, pageSize, loadPage]);

    const copyText = useCallback(
        async (text: string) => {
            try {
                await navigator.clipboard.writeText(text);
                raise(t("modals.browse_live_data.copied", { defaultValue: "Copied" }), "", "SUCCESS");
            } catch {
                raise(t("modals.browse_live_data.copy_failed", { defaultValue: "Couldn't copy" }), t("modals.browse_live_data.copy_failed_hint", { defaultValue: "The browser blocked clipboard access." }), "ERROR");
            }
        },
        [raise, t],
    );

    const formatted = useMemo(() => {
        if (!page) return [];
        const columnCount = page.columns.length;
        const truncated = new Set(page.truncatedCells.map(([row, column]) => row * columnCount + column));
        return page.rows.map((row, rowIndex) =>
            row.map((value, columnIndex) => ({
                cell: formatCell(page.columns[columnIndex].dataType, value, truncated.has(rowIndex * columnCount + columnIndex)),
                truncated: truncated.has(rowIndex * columnCount + columnIndex),
            })),
        );
    }, [page]);

    const visibleRelations = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        return needle ? relations.filter((relation) => `${relation.schema}.${relation.name}`.toLowerCase().includes(needle)) : relations;
    }, [relations, filter]);

    const groupedRelations = useMemo(() => {
        const groups = new Map<string, Relation[]>();
        for (const relation of visibleRelations) {
            const list = groups.get(relation.schema) ?? [];
            list.push(relation);
            groups.set(relation.schema, list);
        }
        return Array.from(groups.entries());
    }, [visibleRelations]);

    const total = exactTotal ?? page?.estimatedTotal ?? null;
    const canGoNext = !!page && page.rows.length === page.limit && (exactTotal === undefined || page.offset + page.limit < exactTotal);

    const copyRowAsJson = useCallback(
        (rowIndex: number) => {
            if (!page) return;
            const record = Object.fromEntries(page.columns.map((column, index) => [column.name, page.rows[rowIndex][index]]));
            copyText(JSON.stringify(record, null, 2));
        },
        [page, copyText],
    );

    return (
        <Modal
            {...props}
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title={t("modals.browse_live_data.title", { defaultValue: "Browse Live Data" })}
            description={t("modals.browse_live_data.description", { defaultValue: "Read-only view of the rows in a table or view on a saved PostgreSQL connection." })}
            className="w-full lg:min-w-0 sm:max-w-[min(1100px,calc(100vw-2rem))] max-h-[92vh] overflow-y-auto overflow-x-hidden grid-cols-[minmax(0,1fr)]"
            footer={false}
        >
            <div className="flex flex-col gap-3 min-w-0">
                <div className="space-y-1 min-w-0">
                    <Label>{t("modals.browse_live_data.connection", { defaultValue: "Connection" })}</Label>
                    <Select value={connectionId} onValueChange={onConnectionChange}>
                        <SelectTrigger className="w-full min-w-0">
                            <SelectValue
                                placeholder={
                                    connections.length === 0
                                        ? t("modals.connect_live_database.no_connections")
                                        : t("modals.browse_live_data.pick_connection", { defaultValue: "Pick a connection" })
                                }
                            />
                        </SelectTrigger>
                        <SelectContent>
                            {connections.map((conn) => (
                                <SelectItem key={conn.id} value={conn.id}>
                                    {conn.name} ({conn.host}:{conn.port}/{conn.database})
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {error && (
                    <p className="text-destructive text-sm flex items-start gap-1 break-words">
                        <AlertCircleIcon className="size-4 shrink-0 mt-0.5" /> <span className="min-w-0">{error}</span>
                    </p>
                )}

                {isLoadingRelations && (
                    <p className="text-sm text-muted-foreground flex items-center gap-1">
                        <Loader2 className="size-4 animate-spin" /> {t("modals.loading")}
                    </p>
                )}

                {connectionId && !isLoadingRelations && relations.length === 0 && !error && (
                    <p className="text-sm text-muted-foreground">{t("modals.browse_live_data.no_relations", { defaultValue: "No tables or views found in this database." })}</p>
                )}

                {relations.length > 0 && (
                    <div className="flex flex-col md:flex-row gap-3 min-w-0">
                        {/* Narrow screens: compact picker */}
                        <div className="md:hidden space-y-1 min-w-0">
                            <Label>{t("modals.browse_live_data.relation", { defaultValue: "Table or view" })}</Label>
                            <Select value={selectedKey} onValueChange={onSelectRelation}>
                                <SelectTrigger className="w-full min-w-0">
                                    <SelectValue placeholder={t("modals.browse_live_data.pick_relation", { defaultValue: "Pick a table or view" })} />
                                </SelectTrigger>
                                <SelectContent>
                                    {relations.map((relation) => (
                                        <SelectItem key={relation.key} value={relation.key}>
                                            {relation.schema}.{relation.name}
                                            {relation.kind !== "table" ? ` (${relation.kind})` : ""}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {/* Wider screens: searchable list */}
                        <div className="hidden md:flex flex-col gap-2 w-60 shrink-0 min-w-0">
                            <Input
                                value={filter}
                                onChange={(e) => setFilter(e.target.value)}
                                placeholder={t("modals.browse_live_data.filter", { defaultValue: "Filter tables and views..." })}
                            />
                            <div className="max-h-[55vh] overflow-y-auto overflow-x-hidden rounded-md border">
                                {groupedRelations.length === 0 && (
                                    <p className="p-3 text-sm text-muted-foreground">{t("modals.browse_live_data.no_matches", { defaultValue: "No matches." })}</p>
                                )}
                                {groupedRelations.map(([schema, list]) => (
                                    <div key={schema} className="p-1">
                                        <p className="px-2 pt-1 pb-0.5 text-[11px] uppercase tracking-wide text-muted-foreground truncate">{schema}</p>
                                        {list.map((relation) => (
                                            <button
                                                key={relation.key}
                                                type="button"
                                                onClick={() => onSelectRelation(relation.key)}
                                                title={`${relation.schema}.${relation.name} (${relation.kind})`}
                                                className={cn(
                                                    "w-full flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent min-w-0",
                                                    relation.key === selectedKey && "bg-accent font-medium",
                                                )}
                                            >
                                                {relation.kind === "table" ? <Table2 className="size-3.5 shrink-0 text-muted-foreground" /> : <Eye className="size-3.5 shrink-0 text-muted-foreground" />}
                                                <span className="truncate">{relation.name}</span>
                                            </button>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Data */}
                        <div className="flex-1 min-w-0 flex flex-col gap-2">
                            {!selected && (
                                <p className="text-sm text-muted-foreground">{t("modals.browse_live_data.pick_relation", { defaultValue: "Pick a table or view" })}</p>
                            )}

                            {selected && (
                                <>
                                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                                        <span className="font-medium truncate">
                                            {selected.schema}.{selected.name}
                                        </span>
                                        {selected.kind !== "table" && <Badge variant="outline">{selected.kind}</Badge>}
                                        {isLoadingPage && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                                    </div>

                                    {page && (
                                        <div className="rounded-md border overflow-auto max-h-[42vh] md:max-h-[55vh] min-w-0">
                                            <table className="w-max min-w-full text-xs border-separate border-spacing-0">
                                                <thead>
                                                    <tr>
                                                        <th className="sticky top-0 z-10 bg-background border-b px-2 py-2 text-right font-normal text-muted-foreground">#</th>
                                                        {page.columns.map((column) => {
                                                            const active = sort?.column === column.name;
                                                            return (
                                                                <th key={column.name} className="sticky top-0 z-10 bg-background border-b p-0 text-left font-medium whitespace-nowrap">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => onSort(column.name)}
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
                                                        <tr key={rowIndex} className="hover:bg-accent/50 cursor-pointer" onClick={() => setDetailRow(rowIndex)}>
                                                            <td className="border-b px-2 py-1.5 text-right text-muted-foreground tabular-nums">{page.offset + rowIndex + 1}</td>
                                                            {row.map(({ cell, truncated }, columnIndex) => (
                                                                <td
                                                                    key={columnIndex}
                                                                    title={cell.kind === "null" ? "SQL NULL" : cell.full.slice(0, 500)}
                                                                    className={cn(
                                                                        "border-b px-3 py-1.5 max-w-[320px] truncate font-mono",
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
                                                                {t("modals.browse_live_data.empty", { defaultValue: "This table has no rows." })}
                                                            </td>
                                                        </tr>
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}

                                    {page && (
                                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                                            <span>
                                                {page.rows.length > 0 ? `${(page.offset + 1).toLocaleString()}–${(page.offset + page.rows.length).toLocaleString()}` : "0"}
                                                {total !== null && (
                                                    <>
                                                        {" "}
                                                        {t("modals.browse_live_data.of", { defaultValue: "of" })} {exactTotal === undefined ? "~" : ""}
                                                        {total.toLocaleString()}
                                                        {exactTotal === undefined ? ` (${t("modals.browse_live_data.estimate", { defaultValue: "estimate" })})` : ""}
                                                    </>
                                                )}
                                                {exactTotal === undefined && (
                                                    <Button variant="link" size="sm" className="h-auto p-0 ml-2 text-xs" onClick={onCountExactly} disabled={isLoadingPage}>
                                                        {t("modals.browse_live_data.count_exactly", { defaultValue: "Count exactly" })}
                                                    </Button>
                                                )}
                                            </span>
                                            <div className="flex items-center gap-1">
                                                <Select value={String(pageSize)} onValueChange={onPageSizeChange}>
                                                    <SelectTrigger className="h-8 w-[110px] text-xs" aria-label={t("modals.browse_live_data.rows_per_page", { defaultValue: "Rows per page" })}>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {PAGE_SIZES.map((size) => (
                                                            <SelectItem key={size} value={String(size)}>
                                                                {size} {t("modals.browse_live_data.per_page", { defaultValue: "/ page" })}
                                                            </SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                                <Button variant="outline" size="sm" onClick={() => goToOffset(page.offset - page.limit)} disabled={isLoadingPage || page.offset === 0} aria-label={t("modals.browse_live_data.prev", { defaultValue: "Previous page" })}>
                                                    <ChevronLeft className="size-4" />
                                                </Button>
                                                <Button variant="outline" size="sm" onClick={() => goToOffset(page.offset + page.limit)} disabled={isLoadingPage || !canGoNext} aria-label={t("modals.browse_live_data.next", { defaultValue: "Next page" })}>
                                                    <ChevronRight className="size-4" />
                                                </Button>
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <Sheet open={detailRow !== undefined} onOpenChange={(open) => !open && setDetailRow(undefined)}>
                <SheetContent className="w-full sm:max-w-lg">
                    {page && detailRow !== undefined && (
                        <>
                            <SheetHeader className="pr-10">
                                <SheetTitle>
                                    {t("modals.browse_live_data.row", { defaultValue: "Row" })} {(page.offset + detailRow + 1).toLocaleString()}
                                </SheetTitle>
                                <SheetDescription className="truncate">
                                    {selected ? `${selected.schema}.${selected.name}` : ""}
                                </SheetDescription>
                                <div>
                                    <Button variant="outline" size="sm" onClick={() => copyRowAsJson(detailRow)}>
                                        <Copy className="size-4" /> {t("modals.browse_live_data.copy_row", { defaultValue: "Copy row as JSON" })}
                                    </Button>
                                </div>
                            </SheetHeader>
                            <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
                                {page.columns.map((column, columnIndex) => {
                                    const { cell, truncated } = formatted[detailRow][columnIndex];
                                    return (
                                        <div key={column.name} className="space-y-1 min-w-0">
                                            <div className="flex items-center gap-2 min-w-0">
                                                {column.isPrimaryKey && <KeyRound className="size-3 shrink-0 text-muted-foreground" />}
                                                <span className="text-sm font-medium truncate">{column.name}</span>
                                                <Badge variant="outline" className="shrink-0">{column.dataType}</Badge>
                                                {cell.meta && <span className="text-xs text-muted-foreground shrink-0">{cell.meta}</span>}
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="ml-auto h-6 px-1.5"
                                                    onClick={() => copyText(page.rows[detailRow][columnIndex] ?? "")}
                                                    disabled={page.rows[detailRow][columnIndex] === null}
                                                    aria-label={t("modals.browse_live_data.copy", { defaultValue: "Copy value" })}
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
                                                    {t("modals.browse_live_data.truncated", { defaultValue: "Long value - only the first 4,000 characters are shown." })}
                                                </p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </SheetContent>
            </Sheet>
        </Modal>
    );
};

export default BrowseLiveDataModal;
