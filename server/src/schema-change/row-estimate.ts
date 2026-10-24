/**
 * SQL for "this table's row count is not known". PostgreSQL 14 and later store -1 in pg_class.reltuples for a table that has never been
 * vacuumed or analyzed. Before that the same table reports 0, which cannot be told from an empty table by reltuples alone: a table that
 * holds data (its file is not empty) but reports 0 has simply not been analyzed. Reading that 0 as "empty" would let the compiler take
 * the shortcuts that are only safe for empty tables on a table of any size.
 */
export const unknownRows = (alias: string): string =>
    `(${alias}.reltuples < 0 OR (${alias}.reltuples = 0 AND current_setting('server_version_num')::int < 140000 AND pg_relation_size(${alias}.oid) > 0))`;
