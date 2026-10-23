import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AiStatus, fetchAiStatus, requestQueryModernization } from "@/lib/ai-api";
import { SavedConnection, listSavedConnections } from "@/lib/live-connection-api";
import { validateSqlOnConnection } from "@/lib/modernizer-api";
import { useDatabase } from "@/providers/database-provider/database-provider";
import { BATCH_STATUSES, BatchItem, BatchResult, BatchStatus, inspectScript, runBatch } from "../batch";
import { convertedScript, readinessMarkdown, resultsCsv } from "../batch-report";
import { checkPostgresSyntax } from "../engine/checks";
import { schemaFromDatabase } from "../schema-context";
import type { LegacyDialect } from "../types";

const DIALECT_KEY = "goforge.modernizer.batch.dialect";
const AI_LIMIT_KEY = "goforge.modernizer.batch.ai-limit";
// The connection and the "use AI" choice are the one-query view's: choosing them in either place is choosing them in both.
const CONNECTION_KEY = "goforge.modernizer.connection";
const USE_AI_KEY = "goforge.modernizer.ai";
const SQL_EDITOR_CONNECTION_KEY = "goforge.sql.connection";

/** A file this big is not loaded: the conversion runs in this browser tab. */
export const MAX_FILE_BYTES = 20_000_000;
/** Above this the text is kept but not shown in the editor, which would slow the page down. */
export const EDITOR_LIMIT = 1_000_000;
export const DEFAULT_AI_LIMIT = 25;

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

export type StatusFilter = BatchStatus | "all";

interface Saved {
    dialect: LegacyDialect;
    script: string;
    fileName: string | undefined;
    result: BatchResult | undefined;
    filter: StatusFilter;
    search: string;
}

// Switching sidebar pages unmounts this view; keep the file and its results so coming back is not a reset.
let saved: Saved | undefined;

const download = (name: string, text: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const baseName = (fileName: string | undefined) => (fileName ?? "script").replace(/\.[^.]+$/, "") || "script";

/** State and actions behind the script view of the Modernizer. */
export function useBatch() {
    const { database } = useDatabase();
    const schema = useMemo(() => schemaFromDatabase(database), [database]);

    const [dialect, setDialectState] = useState<LegacyDialect>(saved?.dialect ?? ((read(DIALECT_KEY) as LegacyDialect | null) || "oracle"));
    const [script, setScript] = useState(saved?.script ?? "");
    const [fileName, setFileName] = useState<string | undefined>(saved?.fileName);
    const [result, setResult] = useState<BatchResult | undefined>(saved?.result);
    const [filter, setFilter] = useState<StatusFilter>(saved?.filter ?? "all");
    const [search, setSearch] = useState(saved?.search ?? "");
    const [selected, setSelected] = useState<number | undefined>(undefined);

    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [reviewAsSql, setReviewAsSql] = useState(true);
    const [useSchema, setUseSchema] = useState(true);

    const [connections, setConnections] = useState<SavedConnection[]>([]);
    const [connectionId, setConnectionId] = useState<string | undefined>(undefined);
    const [aiStatus, setAiStatus] = useState<AiStatus | undefined>(undefined);
    const [useAi, setUseAi] = useState<boolean>(() => read(USE_AI_KEY) !== "false");
    const [aiLimit, setAiLimit] = useState<number>(() => Number(read(AI_LIMIT_KEY)) || DEFAULT_AI_LIMIT);

    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        saved = { dialect, script, fileName, result, filter, search };
    }, [dialect, script, fileName, result, filter, search]);

    useEffect(() => {
        const controller = new AbortController();
        fetchAiStatus(controller.signal)
            .then(setAiStatus)
            .catch(() => setAiStatus({ configured: false, model: "" }));
        listSavedConnections()
            .then((list) => {
                setConnections(list);
                const remembered = read(CONNECTION_KEY);
                if (remembered === "none") return;
                const pick = list.find((connection) => connection.id === (remembered ?? read(SQL_EDITOR_CONNECTION_KEY))) ?? (remembered === null && list.length === 1 ? list[0] : undefined);
                if (pick) setConnectionId(pick.id);
            })
            .catch(() => setConnections([]));
        return () => controller.abort();
    }, []);

    const connection = connections.find((candidate) => candidate.id === connectionId);
    const aiConfigured = aiStatus?.configured === true;

    // What the file contains, as soon as it is there: how many statements, and how many of them are not queries.
    const [found, setFound] = useState<ReturnType<typeof inspectScript> | undefined>(undefined);
    useEffect(() => {
        if (!script.trim() || script.length > 8_000_000) {
            setFound(undefined);
            return;
        }
        const timer = window.setTimeout(() => setFound(inspectScript(script, dialect)), 250);
        return () => window.clearTimeout(timer);
    }, [script, dialect]);

    const setDialect = useCallback((value: LegacyDialect) => {
        setDialectState(value);
        write(DIALECT_KEY, value);
    }, []);

    const changeConnection = useCallback((id: string | undefined) => {
        setConnectionId(id);
        write(CONNECTION_KEY, id ?? "none");
    }, []);

    const changeUseAi = useCallback((value: boolean) => {
        setUseAi(value);
        write(USE_AI_KEY, String(value));
    }, []);

    const changeAiLimit = useCallback((value: number) => {
        const limit = Math.max(0, Math.min(500, Math.round(value) || 0));
        setAiLimit(limit);
        write(AI_LIMIT_KEY, String(limit));
    }, []);

    const loadFile = useCallback(async (file: File) => {
        if (file.size > MAX_FILE_BYTES) {
            toast.error(`${file.name} is ${(file.size / 1_000_000).toFixed(1)} MB. Files over ${MAX_FILE_BYTES / 1_000_000} MB are not loaded: the conversion runs in this tab. Split the file and convert it in parts.`);
            return;
        }
        try {
            setScript(await file.text());
            setFileName(file.name);
            setResult(undefined);
            setSelected(undefined);
        } catch (error) {
            toast.error(`Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }, []);

    const changeScript = useCallback((value: string) => {
        setScript(value);
        setFileName((current) => (current && value.length < 1 ? undefined : current));
    }, []);

    const clear = useCallback(() => {
        setScript("");
        setFileName(undefined);
        setResult(undefined);
        setSelected(undefined);
    }, []);

    const run = useCallback(async () => {
        if (!script.trim() || running) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setRunning(true);
        setSelected(undefined);
        setProgress({ done: 0, total: found?.units.length ?? 0 });
        try {
            const outcome = await runBatch(
                { script, dialect, schema: useSchema ? schema : undefined },
                {
                    syntax: checkPostgresSyntax,
                    validate: connection ? (text) => validateSqlOnConnection(connection.id, text, controller.signal) : undefined,
                    connectionName: connection?.name,
                    ask: useAi && aiConfigured && aiLimit > 0 ? (request) => requestQueryModernization(request, controller.signal) : undefined,
                },
                { signal: controller.signal, maxAiStatements: aiLimit, onProgress: (done, total) => setProgress({ done, total }) },
            );
            setResult(outcome);
            setFilter("all");
        } catch (error) {
            if (!controller.signal.aborted) toast.error(`Conversion failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setRunning(false);
        }
    }, [script, dialect, schema, useSchema, connection, useAi, aiConfigured, aiLimit, running, found]);

    const stop = useCallback(() => abortRef.current?.abort(), []);

    useEffect(() => () => abortRef.current?.abort(), []);

    const visible = useMemo(() => {
        if (!result) return [] as BatchItem[];
        const text = search.trim().toLowerCase();
        return result.items.filter((item) => {
            if (filter !== "all" && item.status !== filter) return false;
            if (!text) return true;
            return item.unit.text.toLowerCase().includes(text) || item.reasons.some((reason) => reason.toLowerCase().includes(text)) || (item.outcome?.sql.toLowerCase().includes(text) ?? false);
        });
    }, [result, filter, search]);

    const counts = useMemo(() => Object.fromEntries(BATCH_STATUSES.map((status) => [status, result?.summary.byStatus[status] ?? 0])) as Record<BatchStatus, number>, [result]);

    const stem = baseName(fileName);
    const exportScript = useCallback(() => result && download(`${stem}.postgres.sql`, convertedScript(result, { reviewAsSql }), "application/sql"), [result, stem, reviewAsSql]);
    const exportReport = useCallback(() => result && download(`${stem}.migration-report.md`, readinessMarkdown(result, { fileName, generatedAt: new Date().toISOString().slice(0, 16).replace("T", " ") }), "text/markdown"), [result, stem, fileName]);
    const exportCsv = useCallback(() => result && download(`${stem}.results.csv`, resultsCsv(result), "text/csv"), [result, stem]);

    return {
        dialect,
        setDialect,
        script,
        setScript: changeScript,
        fileName,
        loadFile,
        clear,
        found,
        run,
        stop,
        running,
        progress,
        result,
        visible,
        counts,
        filter,
        setFilter,
        search,
        setSearch,
        selected,
        setSelected,
        connections,
        connection,
        changeConnection,
        aiStatus,
        aiConfigured,
        useAi,
        changeUseAi,
        aiLimit,
        changeAiLimit,
        useSchema,
        setUseSchema,
        hasSchema: !!schema,
        reviewAsSql,
        setReviewAsSql,
        exportScript,
        exportReport,
        exportCsv,
    };
}

export type Batch = ReturnType<typeof useBatch>;
