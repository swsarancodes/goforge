import { useCallback } from "react";
import { Node } from "@xyflow/react";
import { eq } from "drizzle-orm";
import { DatabaseDialect } from "@/lib/database";
import {
    CreateConnectionInput,
    SavedConnection,
    createSavedConnection,
    deleteSavedConnection,
    introspectSavedConnection,
    listSavedConnections,
} from "@/lib/live-connection-api";
import { DataType, data_types } from "@/lib/schemas/data-type-schema";
import { TableInsertType } from "@/lib/schemas/table-schema";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { db } from "@/providers/sync-provider/sync-provider";
import { fromIntrospection } from "@/utils/import/from-introspection";
import type { ProjectBundle } from "@/utils/project-file";
import { adjustTablesPositions } from "@/utils/tables";
import { uniqueName } from "./unique-name";

/** Where a connect attempt is, so the dialog can say what it is waiting for. */
export type ConnectPhase = "saving" | "reading" | "drawing";

export interface ConnectedProject {
    databaseId: string;
    name: string;
    tables: number;
}

/**
 * Connecting is "read this database's schema into a new diagram project and open it". It never writes to the
 * database and never reads rows. The password stays with the server; only the saved connection's id travels.
 */
export function useConnectDatabase() {
    const { databases } = useDatabase();
    const { importProject, switchDatabase } = useDatabaseOperations();

    /** Reads the schema behind a saved connection into a new project and opens it. */
    const connectSaved = useCallback(async (connection: Pick<SavedConnection, "id" | "name">, onPhase?: (phase: ConnectPhase) => void): Promise<ConnectedProject> => {
        onPhase?.("reading");
        const introspection = await introspectSavedConnection(connection.id);

        onPhase?.("drawing");
        const dataTypes = (await db.select().from(data_types).where(eq(data_types.dialect, DatabaseDialect.POSTGRES))) as unknown as DataType[];
        const { tables, relationships, indexes, views, sequences, errors } = fromIntrospection(introspection, dataTypes);
        if (errors.length > 0) console.warn("fromIntrospection encountered non-fatal issues:", errors);

        const nodes: Node[] = tables.map((table: TableInsertType) => ({ id: table.id as string, data: { table } })) as any;
        const placed = await adjustTablesPositions(nodes, relationships as any);
        placed.forEach((table, index) => { table.sequence = index; });

        const name = uniqueName(connection.name, databases.map((project) => project.name));
        const databaseId = await importProject({
            name,
            dialect: DatabaseDialect.POSTGRES,
            tables: placed as unknown as ProjectBundle["tables"],
            relationships,
            indexes,
            views,
            sequences,
        });
        switchDatabase(databaseId);
        return { databaseId, name, tables: placed.length };
    }, [databases, importProject, switchDatabase]);

    /**
     * Saves the connection, reads it into a new project and opens it. A connection that could not be used is
     * removed again, so a mistyped string leaves nothing behind (and no password stored on the server).
     */
    const connectNew = useCallback(async (input: CreateConnectionInput, onPhase?: (phase: ConnectPhase) => void): Promise<ConnectedProject> => {
        onPhase?.("saving");
        const taken = (await listSavedConnections()).map((connection) => connection.name);
        const saved = await createSavedConnection({ ...input, name: uniqueName(input.name, taken) });
        try {
            return await connectSaved(saved, onPhase);
        } catch (error) {
            await deleteSavedConnection(saved.id).catch(() => undefined);
            throw error;
        }
    }, [connectSaved]);

    return { connectSaved, connectNew };
}
