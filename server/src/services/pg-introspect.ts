import type { Client } from "pg";

export interface IntrospectedColumn {
    name: string;
    ordinalPosition: number;
    udtName: string;
    maxLength: number | null;
    numericPrecision: number | null;
    numericScale: number | null;
    nullable: boolean;
    defaultValue: string | null;
    isIdentity: boolean;
    isSerial: boolean;
}

export interface IntrospectedTable {
    name: string;
    columns: IntrospectedColumn[];
    primaryKeyColumns: string[];
    uniqueConstraints: { name: string; columns: string[] }[];
}

export interface IntrospectedForeignKey {
    constraintName: string;
    sourceTable: string;
    sourceColumn: string;
    targetTable: string;
    targetColumn: string;
    onUpdate: string;
    onDelete: string;
}

export interface IntrospectedIndex {
    tableName: string;
    indexName: string;
    isUnique: boolean;
    isPrimary: boolean;
    columns: string[];
}

export interface IntrospectedEnum {
    name: string;
    values: string[];
}

export interface IntrospectionResult {
    tables: IntrospectedTable[];
    foreignKeys: IntrospectedForeignKey[];
    indexes: IntrospectedIndex[];
    enums: IntrospectedEnum[];
}

const COLUMNS_QUERY = `
  SELECT table_name, column_name, ordinal_position, udt_name, character_maximum_length,
         numeric_precision, numeric_scale, is_nullable, column_default, is_identity
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY table_name, ordinal_position;
`;

const PRIMARY_KEYS_QUERY = `
  SELECT tc.table_name, kcu.column_name, tc.constraint_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
  ORDER BY tc.table_name, kcu.ordinal_position;
`;

const UNIQUE_CONSTRAINTS_QUERY = `
  SELECT tc.table_name, kcu.column_name, tc.constraint_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = 'public'
  ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;
`;

const FOREIGN_KEYS_QUERY = `
  SELECT tc.constraint_name, tc.table_name AS src_table, kcu.column_name AS src_col,
         ccu.table_name AS tgt_table, ccu.column_name AS tgt_col,
         rc.update_rule, rc.delete_rule
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
  JOIN information_schema.referential_constraints rc
    ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public';
`;

const INDEXES_QUERY = `
  SELECT t.relname AS table_name, i.relname AS index_name, ix.indisunique, ix.indisprimary,
         a.attname AS column_name, array_position(ix.indkey, a.attnum) AS ordinal
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
  WHERE n.nspname = 'public'
  ORDER BY t.relname, i.relname, ordinal;
`;

const ENUMS_QUERY = `
  SELECT t.typname AS enum_name, e.enumlabel AS enum_value
  FROM pg_type t
  JOIN pg_enum e ON t.oid = e.enumtypid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public'
  ORDER BY t.typname, e.enumsortorder;
`;

export async function introspectPostgres(client: Client): Promise<IntrospectionResult> {
    const [columnsRes, pkRes, uniqueRes, fkRes, indexRes, enumRes] = await Promise.all([
        client.query(COLUMNS_QUERY),
        client.query(PRIMARY_KEYS_QUERY),
        client.query(UNIQUE_CONSTRAINTS_QUERY),
        client.query(FOREIGN_KEYS_QUERY),
        client.query(INDEXES_QUERY),
        client.query(ENUMS_QUERY),
    ]);

    const tablesByName = new Map<string, IntrospectedTable>();

    const getTable = (name: string): IntrospectedTable => {
        let table = tablesByName.get(name);
        if (!table) {
            table = { name, columns: [], primaryKeyColumns: [], uniqueConstraints: [] };
            tablesByName.set(name, table);
        }
        return table;
    };

    for (const row of columnsRes.rows) {
        const table = getTable(row.table_name);
        const defaultValue: string | null = row.column_default;
        table.columns.push({
            name: row.column_name,
            ordinalPosition: row.ordinal_position,
            udtName: row.udt_name,
            maxLength: row.character_maximum_length,
            numericPrecision: row.numeric_precision,
            numericScale: row.numeric_scale,
            nullable: row.is_nullable === "YES",
            defaultValue,
            isIdentity: row.is_identity === "YES",
            isSerial: typeof defaultValue === "string" && defaultValue.startsWith("nextval("),
        });
    }

    for (const row of pkRes.rows) {
        getTable(row.table_name).primaryKeyColumns.push(row.column_name);
    }

    const uniqueByConstraint = new Map<string, { table: string; name: string; columns: string[] }>();
    for (const row of uniqueRes.rows) {
        const key = `${row.table_name}.${row.constraint_name}`;
        let entry = uniqueByConstraint.get(key);
        if (!entry) {
            entry = { table: row.table_name, name: row.constraint_name, columns: [] };
            uniqueByConstraint.set(key, entry);
        }
        entry.columns.push(row.column_name);
    }
    for (const entry of uniqueByConstraint.values()) {
        getTable(entry.table).uniqueConstraints.push({ name: entry.name, columns: entry.columns });
    }

    const foreignKeys: IntrospectedForeignKey[] = fkRes.rows.map((row) => ({
        constraintName: row.constraint_name,
        sourceTable: row.src_table,
        sourceColumn: row.src_col,
        targetTable: row.tgt_table,
        targetColumn: row.tgt_col,
        onUpdate: row.update_rule,
        onDelete: row.delete_rule,
    }));

    const indexesByKey = new Map<string, IntrospectedIndex>();
    for (const row of indexRes.rows) {
        // Skip indexes backing a PRIMARY KEY constraint - those are already represented
        // via primaryKeyColumns and would otherwise show up as a duplicate CREATE_INDEX op.
        if (row.indisprimary) continue;
        const key = `${row.table_name}.${row.index_name}`;
        let entry = indexesByKey.get(key);
        if (!entry) {
            entry = {
                tableName: row.table_name,
                indexName: row.index_name,
                isUnique: row.indisunique,
                isPrimary: row.indisprimary,
                columns: [],
            };
            indexesByKey.set(key, entry);
        }
        entry.columns.push(row.column_name);
    }

    const enumsByName = new Map<string, string[]>();
    for (const row of enumRes.rows) {
        const values = enumsByName.get(row.enum_name) ?? [];
        values.push(row.enum_value);
        enumsByName.set(row.enum_name, values);
    }

    return {
        tables: Array.from(tablesByName.values()),
        foreignKeys,
        indexes: Array.from(indexesByKey.values()),
        enums: Array.from(enumsByName.entries()).map(([name, values]) => ({ name, values })),
    };
}
