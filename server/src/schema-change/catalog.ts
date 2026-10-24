import { unknownRows } from "./row-estimate.js";
import { runReadOnly, type Queryable } from "../services/pg-read.js";
import { USER_SCHEMAS } from "../services/pg-relations.js";

/**
 * The lightweight map of a database that scope selection searches: every table with its columns, key and foreign keys,
 * plus size facts. Names, types and counts only - no row data. Loaded in one round trip.
 */

export interface CatalogColumn {
    name: string;
    type: string;
    notNull: boolean;
}

export interface CatalogForeignKey {
    name: string;
    /** Columns on the table that holds the key (the child side). */
    columns: string[];
    refSchema: string;
    refTable: string;
    refColumns: string[];
    validated: boolean;
}

export interface CatalogTable {
    schema: string;
    name: string;
    /** `schema.name`, unquoted: the identity used everywhere in this feature. */
    qualified: string;
    partitioned: boolean;
    /** Number of partitions when partitioned; the partitions themselves are not listed as tables. */
    partitionCount: number;
    /** pg_class.reltuples; null when the table has never been analyzed (the size is then unknown, not zero). */
    estimatedRows: number | null;
    /** Heap + indexes + TOAST, summed over partitions for a partitioned table. */
    totalBytes: number;
    columns: CatalogColumn[];
    primaryKey: string[];
    foreignKeys: CatalogForeignKey[];
}

export interface Catalog {
    serverVersionNum: number;
    serverVersion: string;
    loadedAt: string;
    tables: CatalogTable[];
}

export const qualify = (schema: string, name: string): string => `${schema}.${name}`;

const VERSION_SQL = `SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS text`;

// Partitions are an implementation detail of their parent (orders_2024_01), so they are counted, not listed.
const TABLES_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, c.relkind = 'p' AS partitioned,
         CASE WHEN c.relkind = 'p' THEN (SELECT count(*) FROM pg_partition_tree(c.oid) t WHERE t.level > 0) ELSE 0 END AS partition_count,
         CASE WHEN c.relkind = 'p'
              THEN (SELECT CASE WHEN bool_or(${unknownRows("l")}) THEN NULL ELSE sum(l.reltuples)::int8::text END
                      FROM pg_partition_tree(c.oid) t JOIN pg_class l ON l.oid = t.relid WHERE t.isleaf)
              WHEN ${unknownRows("c")} THEN NULL ELSE c.reltuples::int8::text END AS estimated_rows,
         CASE WHEN c.relkind = 'p'
              THEN (SELECT COALESCE(sum(pg_total_relation_size(t.relid)), 0) FROM pg_partition_tree(c.oid) t WHERE t.isleaf)::text
              ELSE pg_total_relation_size(c.oid)::text END AS total_bytes,
         COALESCE((SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull) ORDER BY a.attnum)
                   FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::json) AS columns,
         COALESCE((SELECT json_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum))
                   FROM pg_index ix JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY (ix.indkey)
                   WHERE ix.indrelid = c.oid AND ix.indisprimary), '[]'::json) AS primary_key
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND ${USER_SCHEMAS}
  ORDER BY n.nspname, c.relname`;

// conparentid <> 0 are the copies of a partitioned table's key on each partition; only the parent's own is a real constraint.
const FOREIGN_KEYS_SQL = `
  SELECT c.conname AS name, n.nspname AS schema, st.relname AS table,
         (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
         tn.nspname AS ref_schema, tt.relname AS ref_table,
         (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS ref_columns,
         c.convalidated AS validated
  FROM pg_constraint c
  JOIN pg_class st ON st.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = st.relnamespace
  JOIN pg_class tt ON tt.oid = c.confrelid
  JOIN pg_namespace tn ON tn.oid = tt.relnamespace
  WHERE c.contype = 'f' AND c.conparentid = 0 AND ${USER_SCHEMAS}
  ORDER BY n.nspname, st.relname, c.conname`;

interface TableRow {
    schema: string;
    name: string;
    partitioned: boolean;
    partition_count: string | number;
    estimated_rows: string | null;
    total_bytes: string;
    columns: CatalogColumn[];
    primary_key: string[];
}

interface ForeignKeyRow {
    name: string;
    schema: string;
    table: string;
    columns: string[];
    ref_schema: string;
    ref_table: string;
    ref_columns: string[];
    validated: boolean;
}

export async function loadCatalog(client: Queryable): Promise<Catalog> {
    const [version, tables, foreignKeys] = await runReadOnly(client, [VERSION_SQL, TABLES_SQL, FOREIGN_KEYS_SQL]);
    const versionRow = version.rows[0] as { num: string; text: string };

    const byKey = new Map<string, CatalogTable>();
    for (const row of tables.rows as TableRow[]) {
        const qualified = qualify(row.schema, row.name);
        byKey.set(qualified, {
            schema: row.schema,
            name: row.name,
            qualified,
            partitioned: row.partitioned,
            partitionCount: Number(row.partition_count),
            estimatedRows: row.estimated_rows === null ? null : Number(row.estimated_rows),
            totalBytes: Number(row.total_bytes),
            columns: row.columns,
            primaryKey: row.primary_key,
            foreignKeys: [],
        });
    }
    for (const row of foreignKeys.rows as ForeignKeyRow[]) {
        byKey.get(qualify(row.schema, row.table))?.foreignKeys.push({
            name: row.name,
            columns: row.columns,
            refSchema: row.ref_schema,
            refTable: row.ref_table,
            refColumns: row.ref_columns,
            validated: row.validated,
        });
    }

    return { serverVersionNum: Number(versionRow.num), serverVersion: versionRow.text, loadedAt: new Date().toISOString(), tables: [...byKey.values()] };
}
