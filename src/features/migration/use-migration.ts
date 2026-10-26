import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rememberDataConnection } from "@/features/data-browser/use-data-browser";
import { rememberConnectionOnPages } from "@/features/database/live-database";
import { SavedConnection, listSavedConnections } from "@/lib/live-connection-api";
import { MigrationEdits, MigrationOutcome, MigrationPlanPreview, NO_EDITS, TableVerification, askMigrationAgent, migrateOracleToPostgres, planOracleMigration, verifyMigration } from "@/lib/migrations-api";
import { useAuth } from "@/providers/auth-provider/auth-provider";

export const CLOUD = "cloud";

/** One line of the conversation: what the person said, what the assistant answered, what it changed and what it refused. */
export interface ChatLine {
    id: number;
    role: "user" | "assistant" | "error";
    text: string;
    applied?: string[];
    rejected?: { operation: string; reason: string }[];
}

// Leaving the page keeps the chosen database, so coming back does not mean picking it again.
let remembered: string | undefined;

/** Opens the migration page on this Oracle database the next time it is shown. */
export const rememberMigrationSource = (connectionId: string): void => {
    remembered = connectionId;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** State and actions behind the migration page: the Oracle database, the plan and the changes made to it, the conversation, the migration and its proof. */
export function useMigration() {
    const auth = useAuth();
    const cloudAvailable = auth.cloudDatabases !== undefined;

    const [oracleDatabases, setOracleDatabases] = useState<SavedConnection[]>([]);
    const [loadingDatabases, setLoadingDatabases] = useState(true);
    const [sourceId, setSourceId] = useState<string | undefined>(undefined);

    const [edits, setEdits] = useState<MigrationEdits>(NO_EDITS);
    const [plan, setPlan] = useState<MigrationPlanPreview | undefined>(undefined);
    const [planError, setPlanError] = useState<string | undefined>(undefined);
    const [loadingPlan, setLoadingPlan] = useState(false);

    const [lines, setLines] = useState<ChatLine[]>([]);
    const [asking, setAsking] = useState(false);
    const nextLine = useRef(1);

    const [servers, setServers] = useState<SavedConnection[]>([]);
    const [target, setTarget] = useState("");
    const [name, setName] = useState("");
    const [acceptLoss, setAcceptLoss] = useState(false);
    const [migrating, setMigrating] = useState(false);
    const [migrateError, setMigrateError] = useState<string | undefined>(undefined);
    const [outcome, setOutcome] = useState<MigrationOutcome | undefined>(undefined);
    const [proof, setProof] = useState<TableVerification[] | undefined>(undefined);
    const [rerunning, setRerunning] = useState(false);

    // a request that is no longer the latest one must not overwrite a newer answer
    const latest = useRef(0);

    const source = useMemo(() => oracleDatabases.find((connection) => connection.id === sourceId), [oracleDatabases, sourceId]);

    useEffect(() => {
        let current = true;
        listSavedConnections("oracle")
            .then((list) => {
                if (!current) return;
                setOracleDatabases(list);
                setSourceId(list.find((connection) => connection.id === remembered)?.id ?? (list.length === 1 ? list[0].id : undefined));
            })
            .catch((error) => current && setPlanError(messageOf(error)))
            .finally(() => current && setLoadingDatabases(false));
        listSavedConnections()
            .then((list) => {
                if (!current) return;
                const own = list.filter((candidate) => candidate.kind !== "cloud");
                setServers(own);
                setTarget((previous) => previous || (cloudAvailable ? CLOUD : (own[0]?.id ?? "")));
            })
            .catch(() => undefined);
        return () => {
            current = false;
        };
        // read once; the account's quota arrives with the session
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const reset = useCallback(() => {
        latest.current++;
        setEdits(NO_EDITS);
        setPlan(undefined);
        setPlanError(undefined);
        setLines([]);
        setAcceptLoss(false);
        setMigrateError(undefined);
        setOutcome(undefined);
        setProof(undefined);
    }, []);

    const loadPlan = useCallback(async (id: string, withEdits: MigrationEdits) => {
        const run = ++latest.current;
        setLoadingPlan(true);
        setPlanError(undefined);
        try {
            const result = await planOracleMigration(id, withEdits);
            if (run === latest.current) setPlan(result);
        } catch (error) {
            if (run === latest.current) setPlanError(messageOf(error));
        } finally {
            if (run === latest.current) setLoadingPlan(false);
        }
    }, []);

    // choosing another database starts over: its own plan, no changes, an empty conversation
    useEffect(() => {
        reset();
        if (!sourceId) return;
        remembered = sourceId;
        const connection = oracleDatabases.find((candidate) => candidate.id === sourceId);
        setName(`${connection?.name ?? "database"} postgres`.slice(0, 60));
        void loadPlan(sourceId, NO_EDITS);
    }, [sourceId, oracleDatabases, reset, loadPlan]);

    const push = useCallback((line: Omit<ChatLine, "id">) => setLines((existing) => [...existing, { ...line, id: nextLine.current++ }]), []);

    const ask = useCallback(
        async (message: string) => {
            if (!sourceId || asking || outcome) return;
            const text = message.trim();
            if (!text) return;
            const history = lines.filter((line): line is ChatLine & { role: "user" | "assistant" } => line.role !== "error").map((line) => ({ role: line.role, text: line.text }));
            push({ role: "user", text });
            setAsking(true);
            const run = ++latest.current;
            try {
                const answer = await askMigrationAgent({ sourceConnectionId: sourceId, message: text, messages: history, edits });
                if (run !== latest.current) return;
                setEdits(answer.edits);
                setPlan(answer.plan);
                setAcceptLoss(false);
                push({ role: "assistant", text: answer.reply, applied: answer.applied, rejected: answer.rejected });
            } catch (error) {
                if (run === latest.current) push({ role: "error", text: messageOf(error) });
            } finally {
                setAsking(false);
            }
        },
        [sourceId, asking, outcome, lines, edits, push],
    );

    const undoAll = useCallback(() => {
        if (!sourceId || outcome) return;
        setEdits(NO_EDITS);
        setAcceptLoss(false);
        push({ role: "assistant", text: "Every change is undone: the plan is back to what GoForge proposed." });
        void loadPlan(sourceId, NO_EDITS);
    }, [sourceId, outcome, push, loadPlan]);

    const failing = useMemo(() => (plan ? plan.tables.flatMap((table) => table.columns.flatMap((column) => (column.check && (column.check.count === null || column.check.count > 0) ? [{ table: table.pgName, column: column.pgName, check: column.check }] : []))) : []), [plan]);

    const canMigrate = Boolean(plan && plan.problems.length === 0 && plan.tables.length > 0 && target && name.trim() && !migrating && !outcome && !loadingPlan && !asking && (failing.length === 0 || acceptLoss));

    const migrate = useCallback(async () => {
        if (!sourceId || !canMigrate) return;
        setMigrating(true);
        setMigrateError(undefined);
        try {
            const done = await migrateOracleToPostgres({ sourceConnectionId: sourceId, name: name.trim(), target: target === CLOUD ? { kind: "cloud" } : { kind: "server", connectionId: target }, edits, acceptLoss });
            setOutcome(done);
            setProof(done.verification);
            rememberConnectionOnPages(done.connection.id);
            rememberDataConnection(done.connection.id);
            if (target === CLOUD) await auth.refresh();
        } catch (error) {
            setMigrateError(messageOf(error));
        } finally {
            setMigrating(false);
        }
    }, [sourceId, canMigrate, name, target, edits, acceptLoss, auth]);

    const rerunProof = useCallback(async () => {
        if (!sourceId || !outcome) return;
        setRerunning(true);
        setMigrateError(undefined);
        try {
            setProof((await verifyMigration({ sourceConnectionId: sourceId, targetConnectionId: outcome.connection.id, edits })).verification);
        } catch (error) {
            setMigrateError(messageOf(error));
        } finally {
            setRerunning(false);
        }
    }, [sourceId, outcome, edits]);

    return {
        oracleDatabases, loadingDatabases, sourceId, setSourceId, source,
        edits, plan, planError, loadingPlan,
        lines, asking, ask, undoAll,
        servers, cloudAvailable, target, setTarget, name, setName,
        failing, acceptLoss, setAcceptLoss, canMigrate, migrating, migrateError, migrate,
        outcome, proof, rerunning, rerunProof,
    };
}

export type Migration = ReturnType<typeof useMigration>;
