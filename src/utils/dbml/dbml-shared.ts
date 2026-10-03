import { DatabaseDialect } from "@/lib/database";

/** Something that could not be carried across a DBML conversion, reported instead of dropped silently. */
export interface DbmlWarning {
    /** Stable machine-readable kind, e.g. `unsupported-view`. */
    code: string;
    message: string;
    /** The object concerned, e.g. `users.email`. */
    subject?: string;
}

/** `Project { database_type }` value written for each dialect. */
export const DBML_DATABASE_TYPE: Record<DatabaseDialect, string> = {
    [DatabaseDialect.POSTGRES]: "PostgreSQL",
    [DatabaseDialect.MYSQL]: "MySQL",
    [DatabaseDialect.MARIADB]: "MariaDB",
    [DatabaseDialect.SQLITE]: "SQLite",
    [DatabaseDialect.MSSQL]: "MSSQL",
    [DatabaseDialect.ORACLE]: "Oracle",
};

const DIALECT_ALIASES: Record<string, DatabaseDialect> = {
    postgresql: DatabaseDialect.POSTGRES,
    postgres: DatabaseDialect.POSTGRES,
    pg: DatabaseDialect.POSTGRES,
    mysql: DatabaseDialect.MYSQL,
    mariadb: DatabaseDialect.MARIADB,
    sqlite: DatabaseDialect.SQLITE,
    sqlite3: DatabaseDialect.SQLITE,
    mssql: DatabaseDialect.MSSQL,
    sqlserver: DatabaseDialect.MSSQL,
    microsoftsqlserver: DatabaseDialect.MSSQL,
    tsql: DatabaseDialect.MSSQL,
    oracle: DatabaseDialect.ORACLE,
};

/** Maps a DBML `database_type` string to a dialect GoForge supports, if it is one. */
export const dialectFromDatabaseType = (databaseType: string | null | undefined): DatabaseDialect | undefined => {
    if (!databaseType) return undefined;
    return DIALECT_ALIASES[databaseType.toLowerCase().replace(/[^a-z0-9]/g, "")];
};

/** Reads `database_type` without running the full parser, so the dialect can be chosen first. */
export const detectDbmlDialect = (text: string): DatabaseDialect | undefined => {
    const match = text.match(/\bdatabase_type\s*:\s*(?:'([^']*)'|"([^"]*)")/i);
    return dialectFromDatabaseType(match?.[1] ?? match?.[2]);
};
