import { compare, Operation } from "fast-json-patch";
import { init } from "@guanmingchiu/sqlparser-ts";

import { DataType } from "@/lib/schemas/data-type-schema";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { DBDiffOperation, mapDiffToDBDiffOperation, normalizeDatabase } from "@/utils/database";
import { getImporter } from "./import-utils";
import { reconcileWithDatabase } from "./reconcile-with-database";

export interface PreparedSqlSchemaChange {
    targetDatabase: DatabaseType;
    differences: Operation[];
    operations: DBDiffOperation[];
    destructiveOperations: DBDiffOperation[];
    warnings: string[];
}

const DESTRUCTIVE_SQL_OPERATION_TYPES = new Set<DBDiffOperation["type"]>(["DELETE_TABLE", "DELETE_FIELD", "DELETE_RELATIONSHIP", "DELETE_INDEX"]);

export const isDestructiveSqlOperation = (operation: DBDiffOperation) => DESTRUCTIVE_SQL_OPERATION_TYPES.has(operation.type);

/**
 * Compile pasted or edited DDL into the same typed operations used by undo,
 * redo, and AI schema changes. This function is intentionally pure so parsing,
 * reconciliation, placement, and diff behavior stay consistent across every UI.
 */
let sqlParserReady: Promise<unknown> | undefined;

export async function prepareSqlSchemaChange(draftSql: string, currentDatabase: DatabaseType, dataTypes: DataType[]): Promise<PreparedSqlSchemaChange> {
    if (!draftSql.trim()) throw new Error("Paste or enter SQL before applying changes.");

    sqlParserReady ??= Promise.resolve(init());
    await sqlParserReady;

    const importer = getImporter(currentDatabase.dialect, dataTypes);
    if (!importer) throw new Error(`SQL import is not available for ${currentDatabase.dialect}.`);

    const parsed = importer.parseSql(draftSql);
    if (parsed.tables.length === 0) throw new Error("Could not find any CREATE TABLE statements in this SQL.");

    const reconciled = reconcileWithDatabase(parsed, currentDatabase, dataTypes);
    const existingTableIds = new Set(currentDatabase.tables.map((table) => table.id));
    const maxX = currentDatabase.tables.reduce((max, table) => Math.max(max, (table.posX ?? 0) + (table.width ?? 260)), 0);
    let nextSequence = currentDatabase.tables.length === 0 ? 0 : Math.max(...currentDatabase.tables.map((table) => table.sequence)) + 1;
    let newTableIndex = 0;

    const targetDatabase: DatabaseType = {
        ...currentDatabase,
        numOfTables: reconciled.tables.length,
        tables: reconciled.tables.map((table) => {
            const indices = reconciled.indexes.filter((index) => index.tableId === table.id);
            if (existingTableIds.has(table.id as string)) return { ...table, indices } as any;

            const column = newTableIndex % 3;
            const row = Math.floor(newTableIndex / 3);
            newTableIndex += 1;
            return {
                ...table,
                posX: table.posX ?? maxX + 80 + column * 320,
                posY: table.posY ?? row * 280,
                sequence: nextSequence++,
                indices,
            } as any;
        }),
        relationships: reconciled.relationships as any,
    };

    const differences = compare(normalizeDatabase(currentDatabase), normalizeDatabase(targetDatabase));
    const operations = mapDiffToDBDiffOperation(differences);
    return {
        targetDatabase,
        differences,
        operations,
        destructiveOperations: operations.filter(isDestructiveSqlOperation),
        warnings: Array.isArray((parsed as any).errors) ? (parsed as any).errors.map(String) : [],
    };
}
