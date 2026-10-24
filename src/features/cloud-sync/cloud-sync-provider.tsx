import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { eq } from "drizzle-orm";
import { v4 } from "uuid";
import { databaseGraph } from "@/lib/database-graph";
import { databases as databaseModel, type DatabaseType } from "@/lib/schemas/database-schema";
import { deleteCloudProject, getCloudProject, listCloudProjects, saveCloudProject } from "@/lib/projects-api";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { useAuth } from "@/providers/auth-provider/auth-provider";
import { db } from "@/providers/sync-provider/sync-provider";
import { parseProjectFile, projectToBundle, serializeProject, type ProjectFile } from "@/utils/project-file";
import { hashContent, planSync, readSyncMemory, writeSyncMemory, type SyncMemory } from "./sync-plan";

export interface CloudSyncStatus {
    state: "off" | "syncing" | "saved" | "error";
    lastSyncedAt?: Date;
    error?: string;
}

const CloudSyncContext = createContext<CloudSyncStatus>({ state: "off" });
export const useCloudSyncStatus = () => useContext(CloudSyncContext);

/** How long after the last edit the diagram is saved to the account. */
const SAVE_DELAY_MS = 1500;

const contentHash = (file: ProjectFile) => hashContent(JSON.stringify(file.project));

async function loadLocal(id: string): Promise<ProjectFile | undefined> {
    const rows = await db.query.databases.findMany({ where: eq(databaseModel.id, id), with: databaseGraph });
    return rows[0] ? serializeProject(rows[0] as unknown as DatabaseType) : undefined;
}

/**
 * Keeps the diagrams in this browser and the account's cloud copy the same. When someone signs in, what the cloud has is brought down
 * and what only this browser has is sent up; after that, every edit is saved to the account a moment after it is made, and a diagram
 * deleted here is deleted there. Does nothing without accounts. See `sync-plan.ts` for the rules.
 */
export const CloudSyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const auth = useAuth();
    const { databases, database, isLoading, isSwitchingDatabase } = useDatabase();
    const { importProject, deleteDatabase } = useDatabaseOperations();
    const userId = auth.status === "signed-in" ? auth.user?.id : undefined;

    const [status, setStatus] = useState<CloudSyncStatus>({ state: "off" });
    const [ready, setReady] = useState(false);
    const memory = useRef<SyncMemory>(readSyncMemory());
    const queue = useRef<Promise<unknown>>(Promise.resolve());
    const startedFor = useRef<string | undefined>(undefined);
    const deletedBySync = useRef(new Set<string>());
    const previousIds = useRef<Set<string> | undefined>(undefined);

    const persist = useCallback(() => writeSyncMemory(memory.current), []);

    /** Runs sync work one piece at a time, so a save and a pull never interleave. */
    const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
        const next = queue.current.then(task, task);
        queue.current = next.catch(() => undefined);
        return next;
    }, []);

    const failed = useCallback((error: unknown) => setStatus((current) => ({ ...current, state: "error", error: error instanceof Error ? error.message : String(error) })), []);

    // What the first sync reads when it runs. Refs, so a changing list of diagrams does not start the sync again.
    const databasesRef = useRef(databases);
    databasesRef.current = databases;
    const operations = useRef({ importProject, deleteDatabase });
    operations.current = { importProject, deleteDatabase };
    const retry = useRef<{ timer?: ReturnType<typeof setTimeout>; delayMs: number }>({ delayMs: 10_000 });

    /** First sync after signing in. One diagram that cannot be synced is reported and skipped, never allowed to hold up the rest. */
    const initialSync = useCallback(
        (account: string) =>
            enqueue(async () => {
                const { importProject: bringIn, deleteDatabase: remove } = operations.current;
                let localIds = databasesRef.current.map((project) => project.id);
                const problems: string[] = [];

                // Diagrams in this browser belong to whoever they were last synced for. Another account must not inherit them.
                if (memory.current.ownerId && memory.current.ownerId !== account) {
                    for (const id of localIds) {
                        deletedBySync.current.add(id);
                        await remove(id);
                    }
                    localIds = [];
                    memory.current = { ownerId: account, synced: {} };
                } else {
                    memory.current.ownerId = account;
                }

                const remote = await listCloudProjects();
                const local = (await Promise.all(localIds.map(async (id) => ({ id, file: await loadLocal(id) })))).flatMap(({ id, file }) => (file ? [{ id, file, hash: contentHash(file) }] : []));
                const plan = planSync(local.map(({ id, hash }) => ({ id, hash })), remote.map(({ id, version }) => ({ id, version })), memory.current.synced);
                const nameOf = (id: string) => remote.find((project) => project.id === id)?.name ?? local.find((project) => project.id === id)?.file.project.name ?? id;

                for (const id of plan.deleteLocal) {
                    try {
                        deletedBySync.current.add(id);
                        await remove(id);
                        delete memory.current.synced[id];
                    } catch (error) {
                        problems.push(`${nameOf(id)}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                for (const id of plan.pull) {
                    try {
                        const cloud = await getCloudProject(id);
                        const file = parseProjectFile(JSON.stringify(cloud.document));
                        // Always cleared first, also when there is nothing here by this id: leftovers of an earlier copy would show up inside it.
                        deletedBySync.current.add(id);
                        await remove(id);
                        await bringIn(projectToBundle(file, v4), { id });
                        const stored = await loadLocal(id);
                        memory.current.synced[id] = { version: cloud.version, hash: stored ? contentHash(stored) : contentHash(file) };
                    } catch (error) {
                        problems.push(`${nameOf(id)}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                for (const id of plan.push) {
                    try {
                        const entry = local.find((project) => project.id === id)!;
                        const saved = await saveCloudProject(id, { name: entry.file.project.name, dialect: entry.file.project.dialect, document: entry.file });
                        memory.current.synced[id] = { version: saved.version, hash: entry.hash };
                    } catch (error) {
                        problems.push(`${nameOf(id)}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                persist();
                return problems;
            }),
        [enqueue, persist],
    );

    useEffect(() => {
        if (!userId || isLoading || startedFor.current === userId) return;
        startedFor.current = userId;
        setStatus({ state: "syncing" });

        const attempt = () => {
            initialSync(userId)
                .then((problems) => {
                    retry.current.delayMs = 10_000;
                    previousIds.current = undefined;
                    setReady(true);
                    setStatus(problems.length > 0 ? { state: "error", error: `${problems.length} diagram${problems.length === 1 ? "" : "s"} could not be synced (${problems.slice(0, 2).join("; ")}${problems.length > 2 ? "; …" : ""})` } : { state: "saved", lastSyncedAt: new Date() });
                })
                .catch((error) => {
                    // The server could not be reached or refused the list. Try again later, a little less often each time; not on every redraw.
                    failed(error);
                    retry.current.timer = setTimeout(attempt, retry.current.delayMs);
                    retry.current.delayMs = Math.min(retry.current.delayMs * 2, 5 * 60_000);
                });
        };
        attempt();
    }, [userId, isLoading, initialSync, failed]);

    useEffect(() => () => clearTimeout(retry.current.timer), []);

    // The open diagram is saved a moment after the last edit.
    useEffect(() => {
        if (!ready || !userId || !database || isSwitchingDatabase) return;
        const timer = setTimeout(() => {
            void enqueue(async () => {
                const file = serializeProject(database);
                const hash = contentHash(file);
                if (memory.current.synced[database.id]?.hash === hash) return;
                setStatus((current) => ({ ...current, state: "syncing" }));
                const saved = await saveCloudProject(database.id, { name: file.project.name, dialect: file.project.dialect, document: file });
                memory.current.synced[database.id] = { version: saved.version, hash };
                persist();
                setStatus({ state: "saved", lastSyncedAt: new Date() });
            }).catch(failed);
        }, SAVE_DELAY_MS);
        return () => clearTimeout(timer);
    }, [database, ready, userId, isSwitchingDatabase, enqueue, persist, failed]);

    // A diagram deleted here is deleted from the account.
    useEffect(() => {
        if (!ready || !userId || isLoading) return;
        const ids = new Set(databases.map((project) => project.id));
        const before = previousIds.current;
        previousIds.current = ids;
        if (!before) return;
        for (const id of before) {
            if (ids.has(id) || deletedBySync.current.has(id) || !memory.current.synced[id]) continue;
            delete memory.current.synced[id];
            persist();
            void enqueue(() => deleteCloudProject(id)).catch(failed);
        }
    }, [databases, ready, userId, isLoading, enqueue, persist, failed]);

    // Signing out (or never signing in): nothing to keep in step.
    useEffect(() => {
        if (userId) return;
        clearTimeout(retry.current.timer);
        retry.current.delayMs = 10_000;
        startedFor.current = undefined;
        previousIds.current = undefined;
        setReady(false);
        setStatus({ state: "off" });
    }, [userId]);

    const value = useMemo(() => status, [status]);
    return <CloudSyncContext.Provider value={value}>{children}</CloudSyncContext.Provider>;
};
