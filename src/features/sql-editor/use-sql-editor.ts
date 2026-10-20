import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SavedConnection, listSavedConnections } from "@/lib/live-connection-api";
import {
    SqlApiError,
    SqlRunError,
    SqlRunResponse,
    SqlStatementResult,
    SqlTransaction,
    cancelSql,
    commitSql,
    getSqlSession,
    rollbackSql,
    runSql,
} from "@/lib/sql-editor-api";
import { formatRows, type FormattedRowCell } from "@/utils/data-view/format-rows";
import { errorRange } from "./error-position";
import { applySqlHandoff, takeSqlHandoff } from "./handoff";
import { addSqlHistory, clearSqlHistory, loadSqlHistory, type SqlHistoryEntry } from "./sql-history";

const NO_TRANSACTION: SqlTransaction = { open: false, hasChanges: false, startedAt: null };

const storage = {
    get(key: string): string | null {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    },
    set(key: string, value: string) {
        try {
            localStorage.setItem(key, value);
        } catch {
            // storage blocked or full: the draft just isn't remembered
        }
    },
};

const sessionStore = {
    get(key: string): string | null {
        try {
            return sessionStorage.getItem(key);
        } catch {
            return null;
        }
    },
    set(key: string, value: string) {
        try {
            sessionStorage.setItem(key, value);
        } catch {
            // ignore
        }
    },
};

const LAST_CONNECTION_KEY = "goforge.sql.connection";
const TRANSACTIONAL_KEY = "goforge.sql.transactional";
const draftKey = (connectionId: string) => `goforge.sql.draft.${connectionId}`;
const sessionKey = (connectionId: string) => `goforge.sql.session.${connectionId}`;

/** One editor session per saved connection and browser tab; survives a reload so an open transaction can be picked up again. */
function sessionIdFor(connectionId: string): string {
    const existing = sessionStore.get(sessionKey(connectionId));
    if (existing) return existing;
    const created = `ed-${crypto.randomUUID()}`;
    sessionStore.set(sessionKey(connectionId), created);
    return created;
}

export interface RunView {
    results: SqlStatementResult[];
    formatted: FormattedRowCell[][][];
    elapsedMs: number;
    error?: SqlRunError;
    /** The SQL the position in `error` refers to (the selection, if only that was run). */
    ranSql: string;
    transactionLost?: boolean;
}

export type SqlEditor = ReturnType<typeof useSqlEditor>;

/** State and actions behind the SQL editor page: connection, draft, run / commit / roll back / stop, history. */
export function useSqlEditor() {
    const [connections, setConnections] = useState<SavedConnection[]>([]);
    const [isLoadingConnections, setIsLoadingConnections] = useState<boolean>(true);
    const [connectionId, setConnectionId] = useState<string | undefined>(undefined);
    const [sql, setSql] = useState<string>("");
    const [transactional, setTransactional] = useState<boolean>(() => storage.get(TRANSACTIONAL_KEY) !== "false");

    const [isRunning, setIsRunning] = useState<boolean>(false);
    const [view, setView] = useState<RunView | undefined>(undefined);
    const [requestError, setRequestError] = useState<string | undefined>(undefined);
    const [transaction, setTransaction] = useState<SqlTransaction>(NO_TRANSACTION);
    const [isFinishing, setIsFinishing] = useState<boolean>(false);
    const [now, setNow] = useState<number>(() => Date.now());

    const [history, setHistory] = useState<SqlHistoryEntry[]>(() => loadSqlHistory());

    const editorView = useRef<EditorView | null>(null);
    const connectionRef = useRef<string | undefined>(undefined);
    connectionRef.current = connectionId;

    // ---- connections ------------------------------------------------------------------------------------------
    useEffect(() => {
        listSavedConnections()
            .then((list) => {
                setConnections(list);
                const last = storage.get(LAST_CONNECTION_KEY);
                const pick = list.find((connection) => connection.id === last) ?? (list.length === 1 ? list[0] : undefined);
                if (pick) setConnectionId(pick.id);
            })
            .catch((error) => setRequestError(error instanceof Error ? error.message : String(error)))
            .finally(() => setIsLoadingConnections(false));
    }, []);

    // Switching connection: load that connection's draft, re-attach to its session (an open transaction survives a reload), apply SQL handed over from other pages.
    useEffect(() => {
        if (!connectionId) return;
        storage.set(LAST_CONNECTION_KEY, connectionId);

        let draft = storage.get(draftKey(connectionId)) ?? "";
        const handoff = takeSqlHandoff();
        if (handoff) draft = applySqlHandoff(draft, handoff);
        setSql(draft);
        setView(undefined);
        setRequestError(undefined);
        setTransaction(NO_TRANSACTION);

        let cancelled = false;
        getSqlSession(connectionId, sessionIdFor(connectionId))
            .then((session) => {
                if (!cancelled && session.exists) setTransaction(session.transaction);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [connectionId]);

    // Draft is remembered per connection.
    useEffect(() => {
        if (!connectionId) return;
        const timer = window.setTimeout(() => storage.set(draftKey(connectionId), sql), 400);
        return () => window.clearTimeout(timer);
    }, [connectionId, sql]);

    useEffect(() => storage.set(TRANSACTIONAL_KEY, String(transactional)), [transactional]);

    // "Open for 2 min" label.
    useEffect(() => {
        if (!transaction.open) return;
        const timer = window.setInterval(() => setNow(Date.now()), 15_000);
        return () => window.clearInterval(timer);
    }, [transaction.open]);

    // Leaving the tab with uncommitted changes: the browser asks first.
    useEffect(() => {
        if (!transaction.hasChanges) return;
        const warn = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [transaction.hasChanges]);

    // ---- actions ----------------------------------------------------------------------------------------------
    const selectedText = useCallback((): string => {
        const current = editorView.current;
        if (!current) return "";
        const { from, to } = current.state.selection.main;
        return from === to ? "" : current.state.sliceDoc(from, to);
    }, []);

    const run = useCallback(
        async (selection?: string) => {
            const id = connectionRef.current;
            if (!id || isRunning) return;
            const picked = (selection ?? selectedText()).trim() ? (selection ?? selectedText()) : sql;
            if (!picked.trim()) return;

            setIsRunning(true);
            setRequestError(undefined);
            try {
                const response: SqlRunResponse = await runSql(id, {
                    sessionId: sessionIdFor(id),
                    sql: picked,
                    transactional,
                    expectOpenTransaction: transaction.open && transaction.hasChanges,
                });
                if (connectionRef.current !== id) return;

                setView({
                    results: response.results,
                    formatted: response.results.map((result) => formatRows(result.columns, result.rows, result.truncatedCells)),
                    elapsedMs: response.elapsedMs,
                    ranSql: picked,
                    ...(response.ok ? {} : { error: response.error, transactionLost: response.transactionLost }),
                });
                setTransaction(response.transaction);
                setHistory(addSqlHistory({ id: `${Date.now()}`, sql: picked, connectionId: id, at: Date.now(), ok: response.ok, ms: response.elapsedMs }));
            } catch (error) {
                if (connectionRef.current !== id) return;
                if (error instanceof SqlApiError && error.code === "session_expired") setTransaction(NO_TRANSACTION);
                setView(undefined);
                setRequestError(error instanceof Error ? error.message : String(error));
            } finally {
                setIsRunning(false);
            }
        },
        [isRunning, selectedText, sql, transactional, transaction.open, transaction.hasChanges],
    );

    const finish = useCallback(
        async (action: "commit" | "rollback") => {
            const id = connectionRef.current;
            if (!id) return;
            setIsFinishing(true);
            setRequestError(undefined);
            try {
                const response = await (action === "commit" ? commitSql : rollbackSql)(id, sessionIdFor(id));
                setTransaction(response.transaction);
                if (response.ok) toast.success(action === "commit" ? "Changes committed" : "Changes rolled back");
                else setRequestError(`${action === "commit" ? "Commit" : "Roll back"} failed: ${response.error?.message ?? "unknown error"}. The transaction was rolled back.`);
            } catch (error) {
                if (error instanceof SqlApiError && error.code === "session_expired") {
                    setTransaction(NO_TRANSACTION);
                    setRequestError("The session had expired, so the open transaction was already rolled back.");
                } else setRequestError(error instanceof Error ? error.message : String(error));
            } finally {
                setIsFinishing(false);
            }
        },
        [],
    );

    const cancel = useCallback(async () => {
        const id = connectionRef.current;
        if (!id) return;
        try {
            await cancelSql(id, sessionIdFor(id));
        } catch {
            // the run request reports what happened
        }
    }, []);

    const goToError = useCallback((position: number, ranSql: string) => {
        const current = editorView.current;
        if (!current) return;
        // The error refers to what was run: the whole editor, or just the selection when only that was run.
        const text = current.state.doc.toString();
        const offset = ranSql === text ? 0 : Math.max(0, text.indexOf(ranSql));
        const { from, to } = errorRange(ranSql, position);
        current.dispatch({ selection: { anchor: offset + from, head: offset + to }, scrollIntoView: true });
        current.focus();
    }, []);

    const loadFromHistory = useCallback((entry: SqlHistoryEntry) => setSql(entry.sql), []);
    const clearHistory = useCallback(() => {
        clearSqlHistory();
        setHistory([]);
    }, []);

    const minutesOpen = useMemo(() => (transaction.open && transaction.startedAt ? Math.max(0, Math.floor((now - transaction.startedAt) / 60_000)) : 0), [transaction.open, transaction.startedAt, now]);
    const connection = connections.find((candidate) => candidate.id === connectionId);

    return {
        connections,
        isLoadingConnections,
        connectionId,
        connection,
        selectConnection: setConnectionId,
        sql,
        setSql,
        transactional,
        setTransactional,
        isRunning,
        view,
        requestError,
        transaction,
        minutesOpen,
        isFinishing,
        history,
        editorView,
        run,
        cancel,
        commit: () => finish("commit"),
        rollback: () => finish("rollback"),
        goToError,
        loadFromHistory,
        clearHistory,
    };
}
