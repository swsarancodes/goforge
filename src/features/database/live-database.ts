import { DatabaseDialect } from "@/lib/database";
import type { DataType } from "@/lib/schemas/data-type-schema";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import { qualifiedTableName } from "@/lib/schemas/table-schema";
import { prepareParsedSchemaChange } from "@/utils/import/prepare-sql-schema-change";
import type { ParsedDatabaseResult } from "@/utils/import/reconcile-with-database";
import { getRenderer } from "@/utils/render/render-uttils";
import { canConvertToPostgres, convertOracleToPostgres, postgresDataTypes } from "./to-postgres";

/** A name PostgreSQL accepts for a database that this API will create (the server checks the same rule). */
export const isValidDatabaseName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name);

/** `My Shop (2)` becomes `my_shop_2`: a database name suggested from the diagram's name. */
export const suggestDatabaseName = (name: string | undefined | null): string => {
    const snake = (name ?? "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 63)
        .replace(/_+$/g, "");
    if (!snake) return "database";
    return /^[0-9]/.test(snake) ? `db_${snake}`.slice(0, 63) : snake;
};

/** PostgreSQL diagrams can become a live database as they are, and Oracle diagrams after a conversion to PostgreSQL (see to-postgres.ts). */
export const canCreateLiveDatabase = (dialect: DatabaseDialect | undefined): boolean => dialect === DatabaseDialect.POSTGRES || canConvertToPostgres(dialect);

/** The schema script that builds `database` from nothing, to run in a new live database. An Oracle schema is converted to PostgreSQL first. */
export async function liveSchemaSql(database: DatabaseType, dataTypes: DataType[]): Promise<string> {
    if (!canCreateLiveDatabase(database.dialect)) throw new Error(`Only PostgreSQL schemas can be created as a live database; this one is ${database.dialect}.`);
    if (database.dialect === DatabaseDialect.ORACLE) {
        const { database: converted, problems } = convertOracleToPostgres(database, dataTypes);
        if (problems.length > 0) throw new Error(`This Oracle schema cannot be created in PostgreSQL as it is: ${problems.slice(0, 5).join(" ")}${problems.length > 5 ? ` (and ${problems.length - 5} more)` : ""}`);
        const renderer = getRenderer(DatabaseDialect.POSTGRES, postgresDataTypes);
        if (!renderer) throw new Error("There is no SQL renderer for PostgreSQL.");
        return renderer.renderDDL(converted);
    }
    const renderer = getRenderer(database.dialect, dataTypes);
    if (!renderer) throw new Error("There is no SQL renderer for this database.");
    return renderer.renderDDL(database);
}

const keyOf = (item: { name: string; namespace?: string | null }) => qualifiedTableName(item as never);

/**
 * What an import will leave in the diagram, so the same schema can be built as a live database: the parsed schema, plus whatever the
 * diagram already holds that the import does not mention. (Importing adds to a diagram; it does not replace it.)
 */
export function liveTargetFromImport(parsed: ParsedDatabaseResult, current: DatabaseType, dataTypes: DataType[]): DatabaseType {
    const target = prepareParsedSchemaChange(parsed, current, dataTypes).targetDatabase;

    const tableKeys = new Set(target.tables.map(keyOf));
    const keptTables = current.tables.filter((table) => !tableKeys.has(keyOf(table)));
    const tableIds = new Set([...target.tables, ...keptTables].map((table) => table.id));

    const viewKeys = new Set((target.views ?? []).map(keyOf));
    const sequenceKeys = new Set((target.sequences ?? []).map(keyOf));
    const relationshipIds = new Set(target.relationships.map((relationship) => relationship.id));

    return {
        ...target,
        numOfTables: target.tables.length + keptTables.length,
        tables: [...target.tables, ...keptTables],
        relationships: [
            ...target.relationships,
            ...current.relationships.filter((relationship) => !relationshipIds.has(relationship.id) && tableIds.has(relationship.sourceTableId) && tableIds.has(relationship.targetTableId)),
        ],
        views: [...(target.views ?? []), ...(current.views ?? []).filter((view) => !viewKeys.has(keyOf(view)))],
        sequences: [...(target.sequences ?? []), ...(current.sequences ?? []).filter((sequence) => !sequenceKeys.has(keyOf(sequence)))],
    };
}

// ---- what the option remembers -----------------------------------------------------------------------------------------------

const PREFERENCE_KEY = "goforge.liveDatabase.v1";

export interface LiveDatabasePreference {
    enabled: boolean;
    connectionId?: string;
}

export function readLivePreference(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): LiveDatabasePreference | undefined {
    try {
        const raw = storage?.getItem(PREFERENCE_KEY);
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as Partial<LiveDatabasePreference>;
        return { enabled: parsed.enabled !== false, connectionId: typeof parsed.connectionId === "string" ? parsed.connectionId : undefined };
    } catch {
        return undefined;
    }
}

export function writeLivePreference(preference: LiveDatabasePreference, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
    try {
        storage?.setItem(PREFERENCE_KEY, JSON.stringify(preference));
    } catch {
        // the choice just isn't remembered
    }
}

function safeStorage(): Storage | undefined {
    try {
        return typeof localStorage === "undefined" ? undefined : localStorage;
    } catch {
        return undefined;
    }
}

/** The pages that list saved connections each remember the one last used; point them at a database that was just created. */
export const PAGE_CONNECTION_KEYS = ["goforge.sql.connection", "goforge.schemaChange.connection", "goforge.modernizer.connection"] as const;

export function rememberConnectionOnPages(connectionId: string, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
    for (const key of PAGE_CONNECTION_KEYS) {
        try {
            storage?.setItem(key, connectionId);
        } catch {
            // the page just opens without it selected
        }
    }
}
