import { aiSchemaPlanSchema, type AiSchemaPlan } from "../ai/schema-plan.js";
import { compilePlan, discoverProbes } from "./compile.js";
import { castKey, checkKey, defaultKey, emptyProbes, relationKey, type ColumnFacts, type Dependent, type Facts, type IndexFacts, type ProbeRequest, type Probes, type TableFacts } from "./facts.js";
import type { CompileSettings, Runbook } from "./runbook.js";

/** Hand-made facts for tests: a table is as big as the test says, with the columns and indexes it lists. */

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

export interface TableSpec {
    name: string;
    schema?: string;
    rows?: number | null;
    bytes?: number;
    /** `name:type` or `name:type:notnull` or `name:type:null`. */
    columns?: string[];
    primaryKey?: string[];
    indexes?: Partial<IndexFacts>[];
    foreignKeys?: { name?: string; columns: string[]; ref: string; refColumns: string[] }[];
    uniques?: { name: string; columns: string[] }[];
    /** A CHECK constraint: `columns` are the columns it uses, as pg_constraint.conkey lists them. */
    checks?: { name: string; definition: string; columns: string[] }[];
    partitions?: string[];
    views?: string[];
    rowSecurity?: boolean;
    privileges?: { grantee: string; privilege: string; grantable?: boolean; owner?: boolean }[];
    /** Objects that depend on a column (`column` is its name) or, with no column, on the table. */
    dependents?: { column?: string; kind: Dependent["kind"]; description: string; blocks?: boolean; external?: boolean }[];
}

export function column(spec: string): ColumnFacts {
    const [name, type, flag] = spec.split(":");
    return { name, type: type ?? "integer", typeSchema: "pg_catalog", notNull: flag === "notnull", default: null, generated: null, dependents: [], nullFraction: null, distinct: null };
}

export function table(spec: TableSpec): TableFacts {
    const schema = spec.schema ?? "public";
    const bytes = spec.bytes ?? 8192;
    const pk = spec.primaryKey ?? (spec.columns?.some((c) => c.startsWith("id:")) ? ["id"] : []);
    const indexes: IndexFacts[] = [];
    if (pk.length > 0) indexes.push({ name: `${spec.name}_pkey`, definition: `CREATE UNIQUE INDEX ${spec.name}_pkey ON ${schema}.${spec.name} USING btree (${pk.join(", ")})`, columns: pk, uses: pk, method: "btree", unique: true, primary: true, valid: true, partial: false, constraint: `${spec.name}_pkey`, bytes: Math.round(bytes / 10), scans: 100 });
    for (const index of spec.indexes ?? []) {
        const columns = index.columns ?? [];
        indexes.push({ name: "idx", definition: "", columns, uses: columns.filter((name): name is string => name !== null), method: "btree", unique: false, primary: false, valid: true, partial: false, constraint: null, bytes: Math.round(bytes / 10), scans: 0, ...index });
    }
    const built: TableFacts = {
        schema,
        name: spec.name,
        qualified: `${schema}.${spec.name}`,
        partitioned: !!spec.partitions,
        partitionCount: spec.partitions?.length ?? 0,
        partitions: spec.partitions ?? [],
        nestedPartitions: false,
        estimatedRows: spec.rows === undefined ? 1000 : spec.rows,
        heapBytes: bytes,
        indexBytes: indexes.reduce((sum, index) => sum + index.bytes, 0),
        totalBytes: bytes + indexes.reduce((sum, index) => sum + index.bytes, 0),
        columns: (spec.columns ?? ["id:bigint:notnull"]).map(column),
        primaryKey: pk,
        uniques: (spec.uniques ?? []).map((unique) => ({ name: unique.name, kind: "unique" as const, definition: `UNIQUE (${unique.columns.join(", ")})`, columns: unique.columns, validated: true })),
        checks: (spec.checks ?? []).map((check) => ({ name: check.name, kind: "check" as const, definition: check.definition, columns: check.columns, validated: true })),
        foreignKeys: (spec.foreignKeys ?? []).map((fk, i) => {
            const [refSchema, refTable] = fk.ref.includes(".") ? fk.ref.split(".") : ["public", fk.ref];
            return { name: fk.name ?? `${spec.name}_fk${i}`, columns: fk.columns, refSchema, refTable, refColumns: fk.refColumns, onDelete: "NO ACTION", onUpdate: "NO ACTION", validated: true };
        }),
        referencedBy: [],
        indexes,
        dependentViews: spec.views ?? [],
        dependents: [],
        userTriggers: 0,
        rowSecurity: spec.rowSecurity ?? false,
        privileges: (spec.privileges ?? []).map((privilege) => ({ grantable: false, owner: false, ...privilege })),
        stats: null,
    };
    for (const dependent of spec.dependents ?? []) {
        const entry: Dependent = { kind: dependent.kind, description: dependent.description, blocks: dependent.blocks ?? true, external: dependent.external ?? false };
        if (dependent.column) built.columns.find((c) => c.name === dependent.column)?.dependents.push(entry);
        if (entry.external) built.dependents.push(entry);
    }
    return built;
}

export function facts(...tables: TableFacts[]): Facts {
    const map = new Map(tables.map((t) => [t.qualified, t]));
    for (const child of tables) {
        for (const fk of child.foreignKeys) {
            map.get(`${fk.refSchema}.${fk.refTable}`)?.referencedBy.push({ name: fk.name, schema: child.schema, table: child.name, columns: fk.columns, refColumns: fk.refColumns });
        }
    }
    return { serverVersionNum: 160000, serverVersion: "16.0", collectedAt: "2026-01-01T00:00:00.000Z", statsResetAt: "2026-01-01T00:00:00.000Z", tables: map };
}

export function plan(...operations: unknown[]): AiSchemaPlan {
    return aiSchemaPlanSchema.parse({ summary: "test", operations });
}

const CASTS: Record<string, "b" | "f"> = {
    [castKey("integer", "bigint")]: "f",
    [castKey("character varying(20)", "text")]: "b",
    [castKey("integer", "numeric")]: "f",
};

const VOLATILE = new Set(["random", "gen_random_uuid", "nextval", "clock_timestamp", "uuid_generate_v4"]);
const STABLE = new Set(["now", "current_timestamp", "current_date"]);
const IMMUTABLE = new Set(["lower", "upper", "abs", "coalesce"]);

/** What the database would say, for tests that don't have one: every type is known, defaults are accepted unless they name a function nobody has, and nothing exists under a new name. */
export function answer(request: ProbeRequest, overrides: { unknownTypes?: string[]; existing?: string[]; missingSchemas?: string[]; rejectedDefaults?: Record<string, string>; rejectedChecks?: Record<string, string> } = {}): Probes {
    const probes = emptyProbes();
    for (const type of [...request.types, ...request.typeChanges.flatMap((c) => [c.from, c.to])]) probes.types.set(type, overrides.unknownTypes?.includes(type) ? undefined : type);
    for (const change of request.typeChanges) probes.casts.set(castKey(change.from, change.to), CASTS[castKey(change.from, change.to)]);
    for (const name of request.functions) probes.volatility.set(name, VOLATILE.has(name) ? "v" : STABLE.has(name) ? "s" : IMMUTABLE.has(name) ? "i" : undefined);
    for (const { expression, type } of request.defaults) probes.defaults.set(defaultKey(expression, type), overrides.rejectedDefaults?.[expression]);
    for (const { table, expression } of request.checks) probes.checks.set(checkKey(table, expression), overrides.rejectedChecks?.[expression]);
    for (const relation of request.relations) probes.relationExists.set(relationKey(relation.schema, relation.name), overrides.existing?.includes(relationKey(relation.schema, relation.name)) ?? false);
    for (const schema of request.schemas) probes.schemaExists.set(schema, !overrides.missingSchemas?.includes(schema));
    return probes;
}

export function compile(plan_: AiSchemaPlan, facts_: Facts, options: { settings?: Partial<CompileSettings> } & Parameters<typeof answer>[1] = {}): Runbook {
    const { settings, ...overrides } = options;
    const probes = answer(discoverProbes({ plan: plan_, facts: facts_, settings }), overrides);
    return compilePlan({ plan: plan_, facts: facts_, probes, settings });
}
