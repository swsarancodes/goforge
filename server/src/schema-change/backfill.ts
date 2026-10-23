/**
 * A batched UPDATE written as one DO block. Each batch commits on its own (COMMIT inside DO works when the block is not
 * already inside a transaction, which is why the runbook runs without one), so no lock lasts longer than a batch and a
 * stopped or failed run keeps what it finished. Running it again is safe: rows already converted are skipped.
 */

export interface KeyedBackfill {
    /** Quoted, schema-qualified table. */
    table: string;
    /** Quoted key column. Any orderable type works; the variables take its type. */
    key: string;
    /** `col = expr, col2 = expr2` */
    assignments: string;
    /** Only rows where this is true are written (what makes a re-run cheap). */
    needsUpdate: string;
    batchRows: number;
    pauseMs: number;
}

const pause = (ms: number): string => (ms > 0 ? `\n    PERFORM pg_sleep(${(ms / 1000).toString()});` : "");

export function keyedBackfill(spec: KeyedBackfill): string {
    const { table, key, assignments, needsUpdate, batchRows, pauseMs } = spec;
    return `DO $backfill$
DECLARE
  last_key ${table}.${key}%TYPE;
  upper_key ${table}.${key}%TYPE;
BEGIN
  LOOP
    IF last_key IS NULL THEN
      SELECT b.k INTO upper_key FROM (SELECT ${key} AS k FROM ${table} ORDER BY ${key} LIMIT ${batchRows}) b ORDER BY b.k DESC LIMIT 1;
    ELSE
      SELECT b.k INTO upper_key FROM (SELECT ${key} AS k FROM ${table} WHERE ${key} > last_key ORDER BY ${key} LIMIT ${batchRows}) b ORDER BY b.k DESC LIMIT 1;
    END IF;
    EXIT WHEN upper_key IS NULL;
    IF last_key IS NULL THEN
      UPDATE ${table} SET ${assignments} WHERE ${key} <= upper_key AND (${needsUpdate});
    ELSE
      UPDATE ${table} SET ${assignments} WHERE ${key} > last_key AND ${key} <= upper_key AND (${needsUpdate});
    END IF;
    last_key := upper_key;
    COMMIT;${pause(pauseMs)}
  END LOOP;
END
$backfill$;`;
}

export interface PageBackfill {
    table: string;
    assignments: string;
    needsUpdate: string;
    pagesPerBatch: number;
    pauseMs: number;
}

/** For a table with no usable key: walks the table page by page (efficient from PostgreSQL 14, which can scan a range of ctids). */
export function pagedBackfill(spec: PageBackfill): string {
    const { table, assignments, needsUpdate, pagesPerBatch, pauseMs } = spec;
    return `DO $backfill$
DECLARE
  total_pages bigint := pg_relation_size('${table.replace(/'/g, "''")}'::regclass) / current_setting('block_size')::bigint + 1;
  first_page bigint := 0;
BEGIN
  WHILE first_page < total_pages LOOP
    UPDATE ${table} SET ${assignments}
     WHERE ctid >= format('(%s,0)', first_page)::tid AND ctid < format('(%s,0)', first_page + ${pagesPerBatch})::tid AND (${needsUpdate});
    first_page := first_page + ${pagesPerBatch};
    COMMIT;${pause(pauseMs)}
  END LOOP;
END
$backfill$;`;
}
