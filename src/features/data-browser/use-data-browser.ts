import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useToast from "@/hooks/use-toast";
import { SavedConnection, TableDataPage, fetchTableRows, introspectSavedConnection, listSavedConnections } from "@/lib/live-connection-api";
import { FormattedCell, formatCell } from "@/utils/data-view/format-cell";
import { Relation, buildRelations } from "@/utils/data-view/relations";

export const PAGE_SIZES = [50, 100, 250, 500];
const DEFAULT_PAGE_SIZE = 100;

export type SortState = { column: string; dir: "asc" | "desc" } | undefined;

export interface FormattedRowCell {
    cell: FormattedCell;
    truncated: boolean;
}

interface Remembered {
    connectionId?: string;
    relationKey?: string;
    sort?: SortState;
    pageSize?: number;
}

// Leaving the page (or switching sidebar tabs) unmounts it; keep the last selection so coming back doesn't
// mean picking the connection and table again. Rows themselves are always re-fetched.
let remembered: Remembered = {};
const relationsCache = new Map<string, Relation[]>();

async function fetchRelations(connectionId: string): Promise<Relation[]> {
    return buildRelations(await introspectSavedConnection(connectionId));
}

export type DataBrowser = ReturnType<typeof useDataBrowser>;

/** State and actions behind the Data page: connection, table list, one page of rows, sorting, paging, row detail. */
export function useDataBrowser() {
    const { t } = useTranslation();
    const raise = useToast();

    const restore = useRef<Remembered>(remembered);

    const [connections, setConnections] = useState<SavedConnection[]>([]);
    const [isLoadingConnections, setIsLoadingConnections] = useState<boolean>(true);
    const [connectionId, setConnectionId] = useState<string | undefined>(undefined);
    const [relations, setRelations] = useState<Relation[]>([]);
    const [isLoadingRelations, setIsLoadingRelations] = useState<boolean>(false);
    const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);

    const [page, setPage] = useState<TableDataPage | undefined>(undefined);
    const [exactTotal, setExactTotal] = useState<number | undefined>(undefined);
    const [isLoadingPage, setIsLoadingPage] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>(undefined);

    const [sort, setSort] = useState<SortState>(undefined);
    const [pageSize, setPageSize] = useState<number>(restore.current.pageSize ?? DEFAULT_PAGE_SIZE);
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

    const changeConnection = useCallback(
        async (id: string, previous?: Remembered) => {
            setConnectionId(id);
            setRelations([]);
            setSelectedKey(undefined);
            resetData();
            setIsLoadingRelations(true);
            try {
                // Coming back (previous set) reuses the last list; picking a connection re-reads it.
                const found = (previous && relationsCache.get(id)) || (await fetchRelations(id));
                relationsCache.set(id, found);
                setRelations(found);

                const again = previous?.relationKey ? found.find((relation) => relation.key === previous.relationKey) : undefined;
                if (again) {
                    setSelectedKey(again.key);
                    setSort(previous?.sort);
                    loadPage({ connectionId: id, relation: again, sort: previous?.sort, offset: 0, pageSize: previous?.pageSize ?? DEFAULT_PAGE_SIZE });
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setIsLoadingRelations(false);
            }
        },
        [resetData, loadPage],
    );

    useEffect(() => {
        listSavedConnections()
            .then((list) => {
                setConnections(list);
                const previous = restore.current;
                const id = list.find((conn) => conn.id === previous.connectionId)?.id ?? (list.length === 1 ? list[0].id : undefined);
                if (id) changeConnection(id, id === previous.connectionId ? previous : undefined);
            })
            .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setIsLoadingConnections(false));
        return () => {
            // Late responses must not touch state after the page is gone.
            latestRequest.current++;
        };
    }, [changeConnection]);

    useEffect(() => {
        remembered = { connectionId, relationKey: selectedKey, sort, pageSize };
    }, [connectionId, selectedKey, sort, pageSize]);

    /** Re-reads the table list for the current connection, keeping the open table if it still exists. */
    const refreshRelations = useCallback(async () => {
        if (!connectionId) return;
        setIsLoadingRelations(true);
        try {
            const found = await fetchRelations(connectionId);
            relationsCache.set(connectionId, found);
            setRelations(found);
            if (selectedKey && !found.some((relation) => relation.key === selectedKey)) {
                setSelectedKey(undefined);
                resetData();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsLoadingRelations(false);
        }
    }, [connectionId, selectedKey, resetData]);

    const selectRelation = useCallback(
        (key: string) => {
            const relation = relations.find((candidate) => candidate.key === key);
            if (!connectionId || !relation) return;
            setSelectedKey(key);
            resetData();
            loadPage({ connectionId, relation, sort: undefined, offset: 0, pageSize });
        },
        [relations, connectionId, pageSize, resetData, loadPage],
    );

    const sortBy = useCallback(
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

    const changePageSize = useCallback(
        (size: number) => {
            setPageSize(size);
            if (!connectionId || !selected) return;
            setDetailRow(undefined);
            loadPage({ connectionId, relation: selected, sort, offset: 0, pageSize: size });
        },
        [connectionId, selected, sort, loadPage],
    );

    const countExactly = useCallback(() => {
        if (!connectionId || !selected || !page) return;
        loadPage({ connectionId, relation: selected, sort, offset: page.offset, pageSize, exactCount: true });
    }, [connectionId, selected, page, sort, pageSize, loadPage]);

    const refreshPage = useCallback(() => {
        if (!connectionId || !selected) return;
        loadPage({ connectionId, relation: selected, sort, offset: page?.offset ?? 0, pageSize, exactCount: exactTotal !== undefined });
    }, [connectionId, selected, sort, page, pageSize, exactTotal, loadPage]);

    const copyText = useCallback(
        async (text: string) => {
            try {
                await navigator.clipboard.writeText(text);
                raise(t("data_browser.copied", { defaultValue: "Copied" }), "", "SUCCESS");
            } catch {
                raise(
                    t("data_browser.copy_failed", { defaultValue: "Couldn't copy" }),
                    t("data_browser.copy_failed_hint", { defaultValue: "The browser blocked clipboard access." }),
                    "ERROR",
                );
            }
        },
        [raise, t],
    );

    const formatted = useMemo<FormattedRowCell[][]>(() => {
        if (!page) return [];
        const columnCount = page.columns.length;
        const truncated = new Set(page.truncatedCells.map(([row, column]) => row * columnCount + column));
        return page.rows.map((row, rowIndex) =>
            row.map((value, columnIndex) => {
                const isTruncated = truncated.has(rowIndex * columnCount + columnIndex);
                return { cell: formatCell(page.columns[columnIndex].dataType, value, isTruncated), truncated: isTruncated };
            }),
        );
    }, [page]);

    const copyRowAsJson = useCallback(
        (rowIndex: number) => {
            if (!page) return;
            const record = Object.fromEntries(page.columns.map((column, index) => [column.name, page.rows[rowIndex][index]]));
            copyText(JSON.stringify(record, null, 2));
        },
        [page, copyText],
    );

    const total = exactTotal ?? page?.estimatedTotal ?? null;
    const canGoNext = !!page && page.rows.length === page.limit && (exactTotal === undefined || page.offset + page.limit < exactTotal);
    const showingDetail = page !== undefined && detailRow !== undefined && formatted[detailRow] !== undefined;

    return {
        // connection + table list
        connections,
        isLoadingConnections,
        connectionId,
        changeConnection,
        relations,
        isLoadingRelations,
        refreshRelations,
        selected,
        selectedKey,
        selectRelation,
        // rows
        page,
        formatted,
        isLoadingPage,
        error,
        sort,
        sortBy,
        pageSize,
        changePageSize,
        goToOffset,
        total,
        exactTotal,
        canGoNext,
        countExactly,
        refreshPage,
        // row detail
        detailRow,
        setDetailRow,
        showingDetail,
        copyText,
        copyRowAsJson,
    };
}
