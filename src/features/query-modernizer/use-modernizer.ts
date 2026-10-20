import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AiStatus, fetchAiStatus, requestQueryModernization } from "@/lib/ai-api";
import { SavedConnection, listSavedConnections } from "@/lib/live-connection-api";
import { PreviewResponse, previewQueryOnConnection, validateSqlOnConnection } from "@/lib/modernizer-api";
import { useDatabase } from "@/providers/database-provider/database-provider";
import { checkPostgresSyntax } from "./engine/checks";
import { neutralizeParameters } from "./engine/convert";
import { buildExampleQuery } from "./example-query";
import { ModernizeOutcome, modernize } from "./modernize";
import { schemaFromDatabase } from "./schema-context";
import type { LegacyDialect } from "./types";

const USE_AI_KEY = "goforge.modernizer.ai";
const CONNECTION_KEY = "goforge.modernizer.connection";
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

export type PreviewState = { status: "idle" } | { status: "running" } | { status: "done"; response: PreviewResponse } | { status: "failed"; message: string };

interface Saved {
    dialect: LegacyDialect;
    sql: string;
    outcome: ModernizeOutcome | undefined;
    tab: string;
}

// Switching sidebar pages unmounts this one; keep what the user was working on so coming back isn't a reset.
let saved: Saved | undefined;

/** State and actions behind the Modernizer page. */
export function useModernizer() {
    const { database } = useDatabase();
    const schema = useMemo(() => schemaFromDatabase(database), [database]);

    const [dialect, setDialect] = useState<LegacyDialect>(saved?.dialect ?? "oracle");
    const [sql, setSql] = useState<string>(saved?.sql ?? "");
    const [outcome, setOutcome] = useState<ModernizeOutcome | undefined>(saved?.outcome);
    const [tab, setTab] = useState<string>(saved?.tab ?? "result");
    const [running, setRunning] = useState(false);
    const [stage, setStage] = useState("");
    const [preview, setPreview] = useState<PreviewState>({ status: "idle" });

    const [connections, setConnections] = useState<SavedConnection[]>([]);
    const [connectionId, setConnectionId] = useState<string | undefined>(undefined);
    const [aiStatus, setAiStatus] = useState<AiStatus | undefined>(undefined);
    const [useAi, setUseAi] = useState<boolean>(() => read(USE_AI_KEY) !== "false");

    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        saved = { dialect, sql, outcome, tab };
    }, [dialect, sql, outcome, tab]);

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

    const ghostText = useMemo(() => buildExampleQuery({ dialect, schema }), [dialect, schema]);

    const changeConnection = useCallback((id: string | undefined) => {
        setConnectionId(id);
        write(CONNECTION_KEY, id ?? "none");
    }, []);

    const changeUseAi = useCallback((value: boolean) => {
        setUseAi(value);
        write(USE_AI_KEY, String(value));
    }, []);

    const run = useCallback(async () => {
        if (!sql.trim() || running) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setRunning(true);
        setPreview({ status: "idle" });
        setStage("Converting with the rules");
        try {
            const result = await modernize(
                { sql, dialect, schema },
                {
                    syntax: checkPostgresSyntax,
                    validate: connection ? (text) => validateSqlOnConnection(connection.id, text, controller.signal) : undefined,
                    connectionName: connection?.name,
                    ask: useAi && aiConfigured ? (request) => requestQueryModernization(request, controller.signal) : undefined,
                    onStage: setStage,
                },
            );
            if (controller.signal.aborted) return;
            setOutcome(result);
            setTab("result");
        } catch (error) {
            if (!controller.signal.aborted) toast.error(`Conversion failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setRunning(false);
        }
    }, [sql, dialect, schema, connection, useAi, aiConfigured, running]);

    const stop = useCallback(() => abortRef.current?.abort(), []);

    const previewSql = outcome?.sql;
    const previewBlocker = !connection
        ? "Choose a connection to run it on."
        : !previewSql
          ? "Convert a query first."
          : outcome && outcome.engine.unconverted.length > 0 && outcome.source === "rules"
            ? "Part of the query was not converted, so it would fail."
            : previewSql && neutralizeParameters(previewSql, dialect) !== previewSql
              ? "The query has bind variables (@x, :name, ?). Replace them with values first."
              : undefined;

    const runPreview = useCallback(async () => {
        if (!connection || !previewSql || previewBlocker) return;
        setPreview({ status: "running" });
        try {
            setPreview({ status: "done", response: await previewQueryOnConnection(connection.id, previewSql) });
        } catch (error) {
            setPreview({ status: "failed", message: error instanceof Error ? error.message : String(error) });
        }
    }, [connection, previewSql, previewBlocker]);

    return { dialect, setDialect, sql, setSql, outcome, tab, setTab, running, stage, run, stop, connections, connection, changeConnection, aiStatus, aiConfigured, useAi, changeUseAi, ghostText, schema, preview, runPreview, previewBlocker };
}
