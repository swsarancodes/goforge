import { loadDatabaseGraph } from "@/lib/database-graph";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { MigrationInsertType, MigrationType, schema_migrations, schema_snapshots, SnapshotType } from "@/lib/schemas/version-history-schema";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { db } from "@/providers/sync-provider/sync-provider";
import { DBDiffOperation } from "@/utils/database";
import { getRenderer } from "@/utils/render/render-uttils";
import { downloadTextFile } from "@/utils/file";
import { formatMigrationFile, generateMigration, migrationChecksum, migrationFileStem, NoSchemaChangesError, UnsupportedMigrationError } from "@/utils/versioning/generate-migration";
import { restoreOperations } from "@/utils/versioning/restore";
import { draftSnapshot, readSnapshot, snapshotToDatabase, verifySnapshot } from "@/utils/versioning/snapshot";
import { getTimestamp } from "@/utils/utils";
import { toCompilableQuery } from "@powersync/drizzle-driver";
import { useQuery } from "@powersync/react";
import { and, desc, eq, max, or } from "drizzle-orm";
import { useCallback, useMemo } from "react";
import { v4 } from "uuid";

/** A snapshot without its (large) content, which is only read when needed. */
export type SnapshotSummary = Omit<SnapshotType, "content">;

const summaryColumns = {
    id: schema_snapshots.id,
    databaseId: schema_snapshots.databaseId,
    name: schema_snapshots.name,
    note: schema_snapshots.note,
    kind: schema_snapshots.kind,
    dialect: schema_snapshots.dialect,
    fingerprint: schema_snapshots.fingerprint,
    hash: schema_snapshots.hash,
    tableCount: schema_snapshots.tableCount,
    createdAt: schema_snapshots.createdAt,
};

export type MigrationOrigin = "manual" | "sql-editor" | "import" | "restore";

export interface RecordedMigration {
    migrationId?: string;
    /** Why no migration was recorded, when the change was applied but SQL could not be written. */
    skippedReason?: string;
}

/**
 * Local version history of the open project: immutable snapshots of its schema and the
 * migrations (up/down SQL) between them. Everything is stored in the project's own local
 * database, next to the schema it describes.
 */
export const useVersionHistoryActions = () => {
    const { database } = useDatabase();
    const { executeDbDiffOps, data_types } = useDatabaseOperations();
    const databaseId = database?.id;

    const renderer = useMemo(() => (database ? getRenderer(database.dialect, data_types) : undefined), [database?.dialect, data_types]);

    const readCurrent = useCallback(async (): Promise<DatabaseType> => {
        if (!databaseId) throw new Error("Open a project first.");
        const current = await loadDatabaseGraph(db, databaseId);
        if (!current) throw new Error("The open project could not be read.");
        return current;
    }, [databaseId]);

    /**
     * Freezes the project as it is now. When nothing changed since the latest snapshot,
     * that snapshot is returned instead of storing a duplicate.
     */
    const saveSnapshot = useCallback(async (
        input: { name: string; note?: string | null; kind?: "manual" | "auto" },
        source?: DatabaseType,
    ): Promise<{ id: string; name: string; created: boolean }> => {
        const current = source ?? await readCurrent();
        const draft = await draftSnapshot(current);
        // A manual snapshot only repeats the latest one. Bookkeeping snapshots (before/after a
        // change) may reuse any earlier snapshot of the same schema, so a restore points
        // straight at the version it restored.
        const kind = input.kind ?? "manual";
        const matching = await db.select(summaryColumns).from(schema_snapshots)
            .where(kind === "auto"
                ? and(eq(schema_snapshots.databaseId, current.id), eq(schema_snapshots.fingerprint, draft.fingerprint))
                : eq(schema_snapshots.databaseId, current.id))
            .orderBy(desc(schema_snapshots.createdAt)).limit(1);
        const [latest] = matching;
        if (latest && latest.fingerprint === draft.fingerprint) return { id: latest.id, name: latest.name, created: false };

        const id = v4();
        await db.insert(schema_snapshots).values({
            id,
            databaseId: current.id,
            name: input.name.trim() || "Snapshot",
            note: input.note?.trim() || null,
            kind,
            dialect: draft.dialect,
            fingerprint: draft.fingerprint,
            hash: draft.hash,
            content: draft.content,
            tableCount: draft.tableCount,
            createdAt: getTimestamp(),
        });
        return { id, name: input.name.trim() || "Snapshot", created: true };
    }, [readCurrent]);

    const loadSnapshot = useCallback(async (id: string) => {
        const [row] = await db.select().from(schema_snapshots).where(eq(schema_snapshots.id, id));
        if (!row) throw new Error("That snapshot no longer exists.");
        if (!(await verifySnapshot(row))) throw new Error(`Snapshot "${row.name}" does not match the hash it was saved with, so it was changed after it was frozen. It will not be used.`);
        return { row, file: readSnapshot(row) };
    }, []);

    /** The snapshot as a database object, for comparing or restoring against the open project. */
    const snapshotAsDatabase = useCallback(async (id: string, current: DatabaseType) => {
        const { row, file } = await loadSnapshot(id);
        return { row, database: snapshotToDatabase(file, current, data_types) };
    }, [loadSnapshot, data_types]);

    const renameSnapshot = useCallback(async (id: string, name: string, note?: string | null) => {
        await db.update(schema_snapshots).set({ name: name.trim() || "Snapshot", note: note?.trim() || null }).where(eq(schema_snapshots.id, id));
    }, []);

    /** Snapshots a migration still points at must stay, or its history would dangle. */
    const deleteSnapshot = useCallback(async (id: string) => {
        const using = await db.select({ sequence: schema_migrations.sequence }).from(schema_migrations)
            .where(or(eq(schema_migrations.sourceSnapshotId, id), eq(schema_migrations.targetSnapshotId, id)));
        if (using.length > 0) {
            throw new Error(`This snapshot is used by migration ${using.map((migration) => String(migration.sequence).padStart(4, "0")).join(", ")}. Delete that migration first.`);
        }
        await db.delete(schema_snapshots).where(eq(schema_snapshots.id, id));
    }, []);

    const deleteMigration = useCallback(async (id: string) => {
        await db.delete(schema_migrations).where(eq(schema_migrations.id, id));
    }, []);

    /** Writes the SQL between two snapshots and stores it with links to both. */
    const createMigration = useCallback(async (input: {
        name: string;
        description?: string | null;
        sourceSnapshotId: string;
        targetSnapshotId: string;
        origin?: MigrationOrigin;
    }): Promise<string> => {
        if (!renderer) throw new Error("Open a project first.");
        if (input.sourceSnapshotId === input.targetSnapshotId) throw new NoSchemaChangesError();
        const current = await readCurrent();
        const [source, target] = await Promise.all([
            snapshotAsDatabase(input.sourceSnapshotId, current),
            snapshotAsDatabase(input.targetSnapshotId, current),
        ]);
        const generated = await generateMigration(renderer, source.database, target.database);

        const [{ latest }] = await db.select({ latest: max(schema_migrations.sequence) }).from(schema_migrations).where(eq(schema_migrations.databaseId, current.id));
        const id = v4();
        const row: MigrationInsertType = {
            id,
            databaseId: current.id,
            sequence: (latest ?? 0) + 1,
            name: input.name.trim() || "Migration",
            description: input.description?.trim() || null,
            origin: input.origin ?? "manual",
            sourceSnapshotId: input.sourceSnapshotId,
            targetSnapshotId: input.targetSnapshotId,
            upSql: generated.upSql,
            downSql: generated.downSql,
            downBlockedReason: generated.downBlockedReason,
            checksum: await migrationChecksum(generated.upSql, generated.downSql),
            dialect: current.dialect,
            createdAt: getTimestamp(),
        };
        await db.insert(schema_migrations).values(row);
        return id;
    }, [renderer, readCurrent, snapshotAsDatabase]);

    /** Migration between an older snapshot and the project as it is now. */
    const createMigrationToCurrent = useCallback(async (input: { name: string; description?: string | null; sourceSnapshotId: string }) => {
        const target = await saveSnapshot({ name: `State at ${getTimestamp()}`, kind: "auto" });
        return createMigration({ ...input, targetSnapshotId: target.id });
    }, [saveSnapshot, createMigration]);

    /**
     * Applies a reviewed set of operations and records what happened: a snapshot before, a
     * snapshot after, and the migration between them. The change itself is already one
     * undoable step; recording never makes it fail.
     */
    const applyRecorded = useCallback(async (operations: DBDiffOperation[], meta: { name: string; origin: MigrationOrigin; description?: string }): Promise<RecordedMigration> => {
        const before = await saveSnapshot({ name: `Before: ${meta.name}`, kind: "auto" });
        await executeDbDiffOps(operations);
        try {
            const after = await saveSnapshot({ name: `After: ${meta.name}`, kind: "auto" });
            if (before.id === after.id) return {};
            const migrationId = await createMigration({ name: meta.name, description: meta.description, sourceSnapshotId: before.id, targetSnapshotId: after.id, origin: meta.origin });
            return { migrationId };
        } catch (error) {
            if (error instanceof NoSchemaChangesError) return {};
            return { skippedReason: error instanceof Error ? error.message : String(error) };
        }
    }, [saveSnapshot, executeDbDiffOps, createMigration]);

    /**
     * Brings the project back to a snapshot as one undoable step. The current state is
     * snapshotted first, so a restore can itself be reverted.
     */
    const restoreSnapshot = useCallback(async (id: string): Promise<RecordedMigration> => {
        const current = await readCurrent();
        const { row, database: target } = await snapshotAsDatabase(id, current);
        const operations = restoreOperations(current, target);
        if (operations.length === 0) return {};
        return applyRecorded(operations, { name: `Restore "${row.name}"`, origin: "restore" });
    }, [readCurrent, snapshotAsDatabase, applyRecorded]);

    /** What differs between two snapshots, or a snapshot and the open project (`"current"`). */
    const compareVersions = useCallback(async (fromId: string | "current", toId: string | "current") => {
        const current = await readCurrent();
        const side = async (id: string | "current") => (id === "current" ? current : (await snapshotAsDatabase(id, current)).database);
        const [from, to] = await Promise.all([side(fromId), side(toId)]);
        return { from, to, operations: restoreOperations(from, to) };
    }, [readCurrent, snapshotAsDatabase]);

    return {
        saveSnapshot,
        renameSnapshot,
        deleteSnapshot,
        deleteMigration,
        createMigration,
        createMigrationToCurrent,
        applyRecorded,
        restoreSnapshot,
        compareVersions,
    };
};

/** The actions plus live lists of the open project's snapshots and migrations. */
const useVersionHistory = () => {
    const { database } = useDatabase();
    const databaseId = database?.id;
    const actions = useVersionHistoryActions();

    const { data: snapshots = [], isLoading: loadingSnapshots } = useQuery(toCompilableQuery(
        db.select(summaryColumns).from(schema_snapshots).where(eq(schema_snapshots.databaseId, databaseId ?? "")).orderBy(desc(schema_snapshots.createdAt)),
    ), [], { runQueryOnce: false });

    const { data: migrations = [], isLoading: loadingMigrations } = useQuery(toCompilableQuery(
        db.select().from(schema_migrations).where(eq(schema_migrations.databaseId, databaseId ?? "")).orderBy(desc(schema_migrations.sequence)),
    ), [], { runQueryOnce: false });

    const downloadMigration = useCallback((migration: MigrationType, direction: "up" | "down") => {
        const names = {
            source: (snapshots as SnapshotSummary[]).find((snapshot) => snapshot.id === migration.sourceSnapshotId)?.name,
            target: (snapshots as SnapshotSummary[]).find((snapshot) => snapshot.id === migration.targetSnapshotId)?.name,
        };
        downloadTextFile(formatMigrationFile(migration, direction, names), `${migrationFileStem(migration.sequence, migration.name)}.${direction}.sql`, "application/sql");
    }, [snapshots]);

    return {
        ...actions,
        snapshots: snapshots as SnapshotSummary[],
        migrations: migrations as MigrationType[],
        isLoading: loadingSnapshots || loadingMigrations,
        downloadMigration,
    };
};

export { NoSchemaChangesError, UnsupportedMigrationError };
export default useVersionHistory;
