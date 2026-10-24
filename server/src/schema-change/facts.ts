import { unknownRows } from "./row-estimate.js";
import { runReadOnly, type Queryable } from "../services/pg-read.js";
import { quoteLiteral } from "../services/pg-sql.js";

/**
 * What the planner is told about the tables in scope, and what the plan is checked against: sizes, row estimates,
 * columns, constraints, indexes with how often they were used, and views that depend on the table. All of it comes from
 * the catalog and the statistics views. No row is ever read: column statistics are limited to the NULL fraction and the
 * distinct-value estimate, and the "most common values" and histogram columns of pg_stats are never selected.
 */

/** Something in the database that depends on a column or a table, from pg_depend. */
export interface Dependent {
    kind: "view" | "trigger" | "policy" | "function" | "statistics" | "publication" | "generated-column" | "sequence";
    /** What PostgreSQL would call it in an error message: `view public.v`, `trigger t_note on table t`, `generated column total`. */
    description: string;
    /** True when PostgreSQL refuses to drop the column or change its type without CASCADE (a normal dependency); false when it is removed with the column. */
    blocks: boolean;
    /** The object belongs to another table (a view, a policy or trigger on a table that is not this one), so dropping this table would be blocked by it too. */
    external: boolean;
}

export interface ColumnFacts {
    name: string;
    /** format_type(): `character varying(255)`, `integer`, `public.mood`. */
    type: string;
    /** Schema the type lives in; anything outside pg_catalog is a name defined in this database. */
    typeSchema: string;
    notNull: boolean;
    /** The default expression as PostgreSQL stores it; null when there is none. Never sent to a model. */
    default: string | null;
    generated: "stored" | "always-identity" | "default-identity" | null;
    /** Objects that depend on this column: views, triggers, policies, generated columns, publications, statistics, owned sequences. */
    dependents: Dependent[];
    /** From pg_stats: an estimate, null until the table is analyzed. */
    nullFraction: number | null;
    distinct: number | null;
}

export interface IndexFacts {
    name: string;
    definition: string;
    /** Key columns in order; null where the key is an expression. */
    columns: (string | null)[];
    /** Every column the index depends on: its keys, INCLUDE columns, columns inside an expression and columns in a WHERE predicate. Dropping any of them drops the index. */
    uses: string[];
    method: string;
    unique: boolean;
    primary: boolean;
    /** False for an index a failed CREATE INDEX CONCURRENTLY left behind. */
    valid: boolean;
    partial: boolean;
    /** Name of the constraint this index enforces (primary key, unique, exclusion), if any. */
    constraint: string | null;
    bytes: number;
    /** pg_stat_user_indexes.idx_scan since the statistics were last reset; null for an index on a partitioned table. */
    scans: number | null;
}

export interface ConstraintFacts {
    name: string;
    kind: "unique" | "check" | "exclusion";
    definition: string;
    columns: string[];
    validated: boolean;
}

export interface ForeignKeyFacts {
    name: string;
    columns: string[];
    refSchema: string;
    refTable: string;
    refColumns: string[];
    onDelete: string;
    onUpdate: string;
    validated: boolean;
}

export interface InboundForeignKey {
    name: string;
    schema: string;
    table: string;
    columns: string[];
    refColumns: string[];
}

export interface TableStats {
    liveTuples: number;
    deadTuples: number;
    lastVacuum: string | null;
    lastAnalyze: string | null;
    seqScans: number;
    indexScans: number;
    modificationsSinceAnalyze: number;
}

export interface TableFacts {
    schema: string;
    name: string;
    qualified: string;
    partitioned: boolean;
    /** Direct partitions of a partitioned table. */
    partitionCount: number;
    /** The direct partitions, schema qualified (up to MAX_LISTED_PARTITIONS). */
    partitions: string[];
    /** A partition is itself partitioned. */
    nestedPartitions: boolean;
    /** pg_class.reltuples; null when never analyzed (the real size is then unknown). */
    estimatedRows: number | null;
    heapBytes: number;
    indexBytes: number;
    totalBytes: number;
    columns: ColumnFacts[];
    primaryKey: string[];
    uniques: ConstraintFacts[];
    checks: ConstraintFacts[];
    foreignKeys: ForeignKeyFacts[];
    referencedBy: InboundForeignKey[];
    indexes: IndexFacts[];
    dependentViews: string[];
    /** Objects on other tables, and functions, that depend on this table or any of its columns: what would block `DROP TABLE`. */
    dependents: Dependent[];
    userTriggers: number;
    stats: TableStats | null;
    /** True for a table the plan itself creates: empty, with no history. */
    isNew?: boolean;
}

export interface Facts {
    serverVersionNum: number;
    serverVersion: string;
    collectedAt: string;
    /** When the statistics (including index scan counts) were last reset; null if never. */
    statsResetAt: string | null;
    tables: Map<string, TableFacts>;
}

export const MAX_LISTED_PARTITIONS = 500;

export function qualifiedName(schema: string, name: string): string {
    return `${schema}.${name}`;
}

/** `schema.table` or a bare `table` -> the parts. A bare name has no schema. */
export function splitQualified(text: string): { schema?: string; name: string } {
    const dot = text.indexOf(".");
    return dot === -1 ? { name: text } : { schema: text.slice(0, dot), name: text.slice(dot + 1) };
}

export const wanted = (qualified: string[]): string => {
    const rows = qualified.map((entry) => {
        const { schema, name } = splitQualified(entry);
        return `(${quoteLiteral(schema ?? "public")}, ${quoteLiteral(name)})`;
    });
    return `WITH wanted(schema, name) AS (VALUES ${rows.join(", ")}),
    t AS (SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN wanted w ON w.schema = n.nspname AND w.name = c.relname
          WHERE c.relkind IN ('r', 'p'))`;
};

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString());

interface Row {
    [key: string]: unknown;
}

const VERSION_SQL = `SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS text,
                (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset`;

export async function loadFacts(client: Queryable, qualified: string[]): Promise<Facts> {
    const unique = [...new Set(qualified)];
    if (unique.length === 0) {
        // No existing table is involved (a plan that only creates things), but the version still decides how the SQL is written.
        const [result] = await runReadOnly(client, [VERSION_SQL]);
        const row = (result.rows as Row[])[0];
        return { serverVersionNum: Number(row.num), serverVersion: row.text as string, collectedAt: new Date().toISOString(), statsResetAt: iso(row.stats_reset), tables: new Map() };
    }
    const cte = wanted(unique);

    const results = await runReadOnly(client, [
        VERSION_SQL,

        `${cte}
         SELECT t.oid::int8::text AS oid, t.schema, t.name, t.relkind = 'p' AS partitioned,
                CASE WHEN t.relkind = 'p'
                     THEN (SELECT CASE WHEN bool_or(${unknownRows("l")}) THEN NULL ELSE sum(l.reltuples)::int8::text END FROM pg_partition_tree(t.oid) p JOIN pg_class l ON l.oid = p.relid WHERE p.isleaf)
                     ELSE (SELECT CASE WHEN ${unknownRows("c")} THEN NULL ELSE c.reltuples::int8::text END FROM pg_class c WHERE c.oid = t.oid) END AS estimated_rows,
                CASE WHEN t.relkind = 'p' THEN (SELECT COALESCE(sum(pg_relation_size(p.relid)), 0) FROM pg_partition_tree(t.oid) p WHERE p.isleaf)::text ELSE pg_relation_size(t.oid)::text END AS heap_bytes,
                CASE WHEN t.relkind = 'p' THEN (SELECT COALESCE(sum(pg_indexes_size(p.relid)), 0) FROM pg_partition_tree(t.oid) p WHERE p.isleaf)::text ELSE pg_indexes_size(t.oid)::text END AS index_bytes,
                CASE WHEN t.relkind = 'p' THEN (SELECT COALESCE(sum(pg_total_relation_size(p.relid)), 0) FROM pg_partition_tree(t.oid) p WHERE p.isleaf)::text ELSE pg_total_relation_size(t.oid)::text END AS total_bytes,
                CASE WHEN t.relkind = 'p' THEN (SELECT count(*) FROM pg_partition_tree(t.oid) p WHERE p.level = 1)::int ELSE 0 END AS partition_count,
                t.relkind = 'p' AND EXISTS (SELECT 1 FROM pg_partition_tree(t.oid) p WHERE p.level > 1) AS nested_partitions,
                CASE WHEN t.relkind = 'p' THEN (SELECT COALESCE(json_agg(p.name ORDER BY p.name), '[]'::json) FROM (SELECT pn.nspname || '.' || pc.relname AS name FROM pg_partition_tree(t.oid) pt JOIN pg_class pc ON pc.oid = pt.relid JOIN pg_namespace pn ON pn.oid = pc.relnamespace WHERE pt.level = 1 ORDER BY 1 LIMIT ${MAX_LISTED_PARTITIONS}) p) ELSE '[]'::json END AS partitions,
                (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid = t.oid AND NOT g.tgisinternal)::int AS user_triggers,
                s.n_live_tup::text AS live, s.n_dead_tup::text AS dead, s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze,
                s.seq_scan::text AS seq_scan, s.idx_scan::text AS idx_scan, s.n_mod_since_analyze::text AS mods
         FROM t LEFT JOIN pg_stat_user_tables s ON s.relid = t.oid`,

        `${cte}
         SELECT t.schema, t.name AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, tn.nspname AS type_schema, a.attnotnull AS not_null,
                pg_get_expr(d.adbin, d.adrelid) AS "default",
                CASE WHEN a.attgenerated = 's' THEN 'stored' WHEN a.attidentity = 'a' THEN 'always-identity' WHEN a.attidentity = 'd' THEN 'default-identity' END AS generated,
                st.null_frac, st.n_distinct
         FROM t
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
         JOIN pg_type ty ON ty.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = ty.typnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN LATERAL (SELECT s.null_frac, s.n_distinct FROM pg_stats s WHERE s.schemaname = t.schema AND s.tablename = t.name AND s.attname = a.attname
                            ORDER BY s.inherited = (t.relkind = 'p') DESC LIMIT 1) st ON true
         ORDER BY t.schema, t.name, a.attnum`,

        `${cte}
         SELECT t.schema, t.name AS table, c.conname AS name, c.contype::text AS kind, pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated,
                COALESCE((SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum), '[]'::json) AS columns,
                rn.nspname AS ref_schema, rt.relname AS ref_table,
                COALESCE((SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum), '[]'::json) AS ref_columns,
                c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update
         FROM t JOIN pg_constraint c ON c.conrelid = t.oid AND c.contype IN ('u', 'c', 'x', 'f') AND c.conparentid = 0
         LEFT JOIN pg_class rt ON rt.oid = c.confrelid LEFT JOIN pg_namespace rn ON rn.oid = rt.relnamespace
         ORDER BY t.schema, t.name, c.conname`,

        `${cte}
         SELECT t.schema AS ref_schema, t.name AS ref_table, n.nspname AS schema, sc.relname AS table, c.conname AS name,
                COALESCE((SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum), '[]'::json) AS columns,
                COALESCE((SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum), '[]'::json) AS ref_columns
         FROM t JOIN pg_constraint c ON c.confrelid = t.oid AND c.contype = 'f' AND c.conparentid = 0
         JOIN pg_class sc ON sc.oid = c.conrelid JOIN pg_namespace n ON n.oid = sc.relnamespace
         ORDER BY n.nspname, sc.relname, c.conname`,

        `${cte}
         SELECT t.schema, t.name AS table, i.relname AS name, pg_get_indexdef(ix.indexrelid) AS definition, am.amname AS method,
                COALESCE((SELECT json_agg(CASE WHEN k.attnum = 0 THEN NULL ELSE a.attname END ORDER BY k.ord)
                          FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
                          WHERE k.ord <= ix.indnkeyatts), '[]'::json) AS columns,
                COALESCE((SELECT json_agg(DISTINCT a.attname)
                          FROM (SELECT k.attnum FROM unnest(ix.indkey::int2[]) AS k(attnum)
                                UNION SELECT d.refobjsubid FROM pg_depend d
                                WHERE d.classid = 'pg_class'::regclass AND d.objid = ix.indexrelid AND d.refclassid = 'pg_class'::regclass AND d.refobjid = ix.indrelid) AS u(attnum)
                          JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = u.attnum AND a.attnum > 0 AND NOT a.attisdropped), '[]'::json) AS uses,
                ix.indisunique AS "unique", ix.indisprimary AS "primary", ix.indisvalid AS valid, ix.indpred IS NOT NULL AS partial,
                (SELECT c.conname FROM pg_constraint c WHERE c.conindid = ix.indexrelid AND c.contype IN ('p', 'u', 'x') LIMIT 1) AS "constraint",
                pg_relation_size(ix.indexrelid)::text AS bytes, u.idx_scan::text AS scans
         FROM t JOIN pg_index ix ON ix.indrelid = t.oid JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_am am ON am.oid = i.relam
         LEFT JOIN pg_stat_user_indexes u ON u.indexrelid = ix.indexrelid
         ORDER BY t.schema, t.name, i.relname`,

        `${cte}
         SELECT t.schema, t.name AS table, a.attname AS "column",
                CASE d.classid WHEN 'pg_rewrite'::regclass THEN 'view' WHEN 'pg_trigger'::regclass THEN 'trigger' WHEN 'pg_policy'::regclass THEN 'policy'
                               WHEN 'pg_proc'::regclass THEN 'function' WHEN 'pg_statistic_ext'::regclass THEN 'statistics' WHEN 'pg_publication_rel'::regclass THEN 'publication'
                               WHEN 'pg_attrdef'::regclass THEN 'generated-column' WHEN 'pg_class'::regclass THEN 'sequence' END AS kind,
                CASE d.classid WHEN 'pg_rewrite'::regclass THEN 'view ' || (SELECT r.ev_class::regclass::text FROM pg_rewrite r WHERE r.oid = d.objid)
                               WHEN 'pg_attrdef'::regclass THEN 'generated column ' || (SELECT x.attname FROM pg_attrdef ad JOIN pg_attribute x ON x.attrelid = ad.adrelid AND x.attnum = ad.adnum WHERE ad.oid = d.objid)
                               ELSE pg_describe_object(d.classid, d.objid, d.objsubid) END AS description,
                d.deptype = 'n' AS blocks,
                COALESCE(CASE d.classid WHEN 'pg_rewrite'::regclass THEN (SELECT r.ev_class FROM pg_rewrite r WHERE r.oid = d.objid)
                                        WHEN 'pg_trigger'::regclass THEN (SELECT g.tgrelid FROM pg_trigger g WHERE g.oid = d.objid)
                                        WHEN 'pg_policy'::regclass THEN (SELECT p.polrelid FROM pg_policy p WHERE p.oid = d.objid)
                                        WHEN 'pg_attrdef'::regclass THEN (SELECT ad.adrelid FROM pg_attrdef ad WHERE ad.oid = d.objid) END, 0) <> t.oid
                  AND d.classid IN ('pg_rewrite'::regclass, 'pg_trigger'::regclass, 'pg_policy'::regclass, 'pg_proc'::regclass) AS external
         FROM t JOIN pg_depend d ON d.refclassid = 'pg_class'::regclass AND d.refobjid = t.oid AND d.deptype IN ('n', 'a', 'i')
         LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid AND d.refobjsubid > 0
         WHERE d.classid IN ('pg_rewrite'::regclass, 'pg_trigger'::regclass, 'pg_policy'::regclass, 'pg_proc'::regclass, 'pg_statistic_ext'::regclass, 'pg_publication_rel'::regclass, 'pg_attrdef'::regclass, 'pg_class'::regclass)
           AND (d.classid <> 'pg_class'::regclass OR (SELECT c.relkind FROM pg_class c WHERE c.oid = d.objid) = 'S')
           AND (d.classid <> 'pg_rewrite'::regclass OR (SELECT r.ev_class FROM pg_rewrite r WHERE r.oid = d.objid) <> t.oid)
           AND (d.classid <> 'pg_attrdef'::regclass OR (SELECT ad.adnum FROM pg_attrdef ad WHERE ad.oid = d.objid) <> d.refobjsubid OR (SELECT ad.adrelid FROM pg_attrdef ad WHERE ad.oid = d.objid) <> t.oid)
         ORDER BY t.schema, t.name, 3, 4, 5`,

        `${cte}
         SELECT DISTINCT t.schema, t.name AS table, vn.nspname || '.' || v.relname AS view
         FROM t JOIN pg_depend d ON d.refobjid = t.oid AND d.classid = 'pg_rewrite'::regclass
         JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class v ON v.oid = r.ev_class AND v.oid <> t.oid AND v.relkind IN ('v', 'm')
         JOIN pg_namespace vn ON vn.oid = v.relnamespace
         ORDER BY 1, 2, 3`,
    ]);

    const [version, tableRows, columnRows, constraintRows, inboundRows, indexRows, dependentRows, viewRows] = results.map((result) => result.rows as Row[]);
    const versionRow = version[0];
    const tables = new Map<string, TableFacts>();

    for (const row of tableRows) {
        const qualifiedKey = qualifiedName(row.schema as string, row.name as string);
        const hasStats = row.live !== null && row.live !== undefined;
        tables.set(qualifiedKey, {
            schema: row.schema as string,
            name: row.name as string,
            qualified: qualifiedKey,
            partitioned: row.partitioned as boolean,
            partitionCount: Number(row.partition_count),
            partitions: row.partitions as string[],
            nestedPartitions: row.nested_partitions as boolean,
            estimatedRows: row.estimated_rows === null ? null : Number(row.estimated_rows),
            heapBytes: Number(row.heap_bytes),
            indexBytes: Number(row.index_bytes),
            totalBytes: Number(row.total_bytes),
            columns: [],
            primaryKey: [],
            uniques: [],
            checks: [],
            foreignKeys: [],
            referencedBy: [],
            indexes: [],
            dependentViews: [],
            dependents: [],
            userTriggers: Number(row.user_triggers),
            stats: hasStats
                ? {
                      liveTuples: Number(row.live),
                      deadTuples: Number(row.dead),
                      lastVacuum: iso(row.last_autovacuum ?? row.last_vacuum),
                      lastAnalyze: iso(row.last_autoanalyze ?? row.last_analyze),
                      seqScans: Number(row.seq_scan),
                      indexScans: Number(row.idx_scan ?? 0),
                      modificationsSinceAnalyze: Number(row.mods),
                  }
                : null,
        });
    }

    const at = (row: Row) => tables.get(qualifiedName(row.schema as string, row.table as string));

    for (const row of columnRows) {
        at(row)?.columns.push({
            name: row.name as string,
            type: row.type as string,
            typeSchema: row.type_schema as string,
            notNull: row.not_null as boolean,
            default: (row.default as string | null) ?? null,
            generated: (row.generated as ColumnFacts["generated"]) ?? null,
            dependents: [],
            nullFraction: row.null_frac === null || row.null_frac === undefined ? null : Number(row.null_frac),
            distinct: row.n_distinct === null || row.n_distinct === undefined ? null : Number(row.n_distinct),
        });
    }

    const referentialAction: Record<string, string> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
    for (const row of constraintRows) {
        const table = at(row);
        if (!table) continue;
        const kind = row.kind as string;
        if (kind === "f") {
            table.foreignKeys.push({
                name: row.name as string,
                columns: row.columns as string[],
                refSchema: row.ref_schema as string,
                refTable: row.ref_table as string,
                refColumns: row.ref_columns as string[],
                onDelete: referentialAction[row.on_delete as string] ?? "NO ACTION",
                onUpdate: referentialAction[row.on_update as string] ?? "NO ACTION",
                validated: row.validated as boolean,
            });
            continue;
        }
        const constraint: ConstraintFacts = {
            name: row.name as string,
            kind: kind === "u" ? "unique" : kind === "c" ? "check" : "exclusion",
            definition: row.definition as string,
            columns: row.columns as string[],
            validated: row.validated as boolean,
        };
        if (kind === "c") table.checks.push(constraint);
        else table.uniques.push(constraint);
    }

    for (const row of inboundRows) {
        tables.get(qualifiedName(row.ref_schema as string, row.ref_table as string))?.referencedBy.push({
            name: row.name as string,
            schema: row.schema as string,
            table: row.table as string,
            columns: row.columns as string[],
            refColumns: row.ref_columns as string[],
        });
    }

    for (const row of indexRows) {
        const table = at(row);
        if (!table) continue;
        const index: IndexFacts = {
            name: row.name as string,
            definition: row.definition as string,
            columns: row.columns as (string | null)[],
            uses: row.uses as string[],
            method: row.method as string,
            unique: row.unique as boolean,
            primary: row.primary as boolean,
            valid: row.valid as boolean,
            partial: row.partial as boolean,
            constraint: (row.constraint as string | null) ?? null,
            bytes: Number(row.bytes),
            scans: row.scans === null || row.scans === undefined ? null : Number(row.scans),
        };
        table.indexes.push(index);
        if (index.primary) table.primaryKey = index.columns.filter((column): column is string => column !== null);
    }

    for (const row of dependentRows) {
        const table = at(row);
        if (!table) continue;
        const dependent: Dependent = { kind: row.kind as Dependent["kind"], description: row.description as string, blocks: row.blocks as boolean, external: row.external as boolean };
        if (row.column) table.columns.find((column) => column.name === row.column)?.dependents.push(dependent);
        // what would block DROP TABLE: objects that belong elsewhere, and functions; each once, however many columns they use
        if (dependent.external && !table.dependents.some((known) => known.description === dependent.description)) table.dependents.push(dependent);
    }

    for (const row of viewRows) at(row)?.dependentViews.push(row.view as string);

    return {
        serverVersionNum: Number(versionRow.num),
        serverVersion: versionRow.text as string,
        collectedAt: new Date().toISOString(),
        statsResetAt: iso(versionRow.stats_reset),
        tables,
    };
}

// ---- things only the database can say about a plan --------------------------------------------------------------------------

const PLAIN_TYPE = /^[A-Za-z_][A-Za-z0-9_$ ]*(\.[A-Za-z_][A-Za-z0-9_$]*)?(\s*\(\s*\d+\s*(,\s*\d+\s*)?\))?(\s*\[\s*\d*\s*\])*$/;

/** True for a type written as a plain name with optional length and array brackets; anything else is never sent to PostgreSQL. */
export const isPlainTypeName = (text: string): boolean => text.length <= 128 && PLAIN_TYPE.test(text.trim());

export interface ProbeRequest {
    /** Type names the plan uses (`varchar(40)`, `numeric(12,2)`, `public.mood`). */
    types: string[];
    /** Pairs of type names a column changes between (from, to), for the cast method. */
    typeChanges: { from: string; to: string }[];
    /** Names of functions that appear in default expressions. */
    functions: string[];
    /** Default expressions with the type they are for: PostgreSQL is asked to plan `SELECT CAST(expression AS type)`. */
    defaults: { expression: string; type: string }[];
    /** Quoted, schema-qualified names the plan wants to create: are they free? */
    relations: { schema: string; name: string }[];
    schemas: string[];
}

export interface Probes {
    /** Canonical name of a type PostgreSQL knows; undefined for one it doesn't. */
    types: Map<string, string | undefined>;
    /** The cast pg_cast has between two types: binary-coercible ("b") or by function ("f"). undefined when there is none (a conversion then needs a USING expression). */
    casts: Map<string, "b" | "f" | undefined>;
    /** `i`mmutable, `s`table or `v`olatile; the most volatile overload when there are several. undefined if no such function. */
    volatility: Map<string, "i" | "s" | "v" | undefined>;
    /** PostgreSQL's message when it rejects a default expression for a type; undefined when it accepts it. */
    defaults: Map<string, string | undefined>;
    /** Whether a table, index or sequence already has this schema-qualified name. */
    relationExists: Map<string, boolean>;
    schemaExists: Map<string, boolean>;
}

export const castKey = (from: string, to: string): string => `${from}\u0000${to}`;
export const defaultKey = (expression: string, type: string): string => `${type}\u0000${expression}`;
export const relationKey = (schema: string, name: string): string => `${schema}.${name}`;

export const emptyProbes = (): Probes => ({ types: new Map(), casts: new Map(), volatility: new Map(), defaults: new Map(), relationExists: new Map(), schemaExists: new Map() });

const quoteName = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export async function probe(client: Queryable, request: ProbeRequest): Promise<Probes> {
    const probes = emptyProbes();
    const typeNames = [...new Set([...request.types, ...request.typeChanges.flatMap((change) => [change.from, change.to])])].filter(isPlainTypeName);
    const functions = [...new Set(request.functions)].filter((name) => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name));
    for (const type of request.types) probes.types.set(type, undefined);

    const statements: string[] = [];
    const typeIndex = typeNames.length > 0 ? statements.push(`SELECT ${typeNames.map((type, i) => `format_type(to_regtype(${quoteLiteral(type)}), NULL) AS t${i}`).join(", ")}`) - 1 : -1;
    const castPairs = request.typeChanges.filter((change) => isPlainTypeName(change.from) && isPlainTypeName(change.to));
    const castIndex = castPairs.length > 0
        ? statements.push(`SELECT ${castPairs.map((change, i) => `(SELECT castmethod::text FROM pg_cast WHERE castsource = to_regtype(${quoteLiteral(change.from)}) AND casttarget = to_regtype(${quoteLiteral(change.to)})) AS c${i}`).join(", ")}`) - 1
        : -1;
    const functionIndex = functions.length > 0
        ? statements.push(`SELECT proname, string_agg(DISTINCT provolatile::text, '') AS volatility FROM pg_proc WHERE proname = ANY (ARRAY[${functions.map(quoteLiteral).join(", ")}]::text[]) GROUP BY proname`) - 1
        : -1;
    const relations = [...new Map(request.relations.map((relation) => [relationKey(relation.schema, relation.name), relation])).values()];
    const schemas = [...new Set([...request.schemas, ...relations.map((relation) => relation.schema)])];
    const existenceIndex = relations.length + schemas.length > 0
        ? statements.push(`SELECT ${[
              ...relations.map((relation, i) => `to_regclass(${quoteLiteral(`${quoteName(relation.schema)}.${quoteName(relation.name)}`)}) IS NOT NULL AS r${i}`),
              ...schemas.map((schema, i) => `to_regnamespace(${quoteLiteral(quoteName(schema))}) IS NOT NULL AS s${i}`),
          ].join(", ")}`) - 1
        : -1;

    if (statements.length > 0) {
        const results = await runReadOnly(client, statements);

        if (typeIndex >= 0) {
            const row = results[typeIndex].rows[0] as Row;
            typeNames.forEach((type, i) => probes.types.set(type, (row[`t${i}`] as string | null) ?? undefined));
        }
        if (castIndex >= 0) {
            const row = results[castIndex].rows[0] as Row;
            castPairs.forEach((change, i) => probes.casts.set(castKey(change.from, change.to), ((row[`c${i}`] as string | null) ?? undefined) as "b" | "f" | undefined));
        }
        for (const name of functions) probes.volatility.set(name, undefined);
        if (functionIndex >= 0) {
            for (const row of results[functionIndex].rows as { proname: string; volatility: string }[]) {
                probes.volatility.set(row.proname, row.volatility.includes("v") ? "v" : row.volatility.includes("s") ? "s" : "i");
            }
        }
        if (existenceIndex >= 0) {
            const row = results[existenceIndex].rows[0] as Row;
            relations.forEach((relation, i) => probes.relationExists.set(relationKey(relation.schema, relation.name), row[`r${i}`] as boolean));
            schemas.forEach((schema, i) => probes.schemaExists.set(schema, row[`s${i}`] as boolean));
        }
    }

    // One round trip each: a rejected default aborts its transaction, which is rolled back before the next one.
    for (const { expression, type } of request.defaults) {
        const key = defaultKey(expression, type);
        if (probes.defaults.has(key)) continue;
        if (!isPlainTypeName(type)) {
            probes.defaults.set(key, "The type name is not a plain type.");
            continue;
        }
        try {
            await runReadOnly(client, [`EXPLAIN SELECT CAST((${expression}) AS ${type})`]);
            probes.defaults.set(key, undefined);
        } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (typeof code !== "string") throw error;
            await client.query("ROLLBACK").catch(() => undefined);
            probes.defaults.set(key, error instanceof Error ? error.message : String(error));
        }
    }
    return probes;
}
