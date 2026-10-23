import { runReadOnly, type Queryable } from "./pg-read.js";
import { quoteLiteral } from "./pg-sql.js";

// r = table, p = partitioned table, v = view, m = materialized view, f = foreign table
export type RelKind = "r" | "p" | "v" | "m" | "f";

export type RelationKind = "table" | "view" | "materialized view" | "foreign table";

export interface RelationMeta {
    schema: string;
    name: string;
    kind: RelationKind;
    relkind: RelKind;
    /** pg_class.reltuples; null for views, foreign tables and tables that were never analyzed. */
    estimatedRows: number | null;
    columns: { name: string; dataType: string }[];
    primaryKey: string[];
}

export function kindOf(relkind: RelKind): RelationKind {
    switch (relkind) {
        case "v":
            return "view";
        case "m":
            return "materialized view";
        case "f":
            return "foreign table";
        default:
            return "table";
    }
}

// Everything about every browsable relation in one query: kind, estimated rows, columns (with their real Postgres
// type via format_type) and primary key. Used both for the table list and to fill the catalog cache.
const RELATIONS_SELECT = `
  SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
         CASE WHEN c.relkind IN ('v', 'f') OR c.reltuples <= 0 THEN NULL ELSE c.reltuples::int8::text END AS estimated_rows,
         COALESCE((SELECT json_agg(json_build_object('name', a.attname, 'dataType', format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
                   FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::json) AS columns,
         COALESCE((SELECT json_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum))
                   FROM pg_index ix JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY (ix.indkey)
                   WHERE ix.indrelid = c.oid AND ix.indisprimary), '[]'::json) AS primary_key
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')`;

export const USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'`;

interface RelationRow {
    schema: string;
    name: string;
    relkind: RelKind;
    estimated_rows: string | null;
    columns: { name: string; dataType: string }[];
    primary_key: string[];
}

function toMeta(row: RelationRow): RelationMeta {
    return {
        schema: row.schema,
        name: row.name,
        kind: kindOf(row.relkind),
        relkind: row.relkind,
        estimatedRows: row.estimated_rows === null ? null : Number(row.estimated_rows),
        columns: row.columns,
        primaryKey: row.primary_key,
    };
}

/** Every table, view and materialized view the connection can see, in one round trip. */
export async function loadAllRelations(client: Queryable): Promise<RelationMeta[]> {
    const [result] = await runReadOnly(client, [`${RELATIONS_SELECT} AND ${USER_SCHEMAS} ORDER BY n.nspname, c.relname`]);
    return (result.rows as RelationRow[]).map(toMeta);
}

/** One relation's catalog entry (the cold path when the cache has nothing for it), or undefined if it doesn't exist. */
export async function loadRelationMeta(client: Queryable, schema: string, name: string): Promise<RelationMeta | undefined> {
    const [result] = await runReadOnly(client, [`${RELATIONS_SELECT} AND n.nspname = ${quoteLiteral(schema)} AND c.relname = ${quoteLiteral(name)}`]);
    const row = (result.rows as RelationRow[])[0];
    return row ? toMeta(row) : undefined;
}
