import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useToast from "@/hooks/use-toast";
import { RelationInfo, SavedConnection, TableDataPage, fetchRelations, fetchTableRows, listSavedConnections, warmConnection } from "@/lib/live-connection-api";
import { formatRows, type FormattedRowCell } from "@/utils/data-view/format-rows";
import { Relation, buildRelations } from "@/utils/data-view/relations";
import { PageKeyParts, connectionPrefix, loadStoredRelations, pageCache, pageKey, storeRelations } from "./data-cache";

export const PAGE_SIZES = [50, 100, 250, 500];
const DEFAULT_PAGE_SIZE = 50;

/** How many tables (after the open one) get their first page read ahead of time once the list is known. */
const PREFETCH_COUNT = 4;
/** Don't read ahead into big tables: that's a guess about what the user wants, and a sort on a huge table isn't free. */
const PREFETCH_MAX_ESTIMATE = 100_000;
/** The API closes idle connections after 60 s; ping a bit more often than that while the page is open. */
const KEEP_ALIVE_MS = 45_000;

export type SortState = { column: string; dir: "asc" | "desc" } | undefined;

interface Remembered {
    connectionId?: string;
    relationKey?: string;
    sort?: SortState;
    pageSize?: number;
}

// Leaving the page (or switching sidebar tabs) unmounts it; keep the last selection so coming back doesn't mean
// picking the connection and table again.
let remembered: Remembered = {};

/** Opens the Data page on this connection the next time it is shown (its own memory lasts until the page is reloaded). */
export const rememberDataConnection = (connectionId: string): void => {
    remembered = { connectionId };
};

const relationsMemory = new Map<string, RelationInfo[]>();
const inflight = new Map<string, Promise<TableDataPage>>();

interface PageRequest extends PageKeyParts {
    exactCount?: boolean;
}

/** Reads a page (sharing the request with any identical one already running) and remembers it. */
function requestPage(request: PageRequest, refresh = false): Promise<TableDataPage> {
    const key = pageKey(request);
    const inflightKey = request.exactCount ? `${key}|exact` : key;

    const running = refresh ? undefined : inflight.get(inflightKey);
    if (running) return running;

    const promise: Promise<TableDataPage> = fetchTableRows(request.connectionId, {
        schema: request.schema,
        table: request.table,
        limit: request.pageSize,
        offset: request.offset,
        sort: request.sort,
        dir: request.dir,
        exactCount: request.exactCount,
        refresh,
    })
        .then((page) => {
            pageCache.set(key, page);
            return page;
        })
        .finally(() => {
            if (inflight.get(inflightKey) === promise) inflight.delete(inflightKey);
        });

    inflight.set(inflightKey, promise);
    return promise;
}

async function readRelations(connectionId: string): Promise<RelationInfo[]> {
    const relations = await fetchRelations(connectionId);
    relationsMemory.set(connectionId, relations);
    storeRelations(connectionId, relations);
    return relations;
}

const rememberedRelations = (connectionId: string): RelationInfo[] | undefined => relationsMemory.get(connectionId) ?? loadStoredRelations(connectionId);

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
    /** Nothing to show yet: the list is being read for the first time. */
    const [isLoadingRelations, setIsLoadingRelations] = useState<boolean>(false);
    /** A remembered list is on screen and is being checked against the database. */
    const [isRefreshingRelations, setIsRefreshingRelations] = useState<boolean>(false);
    const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);

    const [page, setPage] = useState<TableDataPage | undefined>(undefined);
    const [exactTotal, setExactTotal] = useState<number | undefined>(undefined);
    /** Blocking load: no rows to show for this view yet (skeleton / dimmed rows). */
    const [isLoadingPage, setIsLoadingPage] = useState<boolean>(false);
    /** Rows from the cache are on screen and are being refreshed in the background. */
    const [isRevalidating, setIsRevalidating] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>(undefined);

    const [sort, setSort] = useState<SortState>(undefined);
    const [pageSize, setPageSize] = useState<number>(restore.current.pageSize ?? DEFAULT_PAGE_SIZE);
    const [detailRow, setDetailRow] = useState<number | undefined>(undefined);

    // Ignore responses from requests that were superseded (fast clicking between tables/pages).
    const latestRequest = useRef<number>(0);
    const prefetchRun = useRef<number>(0);

    // Latest values for callbacks that must not change identity (prefetch, keep-alive).
    const connectionIdRef = useRef<string | undefined>(undefined);
    const relationsRef = useRef<Relation[]>([]);
    const selectedKeyRef = useRef<string | undefined>(undefined);
    const pageSizeRef = useRef<number>(pageSize);
    connectionIdRef.current = connectionId;
    relationsRef.current = relations;
    selectedKeyRef.current = selectedKey;
    pageSizeRef.current = pageSize;

    const selected = useMemo(() => relations.find((relation) => relation.key === selectedKey), [relations, selectedKey]);

    const resetData = useCallback(() => {
        latestRequest.current++;
        setPage(undefined);
        setExactTotal(undefined);
        setError(undefined);
        setSort(undefined);
        setDetailRow(undefined);
        setIsLoadingPage(false);
        setIsRevalidating(false);
    }, []);

    const loadPage = useCallback(
        async (args: { connectionId: string; relation: Relation; sort: SortState; offset: number; pageSize: number; exactCount?: boolean; refresh?: boolean }) => {
            const requestId = ++latestRequest.current;
            const request: PageRequest = {
                connectionId: args.connectionId,
                schema: args.relation.schema,
                table: args.relation.name,
                sort: args.sort?.column,
                dir: args.sort?.dir,
                offset: args.offset,
                pageSize: args.pageSize,
                exactCount: args.exactCount,
            };

            // A page we already have is shown straight away; if it is old, it is refreshed behind the scenes.
            const hit = args.refresh || args.exactCount ? undefined : pageCache.get(pageKey(request));
            setError(undefined);
            if (hit) {
                setPage(hit.value);
                if (hit.value.exactTotal !== undefined) setExactTotal(hit.value.exactTotal);
                setIsLoadingPage(false);
                if (hit.fresh) {
                    setIsRevalidating(false);
                    return;
                }
                setIsRevalidating(true);
            } else {
                setIsLoadingPage(true);
                setIsRevalidating(false);
            }

            try {
                const result = await requestPage(request, args.refresh);
                if (requestId !== latestRequest.current) return;
                setPage(result);
                if (result.exactTotal !== undefined) setExactTotal(result.exactTotal);
            } catch (err) {
                if (requestId !== latestRequest.current) return;
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                if (requestId === latestRequest.current) {
                    setIsLoadingPage(false);
                    setIsRevalidating(false);
                }
            }
        },
        [],
    );

    /** Reads the first page of a table into the cache without showing anything (hover / read-ahead). */
    const prefetchRelation = useCallback((key: string): Promise<void> => {
        const id = connectionIdRef.current;
        const relation = relationsRef.current.find((candidate) => candidate.key === key);
        if (!id || !relation) return Promise.resolve();

        const request: PageRequest = { connectionId: id, schema: relation.schema, table: relation.name, offset: 0, pageSize: pageSizeRef.current };
        if (pageCache.get(pageKey(request))?.fresh) return Promise.resolve();
        return requestPage(request).then(
            () => undefined,
            () => undefined, // a failed guess is not worth bothering the user about
        );
    }, []);

    /** After the list is known: read the first page of the next few tables, one at a time, while the user looks around. */
    const startReadAhead = useCallback(
        (list: Relation[]) => {
            const run = ++prefetchRun.current;
            const candidates = list
                .filter((relation) => relation.key !== selectedKeyRef.current && (relation.estimatedRows === null || relation.estimatedRows <= PREFETCH_MAX_ESTIMATE))
                .slice(0, PREFETCH_COUNT);

            void (async () => {
                for (const relation of candidates) {
                    if (run !== prefetchRun.current) return;
                    await prefetchRelation(relation.key);
                }
            })();
        },
        [prefetchRelation],
    );

    const changeConnection = useCallback(
        async (id: string, previous?: Remembered) => {
            setConnectionId(id);
            connectionIdRef.current = id;
            setSelectedKey(undefined);
            selectedKeyRef.current = undefined;
            resetData();

            // Open the API's database connection now, so it is ready by the time a table is clicked.
            warmConnection(id).catch(() => undefined);

            const openRemembered = (list: Relation[]) => {
                const again = previous?.relationKey ? list.find((relation) => relation.key === previous.relationKey) : undefined;
                if (!again) return;
                setSelectedKey(again.key);
                selectedKeyRef.current = again.key;
                setSort(previous?.sort);
                loadPage({ connectionId: id, relation: again, sort: previous?.sort, offset: 0, pageSize: previous?.pageSize ?? pageSizeRef.current });
            };

            // Show the list we saw last time straight away, then check it against the database.
            const known = rememberedRelations(id);
            const knownRelations = known ? buildRelations(known) : undefined;
            if (knownRelations) {
                setRelations(knownRelations);
                relationsRef.current = knownRelations;
                openRemembered(knownRelations);
                setIsRefreshingRelations(true);
            } else {
                setRelations([]);
                relationsRef.current = [];
                setIsLoadingRelations(true);
            }

            try {
                const fresh = buildRelations(await readRelations(id));
                if (connectionIdRef.current !== id) return; // another connection was picked meanwhile
                setRelations(fresh);
                relationsRef.current = fresh;

                if (!knownRelations) openRemembered(fresh);
                else if (selectedKeyRef.current && !fresh.some((relation) => relation.key === selectedKeyRef.current)) {
                    // The table that was open no longer exists.
                    setSelectedKey(undefined);
                    selectedKeyRef.current = undefined;
                    resetData();
                }
                startReadAhead(fresh);
            } catch (err) {
                if (connectionIdRef.current !== id) return;
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                if (connectionIdRef.current === id) {
                    setIsLoadingRelations(false);
                    setIsRefreshingRelations(false);
                }
            }
        },
        [resetData, loadPage, startReadAhead],
    );

    useEffect(() => {
        listSavedConnections("all")
            .then((list) => {
                setConnections(list);
                const previous = restore.current;
                const id = list.find((conn) => conn.id === previous.connectionId)?.id ?? (list.length === 1 ? list[0].id : undefined);
                if (id) changeConnection(id, id === previous.connectionId ? previous : undefined);
            })
            .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setIsLoadingConnections(false));
        return () => {
            // Late responses must not touch state after the page is gone, and read-ahead stops.
            latestRequest.current++;
            prefetchRun.current++;
        };
    }, [changeConnection]);

    // Keep the API's pooled connection open while the page is in use (it closes itself after 60 s idle).
    useEffect(() => {
        if (!connectionId) return;
        const ping = () => {
            if (document.visibilityState === "visible") warmConnection(connectionId).catch(() => undefined);
        };
        const timer = window.setInterval(ping, KEEP_ALIVE_MS);
        document.addEventListener("visibilitychange", ping);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", ping);
        };
    }, [connectionId]);

    useEffect(() => {
        remembered = { connectionId, relationKey: selectedKey, sort, pageSize };
    }, [connectionId, selectedKey, sort, pageSize]);

    /** Re-reads the table list for the current connection (and forgets the rows read for it), keeping the open table if it still exists. */
    const refreshRelations = useCallback(async () => {
        const id = connectionIdRef.current;
        if (!id) return;
        setIsRefreshingRelations(true);
        try {
            const fresh = buildRelations(await readRelations(id));
            if (connectionIdRef.current !== id) return;
            pageCache.deleteWithPrefix(connectionPrefix(id));
            setRelations(fresh);
            relationsRef.current = fresh;
            if (selectedKeyRef.current && !fresh.some((relation) => relation.key === selectedKeyRef.current)) {
                setSelectedKey(undefined);
                selectedKeyRef.current = undefined;
                resetData();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsRefreshingRelations(false);
        }
    }, [resetData]);

    const selectRelation = useCallback(
        (key: string) => {
            const relation = relations.find((candidate) => candidate.key === key);
            if (!connectionId || !relation) return;
            setSelectedKey(key);
            selectedKeyRef.current = key;
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
            pageSizeRef.current = size;
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

    /** The refresh button: always asks the database again (and tells the API to re-read the table's columns). */
    const refreshPage = useCallback(() => {
        if (!connectionId || !selected) return;
        loadPage({ connectionId, relation: selected, sort, offset: page?.offset ?? 0, pageSize, exactCount: exactTotal !== undefined, refresh: true });
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

    const formatted = useMemo<FormattedRowCell[][]>(() => (page ? formatRows(page.columns, page.rows, page.truncatedCells) : []), [page]);

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
        isRefreshingRelations,
        refreshRelations,
        selected,
        selectedKey,
        selectRelation,
        prefetchRelation,
        // rows
        page,
        formatted,
        isLoadingPage,
        isRevalidating,
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
