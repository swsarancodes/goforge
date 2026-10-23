import { runReadOnly, type Queryable } from "../services/pg-read.js";
import { USER_SCHEMAS } from "../services/pg-relations.js";

/**
 * A read-only report on a whole database from the catalog and the statistics views: tables without a primary key, foreign keys
 * nothing indexes, duplicate and unused indexes, leftovers of failed index builds, wide tables, stale statistics, sequences close
 * to their limit. Every finding is a fact with the numbers it rests on. A model may be asked to order and explain the findings,
 * but it never produces one.
 */

export type HealthCategory =
    | "no-primary-key"
    | "fk-without-index"
    | "duplicate-index"
    | "redundant-index"
    | "unused-index"
    | "invalid-index"
    | "unvalidated-constraint"
    | "wide-table"
    | "stale-statistics"
    | "dead-rows"
    | "sequence-near-limit";

export const CATEGORY_LABELS: Record<HealthCategory, { label: string; why: string }> = {
    "no-primary-key": { label: "Tables without a primary key", why: "Rows can't be told apart, logical replication and most change tools can't track updates, and duplicates are easy to create." },
    "fk-without-index": { label: "Foreign keys without an index", why: "Deleting or changing a row in the parent table scans the whole child table, and joins on the key can't use an index." },
    "duplicate-index": { label: "Duplicate indexes", why: "Two indexes with the same definition cost twice the disk and write time and give the planner nothing more." },
    "redundant-index": { label: "Indexes covered by a longer index", why: "An index whose columns are the start of another index on the same table is usually served by the longer one." },
    "unused-index": { label: "Indexes never scanned", why: "No query has used them since the statistics were reset, and every write still has to maintain them." },
    "invalid-index": { label: "Invalid indexes", why: "A CREATE INDEX CONCURRENTLY that failed leaves an index that is maintained on every write but never used." },
    "unvalidated-constraint": { label: "Constraints not validated", why: "They are enforced for new rows only; old rows may break them, and the planner can't rely on them." },
    "wide-table": { label: "Wide tables", why: "Many columns usually mean wide rows, large updates and a model that wants splitting." },
    "stale-statistics": { label: "Missing or stale statistics", why: "The planner picks plans from them, and row counts in this report are less reliable for these tables." },
    "dead-rows": { label: "Tables with many dead rows", why: "Space that updates and deletes left behind and that vacuum has not reclaimed." },
    "sequence-near-limit": { label: "Sequences past half of their range", why: "When a sequence runs out, inserts fail. Integer sequences stop at 2,147,483,647." },
};

export interface HealthThresholds {
    /** Tables with at least this many columns are listed. */
    wideColumns: number;
    /** An index is only called unused when it is at least this big. */
    unusedIndexMinBytes: number;
    /** Dead rows must be at least this many, and this fraction of the live rows. */
    deadRowsMin: number;
    deadRowsFraction: number;
    /** Rows changed since the last analyze, as a fraction of the live rows. */
    staleFraction: number;
    /** A sequence is listed once it has used this fraction of its range. */
    sequenceFraction: number;
    /** At most this many findings are kept per category (the count is still reported). */
    perCategory: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
    wideColumns: 50,
    unusedIndexMinBytes: 1024 * 1024,
    deadRowsMin: 10_000,
    deadRowsFraction: 0.2,
    staleFraction: 0.5,
    sequenceFraction: 0.5,
    perCategory: 200,
};

export type Detail = Record<string, string | number | boolean | null | string[]>;

export interface HealthFinding {
    /** Stable between runs: category, table and object. */
    id: string;
    category: HealthCategory;
    table: string | null;
    object: string | null;
    summary: string;
    detail: Detail;
    /** Disk the finding is about (an index's size, a table's size). */
    bytes: number | null;
}

export interface HealthReport {
    generatedAt: string;
    serverVersion: string;
    statsResetAt: string | null;
    tables: number;
    categories: { category: HealthCategory; label: string; why: string; count: number; shown: number }[];
    findings: HealthFinding[];
    largest: { table: string; bytes: number; rows: number | null }[];
    thresholds: HealthThresholds;
    limits: string[];
}

// ---- reading the database ----------------------------------------------------------------------------------------------------

export interface HealthTable {
    schema: string;
    name: string;
    partitioned: boolean;
    columns: number;
    hasPrimaryKey: boolean;
    estimatedRows: number | null;
    totalBytes: number;
    liveTuples: number | null;
    deadTuples: number | null;
    modificationsSinceAnalyze: number | null;
    lastAnalyze: string | null;
    hasStatistics: boolean;
}

export interface HealthIndex {
    schema: string;
    table: string;
    name: string;
    method: string;
    columns: (string | null)[];
    /** Definition without the index name, to compare indexes by what they are. */
    shape: string;
    unique: boolean;
    primary: boolean;
    valid: boolean;
    partial: boolean;
    constraint: string | null;
    bytes: number;
    scans: number | null;
}

export interface HealthForeignKey {
    name: string;
    schema: string;
    table: string;
    columns: string[];
    refSchema: string;
    refTable: string;
    validated: boolean;
}

export interface HealthConstraint {
    name: string;
    schema: string;
    table: string;
    kind: "check" | "foreign key";
}

export interface HealthSequence {
    schema: string;
    name: string;
    type: string;
    lastValue: number;
    maxValue: number;
    owner: string | null;
}

export interface HealthData {
    serverVersion: string;
    statsResetAt: string | null;
    tables: HealthTable[];
    indexes: HealthIndex[];
    foreignKeys: HealthForeignKey[];
    unvalidated: HealthConstraint[];
    sequences: HealthSequence[];
}

const TABLES_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, c.relkind = 'p' AS partitioned,
         (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)::int AS columns,
         EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indrelid = c.oid AND ix.indisprimary) AS has_pk,
         CASE WHEN c.relkind = 'p' THEN NULL WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::int8::text END AS estimated_rows,
         CASE WHEN c.relkind = 'p' THEN (SELECT COALESCE(sum(pg_total_relation_size(p.relid)), 0) FROM pg_partition_tree(c.oid) p WHERE p.isleaf)::text ELSE pg_total_relation_size(c.oid)::text END AS total_bytes,
         s.n_live_tup::text AS live, s.n_dead_tup::text AS dead, s.n_mod_since_analyze::text AS mods,
         GREATEST(s.last_analyze, s.last_autoanalyze) AS last_analyze, (s.relid IS NOT NULL) AS has_stats_row
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND ${USER_SCHEMAS}
  ORDER BY n.nspname, c.relname`;

const INDEXES_SQL = `
  SELECT n.nspname AS schema, t.relname AS table, i.relname AS name, am.amname AS method,
         COALESCE((SELECT json_agg(CASE WHEN k.attnum = 0 THEN NULL ELSE a.attname END ORDER BY k.ord)
                   FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
                   WHERE k.ord <= ix.indnkeyatts), '[]'::json) AS columns,
         regexp_replace(pg_get_indexdef(ix.indexrelid), '^CREATE (UNIQUE )?INDEX \\S+ ON ', 'CREATE \\1INDEX ON ') AS shape,
         ix.indisunique AS "unique", ix.indisprimary AS "primary", ix.indisvalid AS valid, ix.indpred IS NOT NULL AS partial,
         (SELECT c.conname FROM pg_constraint c WHERE c.conindid = ix.indexrelid AND c.contype IN ('p', 'u', 'x') LIMIT 1) AS "constraint",
         pg_relation_size(ix.indexrelid)::text AS bytes, u.idx_scan::text AS scans
  FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_am am ON am.oid = i.relam LEFT JOIN pg_stat_user_indexes u ON u.indexrelid = ix.indexrelid
  WHERE t.relkind IN ('r', 'p') AND NOT t.relispartition AND NOT i.relispartition AND ${USER_SCHEMAS}
  ORDER BY n.nspname, t.relname, i.relname`;

const FOREIGN_KEYS_SQL = `
  SELECT c.conname AS name, n.nspname AS schema, t.relname AS table,
         (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
         rn.nspname AS ref_schema, rt.relname AS ref_table, c.convalidated AS validated
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_class rt ON rt.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = rt.relnamespace
  WHERE c.contype = 'f' AND c.conparentid = 0 AND NOT t.relispartition AND ${USER_SCHEMAS}
  ORDER BY n.nspname, t.relname, c.conname`;

const UNVALIDATED_SQL = `
  SELECT c.conname AS name, n.nspname AS schema, t.relname AS table, CASE c.contype WHEN 'f' THEN 'foreign key' ELSE 'check' END AS kind
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE NOT c.convalidated AND c.contype IN ('c', 'f') AND c.conparentid = 0 AND NOT t.relispartition AND ${USER_SCHEMAS}
  ORDER BY n.nspname, t.relname, c.conname`;

const SEQUENCES_SQL = `
  SELECT s.schemaname AS schema, s.sequencename AS name, s.data_type::text AS type, s.last_value::text AS last_value, s.max_value::text AS max_value,
         (SELECT tn.nspname || '.' || tc.relname || '.' || a.attname
            FROM pg_depend d JOIN pg_class tc ON tc.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = tc.relnamespace JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
           WHERE d.objid = (quote_ident(s.schemaname) || '.' || quote_ident(s.sequencename))::regclass AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i') AND d.refobjsubid > 0 LIMIT 1) AS owner
  FROM pg_sequences s
  WHERE s.last_value IS NOT NULL AND s.schemaname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY s.schemaname, s.sequencename`;

const META_SQL = `SELECT current_setting('server_version') AS version, (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset`;

interface Row {
    [key: string]: unknown;
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString());

export async function loadHealthData(client: Queryable): Promise<HealthData> {
    const [meta, tables, indexes, foreignKeys, unvalidated, sequences] = (await runReadOnly(client, [META_SQL, TABLES_SQL, INDEXES_SQL, FOREIGN_KEYS_SQL, UNVALIDATED_SQL, SEQUENCES_SQL])).map((result) => result.rows as Row[]);

    return {
        serverVersion: meta[0].version as string,
        statsResetAt: iso(meta[0].stats_reset),
        tables: tables.map((row) => ({
            schema: row.schema as string,
            name: row.name as string,
            partitioned: row.partitioned as boolean,
            columns: Number(row.columns),
            hasPrimaryKey: row.has_pk as boolean,
            estimatedRows: num(row.estimated_rows),
            totalBytes: Number(row.total_bytes),
            liveTuples: num(row.live),
            deadTuples: num(row.dead),
            modificationsSinceAnalyze: num(row.mods),
            lastAnalyze: iso(row.last_analyze),
            hasStatistics: row.has_stats_row as boolean,
        })),
        indexes: indexes.map((row) => ({
            schema: row.schema as string,
            table: row.table as string,
            name: row.name as string,
            method: row.method as string,
            columns: row.columns as (string | null)[],
            shape: row.shape as string,
            unique: row.unique as boolean,
            primary: row.primary as boolean,
            valid: row.valid as boolean,
            partial: row.partial as boolean,
            constraint: (row.constraint as string | null) ?? null,
            bytes: Number(row.bytes),
            scans: num(row.scans),
        })),
        foreignKeys: foreignKeys.map((row) => ({ name: row.name as string, schema: row.schema as string, table: row.table as string, columns: row.columns as string[], refSchema: row.ref_schema as string, refTable: row.ref_table as string, validated: row.validated as boolean })),
        unvalidated: unvalidated.map((row) => ({ name: row.name as string, schema: row.schema as string, table: row.table as string, kind: row.kind as HealthConstraint["kind"] })),
        sequences: sequences.map((row) => ({ schema: row.schema as string, name: row.name as string, type: row.type as string, lastValue: Number(row.last_value), maxValue: Number(row.max_value), owner: (row.owner as string | null) ?? null })),
    };
}

// ---- analysing it -------------------------------------------------------------------------------------------------------------

const qualified = (schema: string, name: string) => `${schema}.${name}`;

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((value) => b.includes(value));

/** True when an index starts with these columns (in any order): then a lookup on exactly these columns can use it. */
const leadsWith = (index: HealthIndex, columns: string[]): boolean => {
    if (!index.valid || index.partial || index.method !== "btree" || index.columns.length < columns.length) return false;
    const head = index.columns.slice(0, columns.length);
    return head.every((column) => column !== null) && sameSet(head as string[], columns);
};

const daysSince = (iso_: string | null, now: number): number | null => (iso_ ? Math.floor((now - Date.parse(iso_)) / 86_400_000) : null);

export function analyzeHealth(data: HealthData, options: { thresholds?: Partial<HealthThresholds>; now?: number } = {}): HealthReport {
    const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
    const now = options.now ?? Date.now();
    const all: HealthFinding[] = [];
    const add = (finding: Omit<HealthFinding, "id">) => all.push({ ...finding, id: `${finding.category}:${finding.table ?? ""}:${finding.object ?? ""}` });
    const tableBytes = new Map(data.tables.map((table) => [qualified(table.schema, table.name), table.totalBytes]));
    const tableRows = new Map(data.tables.map((table) => [qualified(table.schema, table.name), table.estimatedRows]));
    const rowsText = (table: string) => {
        const rows = tableRows.get(table);
        return rows === null || rows === undefined ? "row count unknown" : `about ${new Intl.NumberFormat("en-US").format(rows)} rows`;
    };

    for (const table of data.tables) {
        const name = qualified(table.schema, table.name);
        if (!table.hasPrimaryKey) {
            const alternative = data.indexes.find((index) => index.schema === table.schema && index.table === table.name && index.unique && index.valid && !index.partial);
            add({ category: "no-primary-key", table: name, object: null, summary: `${name} has no primary key (${rowsText(name)}).`, detail: { rows: table.estimatedRows, uniqueIndexInstead: alternative?.name ?? null }, bytes: table.totalBytes });
        }
        if (table.columns >= thresholds.wideColumns) {
            add({ category: "wide-table", table: name, object: null, summary: `${name} has ${table.columns} columns.`, detail: { columns: table.columns, rows: table.estimatedRows }, bytes: table.totalBytes });
        }
        if (!table.partitioned) {
            const live = table.liveTuples ?? 0;
            const never = table.estimatedRows === null || (table.hasStatistics && table.lastAnalyze === null && live > 0);
            const stale = table.modificationsSinceAnalyze !== null && live > 0 && table.modificationsSinceAnalyze / live > thresholds.staleFraction && table.modificationsSinceAnalyze > 1000;
            if (never || stale) {
                add({
                    category: "stale-statistics",
                    table: name,
                    object: null,
                    summary: never ? `${name} has never been analyzed, so its size is not known to the planner.` : `${name} has changed ${new Intl.NumberFormat("en-US").format(table.modificationsSinceAnalyze ?? 0)} rows since it was last analyzed (${new Intl.NumberFormat("en-US").format(live)} live rows).`,
                    detail: { neverAnalyzed: never, modificationsSinceAnalyze: table.modificationsSinceAnalyze, liveRows: table.liveTuples, lastAnalyze: table.lastAnalyze },
                    bytes: table.totalBytes,
                });
            }
            const dead = table.deadTuples ?? 0;
            if (dead >= thresholds.deadRowsMin && live > 0 && dead / live >= thresholds.deadRowsFraction) {
                add({ category: "dead-rows", table: name, object: null, summary: `${name} has ${new Intl.NumberFormat("en-US").format(dead)} dead rows against ${new Intl.NumberFormat("en-US").format(live)} live ones.`, detail: { deadRows: dead, liveRows: live }, bytes: table.totalBytes });
            }
        }
    }

    // indexes, per table
    const byTable = new Map<string, HealthIndex[]>();
    for (const index of data.indexes) {
        const key = qualified(index.schema, index.table);
        byTable.set(key, [...(byTable.get(key) ?? []), index]);
    }
    const statsAge = daysSince(data.statsResetAt, now);

    for (const [table, indexes] of byTable) {
        const claimed = new Set<string>();
        const groups = new Map<string, HealthIndex[]>();
        for (const index of indexes) groups.set(index.shape, [...(groups.get(index.shape) ?? []), index]);
        for (const group of groups.values()) {
            if (group.length < 2) continue;
            // Keep the one that enforces something, else the most used, else the first by name; the others are the duplicates.
            const keep = [...group].sort((a, b) => Number(!!b.constraint) - Number(!!a.constraint) || (b.scans ?? 0) - (a.scans ?? 0) || a.name.localeCompare(b.name))[0];
            for (const index of group) {
                if (index === keep || index.constraint) continue;
                claimed.add(index.name);
                add({ category: "duplicate-index", table, object: index.name, summary: `${index.name} on ${table} is identical to ${keep.name}.`, detail: { sameAs: keep.name, columns: index.columns.map((c) => c ?? "(expression)"), scans: index.scans }, bytes: index.bytes });
            }
        }
        for (const index of indexes) {
            if (claimed.has(index.name) || index.constraint || index.unique || !index.valid || index.partial || index.method !== "btree" || index.columns.some((c) => c === null)) continue;
            const longer = indexes.find((other) => other !== index && other.valid && !other.partial && other.method === "btree" && other.columns.length > index.columns.length && index.columns.every((column, i) => other.columns[i] === column));
            if (longer) {
                claimed.add(index.name);
                add({ category: "redundant-index", table, object: index.name, summary: `${index.name} (${index.columns.join(", ")}) on ${table} is the start of ${longer.name} (${longer.columns.map((c) => c ?? "(expression)").join(", ")}).`, detail: { coveredBy: longer.name, columns: index.columns as string[], scans: index.scans }, bytes: index.bytes });
            }
        }
        for (const index of indexes) {
            if (!index.valid) {
                add({ category: "invalid-index", table, object: index.name, summary: `${index.name} on ${table} is invalid: an earlier CREATE INDEX CONCURRENTLY did not finish.`, detail: { definition: index.shape }, bytes: index.bytes });
                continue;
            }
            if (claimed.has(index.name) || index.constraint || index.unique || index.primary) continue;
            if (index.scans === 0 && index.bytes >= thresholds.unusedIndexMinBytes) {
                add({
                    category: "unused-index",
                    table,
                    object: index.name,
                    summary: `${index.name} on ${table} has not been scanned since the statistics were reset${statsAge === null ? "" : ` ${statsAge} days ago`}.`,
                    detail: { columns: index.columns.map((c) => c ?? "(expression)"), statsAgeDays: statsAge },
                    bytes: index.bytes,
                });
            }
        }
    }

    for (const fk of data.foreignKeys) {
        const table = qualified(fk.schema, fk.table);
        const indexes = byTable.get(table) ?? [];
        if (!indexes.some((index) => leadsWith(index, fk.columns))) {
            add({
                category: "fk-without-index",
                table,
                object: fk.name,
                summary: `Foreign key ${fk.name}: ${table}(${fk.columns.join(", ")}) -> ${qualified(fk.refSchema, fk.refTable)} has no index on ${fk.columns.join(", ")}.`,
                detail: { columns: fk.columns, references: qualified(fk.refSchema, fk.refTable), rows: tableRows.get(table) ?? null },
                bytes: tableBytes.get(table) ?? null,
            });
        }
    }

    for (const constraint of data.unvalidated) {
        const table = qualified(constraint.schema, constraint.table);
        add({ category: "unvalidated-constraint", table, object: constraint.name, summary: `${constraint.kind === "foreign key" ? "Foreign key" : "Check"} ${constraint.name} on ${table} was added NOT VALID and has not been validated.`, detail: { kind: constraint.kind }, bytes: tableBytes.get(table) ?? null });
    }

    for (const sequence of data.sequences) {
        const used = sequence.maxValue > 0 ? sequence.lastValue / sequence.maxValue : 0;
        if (used >= thresholds.sequenceFraction) {
            const name = qualified(sequence.schema, sequence.name);
            add({
                category: "sequence-near-limit",
                table: sequence.owner ? sequence.owner.split(".").slice(0, 2).join(".") : null,
                object: name,
                summary: `Sequence ${name}${sequence.owner ? ` (${sequence.owner})` : ""} is at ${new Intl.NumberFormat("en-US").format(sequence.lastValue)} of ${new Intl.NumberFormat("en-US").format(sequence.maxValue)} (${(used * 100).toFixed(0)}%).`,
                detail: { lastValue: sequence.lastValue, maxValue: sequence.maxValue, type: sequence.type, owner: sequence.owner },
                bytes: null,
            });
        }
    }

    // biggest first inside a category (what matters most to disk and time), then by name
    all.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || a.id.localeCompare(b.id));
    const findings: HealthFinding[] = [];
    const categories = (Object.keys(CATEGORY_LABELS) as HealthCategory[]).map((category) => {
        const inCategory = all.filter((finding) => finding.category === category);
        const shown = inCategory.slice(0, thresholds.perCategory);
        findings.push(...shown);
        return { category, ...CATEGORY_LABELS[category], count: inCategory.length, shown: shown.length };
    });

    return {
        generatedAt: new Date(now).toISOString(),
        serverVersion: data.serverVersion,
        statsResetAt: data.statsResetAt,
        tables: data.tables.length,
        categories,
        findings,
        largest: [...data.tables].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 10).map((table) => ({ table: qualified(table.schema, table.name), bytes: table.totalBytes, rows: table.estimatedRows })),
        thresholds,
        limits: [
            "Index usage counts come from this server only, and only since the statistics were last reset" + (statsAge === null ? "." : ` (${statsAge} days ago). A read replica's use of an index is not counted here, and an index used once a quarter can look unused.`),
            "Row counts are the planner's estimates, not counts. A table that was never analyzed has none.",
            "Partitions are not analysed one by one; a partitioned table is reported as a whole.",
            "Findings are facts about the catalog. Whether to act on one depends on the application.",
        ],
    };
}

export async function healthReport(client: Queryable, options: { thresholds?: Partial<HealthThresholds> } = {}): Promise<HealthReport> {
    return analyzeHealth(await loadHealthData(client), options);
}

/** What a model may be shown to order and explain the findings: names, categories and numbers, never the report's free text. The same few of each kind, so one noisy category can't crowd out the rest. */
export function findingsForSummary(report: HealthReport, perCategory = 8): { id: string; category: HealthCategory; table: string | null; object: string | null; bytes: number | null; detail: Detail }[] {
    const seen = new Map<HealthCategory, number>();
    return report.findings
        .filter((finding) => {
            const count = seen.get(finding.category) ?? 0;
            seen.set(finding.category, count + 1);
            return count < perCategory;
        })
        .map(({ id, category, table, object, bytes, detail }) => ({ id, category, table, object, bytes, detail }));
}
