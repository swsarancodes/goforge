import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SavedConnection, listSavedConnections } from "@/lib/live-connection-api";
import {
    AiStatus,
    CatalogResponse,
    HealthReport,
    HealthSummary,
    PlanResponse,
    ScopeResponse,
    fetchAiStatus,
    fetchCatalog,
    fetchHealth,
    fetchHealthSummary,
    fetchScope,
    recordHandoff,
    requestPlan,
} from "@/lib/schema-change-api";
import { useOpenInSqlEditor } from "@/features/sql-editor/use-open-in-sql-editor";

const CONNECTION_KEY = "goforge.schemaChange.connection";
const SQL_EDITOR_CONNECTION_KEY = "goforge.sql.connection";

const read = (key: string): string | null => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};
const write = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // the choice just isn't remembered
    }
};

export type Tab = "plan" | "health" | "governance" | "audit";

export type PlanState = { status: "idle" } | { status: "running"; stage: string } | { status: "done"; response: PlanResponse } | { status: "failed"; message: string; blocked: boolean };

interface Saved {
    connectionId: string | undefined;
    prompt: string;
    selected: string[];
    scope: ScopeResponse | undefined;
    plan: PlanState;
    tab: Tab;
    health: HealthReport | undefined;
    summary: HealthSummary | undefined;
}

// Switching sidebar pages unmounts this one; keep the work so coming back isn't a reset.
let saved: Saved | undefined;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** State and actions behind the Schema Change page. Everything it reads from the database is read-only; the plan only becomes SQL in the SQL Editor. */
export function useSchemaChange() {
    const openInSqlEditor = useOpenInSqlEditor();

    const [connections, setConnections] = useState<SavedConnection[]>([]);
    const [loadingConnections, setLoadingConnections] = useState(true);
    const [connectionId, setConnectionId] = useState<string | undefined>(saved?.connectionId);
    const [catalog, setCatalog] = useState<CatalogResponse | undefined>(undefined);
    const [loadingCatalog, setLoadingCatalog] = useState(false);
    const [catalogError, setCatalogError] = useState<string | undefined>(undefined);

    const [prompt, setPrompt] = useState(saved?.prompt ?? "");
    const [selected, setSelected] = useState<string[]>(saved?.selected ?? []);
    const [scope, setScope] = useState<ScopeResponse | undefined>(saved?.scope);
    const [finding, setFinding] = useState(false);
    const [plan, setPlan] = useState<PlanState>(saved?.plan.status === "running" ? { status: "idle" } : (saved?.plan ?? { status: "idle" }));
    const [tab, setTab] = useState<Tab>(saved?.tab ?? "plan");

    const [health, setHealth] = useState<HealthReport | undefined>(saved?.health);
    const [loadingHealth, setLoadingHealth] = useState(false);
    const [healthError, setHealthError] = useState<string | undefined>(undefined);
    const [summary, setSummary] = useState<HealthSummary | undefined>(saved?.summary);
    const [summarizing, setSummarizing] = useState(false);

    const [aiStatus, setAiStatus] = useState<AiStatus | undefined>(undefined);

    const abort = useRef<AbortController | null>(null);

    useEffect(() => {
        saved = { connectionId, prompt, selected, scope, plan, tab, health, summary };
    }, [connectionId, prompt, selected, scope, plan, tab, health, summary]);

    const refreshAiStatus = useCallback(() => {
        fetchAiStatus()
            .then(setAiStatus)
            .catch(() => setAiStatus(undefined));
    }, []);

    useEffect(() => {
        refreshAiStatus();
        listSavedConnections()
            .then((list) => {
                setConnections(list);
                setConnectionId((current) => {
                    if (current && list.some((connection) => connection.id === current)) return current;
                    const remembered = read(CONNECTION_KEY) ?? read(SQL_EDITOR_CONNECTION_KEY);
                    return list.find((connection) => connection.id === remembered)?.id ?? (list.length === 1 ? list[0].id : undefined);
                });
            })
            .catch((error) => setCatalogError(message(error)))
            .finally(() => setLoadingConnections(false));
    }, [refreshAiStatus]);

    const loadCatalog = useCallback(async (id: string, refresh = false) => {
        setLoadingCatalog(true);
        setCatalogError(undefined);
        try {
            const result = await fetchCatalog(id, refresh);
            setCatalog(result);
        } catch (error) {
            setCatalog(undefined);
            setCatalogError(message(error));
        } finally {
            setLoadingCatalog(false);
        }
    }, []);

    useEffect(() => {
        if (!connectionId) {
            setCatalog(undefined);
            return;
        }
        write(CONNECTION_KEY, connectionId);
        void loadCatalog(connectionId);
    }, [connectionId, loadCatalog]);

    const changeConnection = useCallback((id: string) => {
        setConnectionId(id);
        setSelected([]);
        setScope(undefined);
        setPlan({ status: "idle" });
        setHealth(undefined);
        setSummary(undefined);
    }, []);

    const connection = connections.find((candidate) => candidate.id === connectionId);

    // ---- scope ---------------------------------------------------------------------------------------------------------

    const findTables = useCallback(async () => {
        if (!connectionId || !prompt.trim()) return undefined;
        setFinding(true);
        try {
            const result = await fetchScope(connectionId, prompt);
            setScope(result);
            setSelected(result.tables.map((table) => table.qualified));
            return result;
        } catch (error) {
            toast.error(`Could not search the tables: ${message(error)}`);
            return undefined;
        } finally {
            setFinding(false);
        }
    }, [connectionId, prompt]);

    const toggleTable = useCallback((qualified: string, on: boolean) => {
        setSelected((current) => (on ? (current.includes(qualified) ? current : [...current, qualified]) : current.filter((name) => name !== qualified)));
    }, []);

    const clearScope = useCallback(() => {
        setSelected([]);
        setScope(undefined);
    }, []);

    const reasons = useMemo(() => new Map((scope?.tables ?? []).map((table) => [table.qualified, table])), [scope]);

    // ---- plan --------------------------------------------------------------------------------------------------------

    const generate = useCallback(
        async (redact?: boolean) => {
            if (!connectionId || !prompt.trim()) return;
            // Choosing tables is optional. With none chosen, the ones the request names are found; if it names none (a request for new tables,
            // say) the plan goes ahead with no existing table in scope, and the ones it turns out to need are read for it.
            let tables = selected;
            if (tables.length === 0) {
                const found = await findTables();
                tables = found?.tables.map((table) => table.qualified) ?? [];
            }
            const controller = new AbortController();
            abort.current?.abort();
            abort.current = controller;
            setPlan({ status: "running", stage: tables.length === 0 ? "Asking the model" : `Reading ${tables.length} table${tables.length === 1 ? "" : "s"} and asking the model` });
            setTab("plan");
            try {
                const response = await requestPlan(connectionId, { prompt, tables, ...(redact === undefined ? {} : { redact }) }, controller.signal);
                if (controller.signal.aborted) return;
                setPlan({ status: "done", response });
            } catch (error) {
                if (controller.signal.aborted) return;
                const blocked = (error as { code?: string }).code === "blocked_by_policy";
                setPlan({ status: "failed", message: message(error), blocked });
            }
        },
        [connectionId, prompt, selected, findTables],
    );

    const stop = useCallback(() => {
        abort.current?.abort();
        setPlan({ status: "idle" });
    }, []);

    const openRunbook = useCallback(
        (script: string, response: PlanResponse) => {
            if (!connection) return;
            void recordHandoff({ parentId: response.auditId, connectionId: connection.id, connectionName: connection.name, steps: response.runbook?.steps.length ?? 0, tables: response.scope }).catch(() => undefined);
            try {
                localStorage.setItem("goforge.sql.connection", connection.id);
            } catch {
                // the editor falls back to its own choice
            }
            openInSqlEditor(script, "Schema Change", { transactional: false });
        },
        [connection, openInSqlEditor],
    );

    // ---- health ------------------------------------------------------------------------------------------------------

    const loadHealth = useCallback(async () => {
        if (!connectionId) return;
        setLoadingHealth(true);
        setHealthError(undefined);
        setSummary(undefined);
        try {
            setHealth(await fetchHealth(connectionId));
        } catch (error) {
            setHealthError(message(error));
        } finally {
            setLoadingHealth(false);
        }
    }, [connectionId]);

    const summarize = useCallback(
        async (redact?: boolean) => {
            if (!connectionId) return;
            setSummarizing(true);
            try {
                const result = await fetchHealthSummary(connectionId, redact);
                setSummary(result.summary);
            } catch (error) {
                toast.error(message(error));
            } finally {
                setSummarizing(false);
            }
        },
        [connectionId],
    );

    useEffect(() => () => abort.current?.abort(), []);

    return {
        connections,
        loadingConnections,
        connection,
        connectionId,
        changeConnection,
        catalog,
        loadingCatalog,
        catalogError,
        refreshCatalog: () => connectionId && loadCatalog(connectionId, true),
        prompt,
        setPrompt,
        selected,
        toggleTable,
        clearScope,
        scope,
        reasons,
        finding,
        findTables,
        plan,
        generate,
        stop,
        openRunbook,
        tab,
        setTab,
        health,
        loadingHealth,
        healthError,
        loadHealth,
        summary,
        summarizing,
        summarize,
        aiStatus,
        refreshAiStatus,
    };
}

export type SchemaChange = ReturnType<typeof useSchemaChange>;
