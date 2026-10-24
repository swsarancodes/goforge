import { compare, Operation } from "fast-json-patch";
import { init } from "@guanmingchiu/sqlparser-ts";

import { DataType } from "@/lib/schemas/data-type-schema";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { DBDiffOperation, mapDiffToDBDiffOperation, normalizeDatabase } from "@/utils/database";
import { getImporter } from "./import-utils";
import { ParsedDatabaseResult, reconcileWithDatabase } from "./reconcile-with-database";

export interface PreparedSqlSchemaChange {
    targetDatabase: DatabaseType;
    differences: Operation[];
    operations: DBDiffOperation[];
    destructiveOperations: DBDiffOperation[];
    warnings: string[];
}

const DESTRUCTIVE_SQL_OPERATION_TYPES = new Set<DBDiffOperation["type"]>(["DELETE_TABLE", "DELETE_FIELD", "DELETE_RELATIONSHIP", "DELETE_INDEX", "DELETE_CHECK", "DELETE_VIEW", "DELETE_SEQUENCE"]);

export const isDestructiveSqlOperation = (operation: DBDiffOperation) => DESTRUCTIVE_SQL_OPERATION_TYPES.has(operation.type);

// DBML declares objects as `Table name {`, `Enum name {`, `Project name {` or `Ref: a.b > c.d`; DDL never has a brace there.
const DBML_BLOCK = /^[ \t]*(?:table|enum|project|tablegroup|tablepartial)[ \t]+[^\s{]+(?:[ \t]+as[ \t]+\S+)?(?:[ \t]*\[[^\]\n]*\])?[ \t]*\{/im;
const DBML_REF = /^[ \t]*ref(?:[ \t]+\w+)?[ \t]*(?::|\{)/im;

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*(?:\/\/|--).*$/gm, "");

/** True when pasted text is DBML rather than SQL, so the editor can accept both. */
export const looksLikeDbml = (text: string): boolean => {
    const code = stripComments(text);
    return DBML_BLOCK.test(code) || DBML_REF.test(code);
};

/**
 * Compile pasted or edited DDL (or DBML) into the same typed operations used by undo,
 * redo, and AI schema changes. This function is intentionally pure so parsing,
 * reconciliation, placement, and diff behavior stay consistent across every UI.
 */
let sqlParserReady: Promise<unknown> | undefined;

export async function prepareSqlSchemaChange(draftSql: string, currentDatabase: DatabaseType, dataTypes: DataType[]): Promise<PreparedSqlSchemaChange> {
    if (!draftSql.trim()) throw new Error("Paste or enter SQL before applying changes.");
    if (looksLikeDbml(draftSql)) return prepareDbmlSchemaChange(draftSql, currentDatabase, dataTypes);

    sqlParserReady ??= Promise.resolve(init());
    await sqlParserReady;

    const importer = getImporter(currentDatabase.dialect, dataTypes);
    if (!importer) throw new Error(`SQL import is not available for ${currentDatabase.dialect}.`);

    const parsed = importer.parseSql(draftSql);
    if (parsed.tables.length === 0 && parsed.views.length === 0 && parsed.sequences.length === 0) {
        throw new Error("Could not find any supported schema objects in this SQL.");
    }

    return prepareParsedSchemaChange(parsed, currentDatabase, dataTypes, Array.isArray((parsed as any).errors) ? (parsed as any).errors.map(String) : []);
}

/**
 * Reads pasted DBML against the open project's dialect and diffs it like DDL: what the
 * text does not mention is reported as a removal, so the caller's review step applies.
 * DBML has no layout, so new tables are laid out and placed beside any existing diagram.
 */
async function prepareDbmlSchemaChange(text: string, currentDatabase: DatabaseType, dataTypes: DataType[]): Promise<PreparedSqlSchemaChange> {
    const [{ DbmlParseError, parseDbml }, { layoutProjectFile }, { projectToBundle }, { dialectFromDatabaseType }, { v4 }] = await Promise.all([
        import("@/utils/dbml/from-dbml"),
        import("@/utils/dbml/layout-project"),
        import("@/utils/project-file"),
        import("@/utils/dbml/dbml-shared"),
        import("uuid"),
    ]);

    let imported;
    try {
        imported = await parseDbml(text, { dialect: currentDatabase.dialect, dataTypes, fallbackName: currentDatabase.name });
    } catch (error) {
        if (error instanceof DbmlParseError) throw new Error([error.message, ...error.details.slice(0, 3)].join(" "));
        throw error;
    }
    if (imported.file.project.tables.length === 0) throw new Error("Could not find any tables in this DBML.");

    const warnings = imported.warnings.map((warning) => warning.message);
    const declared = dialectFromDatabaseType(imported.databaseType);
    if (imported.databaseType && declared !== currentDatabase.dialect) {
        warnings.unshift(`This DBML is for ${imported.databaseType}; its types were read as ${currentDatabase.dialect}.`);
    }

    const laidOut = await layoutProjectFile(imported.file);
    const bundle = projectToBundle(laidOut, v4);
    const maxX = currentDatabase.tables.reduce((max, table) => Math.max(max, (table.posX ?? 0) + (table.width ?? 260)), 0);
    const offsetX = currentDatabase.tables.length === 0 ? 0 : maxX + 80;

    return prepareParsedSchemaChange(
        {
            tables: bundle.tables.map((table) => ({ ...table, posX: (table.posX ?? 0) + offsetX })) as any,
            relationships: bundle.relationships,
            indexes: bundle.indexes,
            views: bundle.views,
            sequences: bundle.sequences,
        },
        currentDatabase,
        dataTypes,
        warnings,
    );
}

/**
 * Reconciles an already-parsed schema (from SQL, DBML, a project file...) with the
 * current database and diffs the two. New tables with no position of their own are
 * placed to the right of the existing diagram.
 */
export function prepareParsedSchemaChange(parsed: ParsedDatabaseResult, currentDatabase: DatabaseType, dataTypes: DataType[], warnings: string[] = []): PreparedSqlSchemaChange {
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
        views: reconciled.views,
        sequences: reconciled.sequences,
    };

    const differences = compare(normalizeDatabase(currentDatabase), normalizeDatabase(targetDatabase));
    const operations = mapDiffToDBDiffOperation(differences);
    return {
        targetDatabase,
        differences,
        operations,
        destructiveOperations: operations.filter(isDestructiveSqlOperation),
        warnings,
    };
}

/** The same change without anything that deletes: objects missing from the source are kept. */
export function withoutDeletions(change: PreparedSqlSchemaChange): PreparedSqlSchemaChange {
    const operations = change.operations.filter((operation) => !isDestructiveSqlOperation(operation));
    return { ...change, operations, destructiveOperations: [] };
}
