import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AiStatus, fetchAiStatus, requestQueryModernization } from "@/lib/ai-api";
import { SavedConnection, listSavedConnections } from "@/lib/live-connection-api";
import { PreviewResponse, previewQueryOnConnection, validateSqlOnConnection } from "@/lib/modernizer-api";
import { useDatabase } from "@/providers/database-provider/database-provider";
import { checkPostgresSyntax } from "./engine/checks";
import { neutralizeParameters } from "./engine/convert";
import { buildExampleQuery } from "./example-query";
import { takeQueryHandoff } from "./query-handoff";
import { ModernizeOutcome, modernize } from "./modernize";
import { schemaFromDatabase } from "./schema-context";
import type { LegacyDialect } from "./types";

const USE_AI_KEY = "goforge.modernizer.ai";
const MODE_KEY = "goforge.modernizer.mode";
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

/** Who writes the PostgreSQL: the rules alone, the rules with the model for what they cannot do (the default), or the model. */
export type ModernizeMode = "rules" | "auto" | "ai";

const isMode = (value: string | null): value is ModernizeMode => value === "rules" || value === "auto" || value === "ai";
// Before there were three modes there was one switch, "use AI for the rest".
const initialMode = (): ModernizeMode => {
    const stored = read(MODE_KEY);
    return isMode(stored) ? stored : read(USE_AI_KEY) === "false" ? "rules" : "auto";
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
    // A statement sent over from the script view replaces what was here.
    const [handoff] = useState(() => takeQueryHandoff());
    const schema = useMemo(() => schemaFromDatabase(database), [database]);

    const [dialect, setDialect] = useState<LegacyDialect>(handoff?.dialect ?? saved?.dialect ?? "oracle");
    const [sql, setSql] = useState<string>(handoff?.sql ?? saved?.sql ?? "");
    const [outcome, setOutcome] = useState<ModernizeOutcome | undefined>(handoff ? undefined : saved?.outcome);
    const [tab, setTab] = useState<string>(saved?.tab ?? "result");
    const [running, setRunning] = useState(false);
    const [stage, setStage] = useState("");
    const [preview, setPreview] = useState<PreviewState>({ status: "idle" });

    const [connections, setConnections] = useState<SavedConnection[]>([]);
    const [connectionId, setConnectionId] = useState<string | undefined>(undefined);
    const [aiStatus, setAiStatus] = useState<AiStatus | undefined>(undefined);
    const [chosenMode, setChosenMode] = useState<ModernizeMode>(initialMode);

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
    // The model modes need a model. Without one the rules do everything, whatever was chosen.
    const mode: ModernizeMode = aiConfigured ? chosenMode : "rules";

    const ghostText = useMemo(() => buildExampleQuery({ dialect, schema }), [dialect, schema]);

    const changeConnection = useCallback((id: string | undefined) => {
        setConnectionId(id);
        write(CONNECTION_KEY, id ?? "none");
    }, []);

    const changeMode = useCallback((value: ModernizeMode) => {
        setChosenMode(value);
        write(MODE_KEY, value);
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
                    ask: mode !== "rules" ? (request) => requestQueryModernization(request, controller.signal) : undefined,
                    aiFirst: mode === "ai",
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
    }, [sql, dialect, schema, connection, mode, running]);

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

    return { dialect, setDialect, sql, setSql, outcome, tab, setTab, running, stage, run, stop, connections, connection, changeConnection, aiStatus, aiConfigured, mode, chosenMode, changeMode, ghostText, schema, preview, runPreview, previewBlocker };
}
