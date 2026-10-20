export type LegacyDialect = "oracle" | "mssql" | "mysql" | "db2";

export const LEGACY_DIALECTS: { value: LegacyDialect; label: string }[] = [
    { value: "oracle", label: "Oracle" },
    { value: "mssql", label: "SQL Server (T-SQL)" },
    { value: "mysql", label: "MySQL" },
    { value: "db2", label: "IBM DB2" },
];

/** Table and column names and types from the open project or connection. Never data. */
export interface SchemaContextTable {
    name: string;
    columns: Array<{
        name: string;
        type: string;
        nullable?: boolean;
        isPrimary?: boolean;
        isUnique?: boolean;
    }>;
    /** Columns of each existing index, in order. */
    indexes?: string[][];
}

/** A foreign key: the column of one table that points at a column of another. */
export interface SchemaContextRelationship {
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
}

export interface SchemaContext {
    databaseName?: string;
    dialect?: string;
    tables: SchemaContextTable[];
    relationships?: SchemaContextRelationship[];
}

export interface IndexRecommendation {
    id: string;
    tableName: string;
    columns: string[];
    name: string;
    reason: string;
    ddl: string;
}

/** What the language model returns for one query (already validated by the server). */
export interface AiConversion {
    sql: string;
    summary: string;
    changes: string[];
    risks: string[];
    unsupported: string[];
}
