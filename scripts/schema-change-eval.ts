/**
 * Measures the Schema Change pipeline on generated PostgreSQL databases of 50, 300 and 1,000 tables.
 *
 *   docker run -d --name goforge-schema -e POSTGRES_PASSWORD=schema -e POSTGRES_DB=schema -p 54330:5432 postgres:16 -c max_locks_per_transaction=1024
 *   npm run eval:schema                          # 50 / 300 / 1,000 tables, 25 requests each
 *   npm run eval:schema -- --sizes 300 --per-size 30 --seed 3
 *   npm run eval:schema -- --keep                # leave the generated databases for the browser (sc_eval_50, ...)
 *   OPENAI_API_KEY=sk-... [EVAL_MODEL=gpt-5.6-luna] npm run eval:schema -- --live    # a real model plans instead of the reference plans
 *   (the key has to be in this command's environment, this script does not read server/.env; EVAL_MODEL empty means OPENAI_MODEL, then gpt-5.6-luna)
 *
 * Each size gets a database with a real schema, real foreign keys and populated tables (260,000 rows in the big ones). A request is
 * a sentence in the words a person would use, with the operations a correct plan contains. For every request this measures:
 *   - table selection: are the tables the change touches in the scope that retrieval picks, and how big is the scope
 *   - plan validity: do the plan's operations pass the checks against the real catalog (with the retrieved scope, and with the right one)
 *   - migration lint: does the compiled runbook avoid the usual ways of locking a large table (and does a naive rendering not)
 *   - execution: does the runbook run, statement by statement in autocommit mode, on PostgreSQL 16, and leave the schema as asked
 *   - invalid requests: are they refused before any SQL is produced
 *   - latency of every deterministic stage, and what the request would cost to send (against sending every table)
 * The planner is the reference plan unless --live is given; with the reference plan nothing here says anything about a model's quality,
 * and the model's own latency and tokens are reported as not measured.
 */
import { DEFAULT_SETTINGS } from "../server/src/ai/policy";
import { getSettingsStore } from "../server/src/ai/provider";
import { callModelJson } from "../server/src/ai/provider";
import { aiSchemaPlanSchema, type AiSchemaPlan } from "../server/src/ai/schema-plan";
import { loadCatalog } from "../server/src/schema-change/catalog";
import { compilePlan, discoverProbes } from "../server/src/schema-change/compile";
import { loadFacts, probe, type Facts } from "../server/src/schema-change/facts";
import { lintSteps } from "../server/src/schema-change/lint";
import { planSchemaChange } from "../server/src/schema-change/planner";
import { plannerInput, plannerInstructions } from "../server/src/schema-change/prompt";
import { buildSearchIndex, selectScope } from "../server/src/schema-change/retrieval";
import { sizeClass, type Runbook, type RunbookStep } from "../server/src/schema-change/runbook";
import { createDatabase, dropDatabase, withDatabase, type PgClient } from "./lib/pg-scratch";
import { asRunner, runRunbook } from "./lib/plan-runner";
import { generateSchema, wordsOf, type SyntheticSchema, type SyntheticTable } from "./lib/synthetic-schema";

// ---- arguments -----------------------------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const SIZES = option("sizes", "50,300,1000").split(",").map(Number);
const PER_SIZE = Number(option("per-size", "20"));
const NEGATIVE_PER_SIZE = Number(option("negative", "5"));
const SEED = Number(option("seed", "11"));
const KEEP = args.includes("--keep");
const LIVE = args.includes("--live");
const OLD_TABLE_LIMIT = 250;

// ---- requests ------------------------------------------------------------------------------------------------------------

type Style = "plain" | "with-module" | "typo" | "column-only" | "partial-name";

interface Case {
    id: string;
    kind: string;
    style: Style;
    text: string;
    /** The tables the change touches. */
    truth: string[];
    operations: unknown[];
    /** A query that returns one row with `ok = true` when the change happened. */
    verify?: string;
    /** For an invalid request: the finding code the checks must refuse it with. */
    refusedWith?: string;
}

function lcg(seed: number) {
    let state = seed >>> 0;
    const next = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
    return { int: (n: number) => Math.floor(next() * n), pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)], chance: (p: number) => next() < p };
}

const NEW_COLUMNS = [
    { name: "carrier_name", type: "varchar", words: "carrier name" },
    { name: "internal_comment", type: "text", words: "internal comment" },
    { name: "reviewed_at", type: "timestamptz", words: "reviewed at timestamp" },
    { name: "risk_score", type: "integer", words: "risk score" },
    { name: "source_system", type: "varchar", words: "source system" },
];

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const dotted = (t: SyntheticTable) => `${q(t.schema)}.${q(t.name)}`;

function typoOf(word: string, r: ReturnType<typeof lcg>): string {
    if (word.length < 6) return word;
    const at = 1 + r.int(word.length - 3);
    return r.chance(0.5) ? word.slice(0, at) + word.slice(at + 1) : word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);
}

function buildCases(schema: SyntheticSchema, count: number, negatives: number, seed: number): Case[] {
    const r = lcg(seed);
    const tables = schema.tables.filter((t) => t.role !== "hub");
    const bareCount = new Map<string, number>();
    for (const t of schema.tables) bareCount.set(t.name, (bareCount.get(t.name) ?? 0) + 1);
    const used = new Set<string>();

    /** How a person would name the table: its words, the module when the name alone would be ambiguous, sometimes with a typo or only its last words. */
    const say = (t: SyntheticTable, style: Style): string => {
        let words = t.words.map(wordsOf);
        if (style === "partial-name" && words.length >= 3) words = words.slice(-2);
        if (style === "with-module" && !words.includes(wordsOf(t.module))) words = [wordsOf(t.module), ...words];
        if (style === "typo") {
            const longest = words.reduce((best, word, i) => (word.length > words[best].length ? i : best), 0);
            words = words.map((word, i) => (i === longest ? typoOf(word, r) : word));
        }
        return words.join(" ");
    };
    const styleFor = (t: SyntheticTable, preferred: Style): Style => ((bareCount.get(t.name) ?? 0) > 1 && preferred !== "typo" ? "with-module" : preferred);
    // Every request runs on its own copy of the database, so a table can be used again once the unused ones are gone.
    const fresh = (list: SyntheticTable[]): SyntheticTable | undefined => {
        const unused = list.filter((t) => !used.has(t.qualified));
        const options = unused.length > 0 ? unused : list;
        const picked = options.length > 0 ? r.pick(options) : undefined;
        if (picked) used.add(picked.qualified);
        return picked;
    };
    const exists = (name: string, t: SyntheticTable) => t.columns.some((c) => c.name === name);
    const populated = tables.filter((t) => t.rows > 0);
    const styles: Style[] = ["plain", "plain", "with-module", "typo", "partial-name"];
    const cases: Case[] = [];

    const generators: Array<() => Case | undefined> = [
        // a column nobody has yet
        () => {
            const t = fresh(r.chance(0.5) && populated.length ? populated : tables);
            if (!t) return;
            const column = r.pick(NEW_COLUMNS.filter((c) => !exists(c.name, t)));
            if (!column) return;
            const style = styleFor(t, r.pick(styles));
            return {
                id: "", kind: "add column", style, text: `add a ${column.words} column to the ${say(t, style)} table`, truth: [t.qualified],
                operations: [{ type: "add_column", tableName: t.qualified, field: { name: column.name, dataType: column.type, ...(column.type === "varchar" ? { maxLength: 120 } : {}) } }],
                verify: `SELECT count(*) = 1 AS ok FROM information_schema.columns WHERE table_schema = '${t.schema}' AND table_name = '${t.name}' AND column_name = '${column.name}'`,
            };
        },
        // a required flag with a default: no rewrite on a big table
        () => {
            const t = fresh(populated.length ? populated : tables);
            if (!t) return;
            const style = styleFor(t, r.pick(styles));
            return {
                id: "", kind: "add required column with default", style, text: `every ${say(t, style)} record needs a required reviewed flag that is false unless someone sets it`, truth: [t.qualified],
                operations: [{ type: "add_column", tableName: t.qualified, field: { name: "is_reviewed", dataType: "boolean", nullable: false, defaultValue: "false" } }],
                verify: `SELECT count(*) = 1 AS ok FROM pg_attribute WHERE attrelid = '${dotted(t)}'::regclass AND attname = 'is_reviewed' AND attnotnull`,
            };
        },
        // a column filled by a volatile default on existing rows
        () => {
            const t = fresh(populated.length ? populated : tables);
            if (!t) return;
            const style = styleFor(t, r.pick(styles));
            return {
                id: "", kind: "add column with volatile default", style, text: `give each ${say(t, style)} a public uuid that is required`, truth: [t.qualified],
                operations: [{ type: "add_column", tableName: t.qualified, field: { name: "public_uuid", dataType: "uuid", nullable: false, defaultValue: "gen_random_uuid()" } }],
                verify: `SELECT count(*) = 1 AS ok FROM pg_attribute WHERE attrelid = '${dotted(t)}'::regclass AND attname = 'public_uuid' AND attnotnull`,
            };
        },
        // an index on an existing column
        () => {
            const t = fresh(r.chance(0.6) && populated.length ? populated : tables);
            if (!t) return;
            const candidates = t.columns.filter((c) => !["id", "notes"].includes(c.name) && !t.indexes.some((i) => i.columns[0] === c.name) && !c.type.startsWith("text"));
            const column = candidates.length ? r.pick(candidates) : undefined;
            if (!column) return;
            const style = styleFor(t, r.pick(styles));
            const name = `${t.name}_${column.name}_eval_idx`.slice(0, 60);
            return {
                id: "", kind: "add index", style, text: `queries on ${say(t, style)} filtered by ${wordsOf(column.name)} are slow, add an index`, truth: [t.qualified],
                operations: [{ type: "add_index", tableName: t.qualified, index: { name, columns: [column.name] } }],
                verify: `SELECT count(*) = 1 AS ok FROM pg_index WHERE indexrelid = '${q(t.schema)}.${q(name)}'::regclass AND indisvalid`,
            };
        },
        // an index found through the column name alone
        () => {
            const counts = new Map<string, number>();
            for (const t of tables) for (const c of t.columns) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
            const t = fresh(tables.filter((x) => x.columns.some((c) => c.name.endsWith("_code") && c.name !== "code" && counts.get(c.name) === 1)));
            if (!t) return;
            const column = t.columns.find((c) => c.name.endsWith("_code") && c.name !== "code" && counts.get(c.name) === 1) ?? t.columns[0];
            const name = `${t.name}_${column.name}_eval_idx`.slice(0, 60);
            return {
                id: "", kind: "add index (column only)", style: "column-only", text: `lookups by ${wordsOf(column.name)} need an index`, truth: [t.qualified],
                operations: [{ type: "add_index", tableName: t.qualified, index: { name, columns: [column.name] } }],
                verify: `SELECT count(*) = 1 AS ok FROM pg_index WHERE indexrelid = '${q(t.schema)}.${q(name)}'::regclass AND indisvalid`,
            };
        },
        // unique codes
        () => {
            const t = fresh(schema.tables.filter((x) => x.role === "root" && (x.rows > 0 || r.chance(0.5))));
            if (!t) return;
            const style = styleFor(t, r.pick(styles));
            return {
                id: "", kind: "make unique", style, text: `the code of a ${say(t, style)} must be unique`, truth: [t.qualified],
                operations: [{ type: "alter_column", tableName: t.qualified, columnName: "code", changes: { unique: true } }],
                verify: `SELECT count(*) = 1 AS ok FROM pg_constraint WHERE conrelid = '${dotted(t)}'::regclass AND contype = 'u'`,
            };
        },
        // required column that already has values
        () => {
            const t = fresh(schema.tables.filter((x) => x.role === "root" && x.columns.some((c) => c.name === "organization_id") && (x.rows > 0 || r.chance(0.5))));
            if (!t) return;
            const style = styleFor(t, r.pick(styles));
            return {
                id: "", kind: "make column required", style, text: `a ${say(t, style)} must always belong to an organization`, truth: [t.qualified],
                operations: [{ type: "alter_column", tableName: t.qualified, columnName: "organization_id", changes: { nullable: false } }],
                verify: `SELECT count(*) = 1 AS ok FROM pg_attribute WHERE attrelid = '${dotted(t)}'::regclass AND attname = 'organization_id' AND attnotnull`,
            };
        },
        // longer text: only the catalog changes
        () => {
            const t = fresh(populated.length ? populated : tables);
            if (!t) return;
            const column = t.columns.find((c) => /^varchar\(\d+\)$/.test(c.type) && c.name !== "code");
            if (!column) return;
            const length = Number(/\((\d+)\)/.exec(column.type)?.[1]) + 100;
            const style = styleFor(t, r.pick(styles));
            return {
                id: "", kind: "lengthen a varchar", style, text: `${wordsOf(column.name)} on ${say(t, style)} is too short, allow longer values`, truth: [t.qualified],
                operations: [{ type: "alter_column", tableName: t.qualified, columnName: column.name, changes: { dataType: "varchar", maxLength: length } }],
                verify: `SELECT format_type(atttypid, atttypmod) = 'character varying(${length})' AS ok FROM pg_attribute WHERE attrelid = '${dotted(t)}'::regclass AND attname = '${column.name}'`,
            };
        },
        // integer to bigint: a rewrite unless it is done in steps
        () => {
            const t = fresh(populated.filter((x) => x.columns.some((c) => c.type === "integer")).length ? populated.filter((x) => x.columns.some((c) => c.type === "integer")) : tables.filter((x) => x.columns.some((c) => c.type === "integer")));
            if (!t) return;
            const column = t.columns.find((c) => c.type === "integer");
            if (!column) return;
            const style = styleFor(t, r.pick(styles));
            return {
                id: "", kind: "change integer to bigint", style, text: `${wordsOf(column.name)} on ${say(t, style)} is about to overflow, make it a bigint`, truth: [t.qualified],
                operations: [{ type: "alter_column", tableName: t.qualified, columnName: column.name, changes: { dataType: "bigint" } }],
                verify: `SELECT format_type(atttypid, atttypmod) = 'bigint' AS ok FROM pg_attribute WHERE attrelid = '${dotted(t)}'::regclass AND attname = '${column.name}'`,
            };
        },
        // a foreign key for a column that points somewhere without one
        () => {
            const child = fresh(tables.filter((t) => t.columns.some((c) => c.refersTo)));
            if (!child) return;
            const column = child.columns.find((c) => c.refersTo)!;
            const parent = schema.tables.find((t) => t.qualified === column.refersTo)!;
            const childStyle = styleFor(child, r.pick(["plain", "with-module"]));
            const parentStyle = styleFor(parent, "plain");
            return {
                id: "", kind: "add foreign key", style: childStyle, text: `${wordsOf(column.name)} on ${say(child, childStyle)} should be a real foreign key to ${say(parent, parentStyle)}`, truth: [child.qualified, parent.qualified],
                operations: [{ type: "add_relationship", relationship: { sourceTable: parent.qualified, sourceColumn: "id", targetTable: child.qualified, targetColumn: column.name } }],
                verify: `SELECT count(*) = 1 AS ok FROM pg_constraint WHERE conrelid = '${dotted(child)}'::regclass AND contype = 'f' AND convalidated AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = '${dotted(child)}'::regclass AND attname = '${column.name}')]`,
            };
        },
        // drop an index nobody needs
        () => {
            const t = fresh(tables.filter((x) => x.indexes.length > 0));
            if (!t) return;
            const index = t.indexes[0];
            const style = styleFor(t, r.pick(styles));
            return {
                id: "", kind: "drop index", style, text: `the index on ${index.columns.map(wordsOf).join(" and ")} of ${say(t, style)} is never used, drop it`, truth: [t.qualified],
                operations: [{ type: "drop_index", tableName: t.qualified, indexName: index.name }],
                verify: `SELECT to_regclass('${q(t.schema)}.${q(index.name)}') IS NULL AS ok`,
            };
        },
        // rename a column
        () => {
            const t = fresh(tables.filter((x) => x.role === "root"));
            if (!t) return;
            const style = styleFor(t, r.pick(styles));
            return {
                id: "", kind: "rename column", style, text: `rename the notes column of ${say(t, style)} to remarks`, truth: [t.qualified],
                operations: [{ type: "alter_column", tableName: t.qualified, columnName: "notes", changes: { newName: "remarks" } }],
                verify: `SELECT count(*) = 1 AS ok FROM pg_attribute WHERE attrelid = '${dotted(t)}'::regclass AND attname = 'remarks'`,
            };
        },
        // a new table that points at an existing one
        () => {
            const t = fresh(schema.tables.filter((x) => x.role === "root"));
            if (!t) return;
            const style = styleFor(t, r.pick(styles));
            const name = `${t.name}_eval_audit`.slice(0, 60);
            return {
                id: "", kind: "create table with foreign key", style, text: `create an audit trail table for ${say(t, style)} that records who changed what and when`, truth: [t.qualified],
                operations: [
                    { type: "create_table", table: { name: `${t.schema}.${name}`, fields: [{ name: "id", dataType: "bigint", primaryKey: true, autoIncrement: true }, { name: `${t.entity}_id`, dataType: "bigint", nullable: false }, { name: "changed_by", dataType: "bigint" }, { name: "changed_at", dataType: "timestamptz", nullable: false, defaultValue: "now()" }], indexes: [{ name: `${name}_changed_idx`, columns: ["changed_at"] }] } },
                    { type: "add_relationship", relationship: { sourceTable: t.qualified, sourceColumn: "id", targetTable: `${t.schema}.${name}`, targetColumn: `${t.entity}_id` } },
                ],
                verify: `SELECT count(*) = 1 AS ok FROM pg_constraint WHERE conrelid = '${q(t.schema)}.${q(name)}'::regclass AND contype = 'f' AND convalidated`,
            };
        },
        // one change in two tables
        () => {
            const a = fresh(populated.length ? populated : tables);
            const b = fresh(tables);
            if (!a || !b) return;
            const sa = styleFor(a, "plain");
            const sb = styleFor(b, "plain");
            return {
                id: "", kind: "same change in two tables", style: sa, text: `add an archived at timestamp to ${say(a, sa)} and to ${say(b, sb)}`, truth: [a.qualified, b.qualified],
                operations: [a, b].map((t) => ({ type: "add_column", tableName: t.qualified, field: { name: "archived_at", dataType: "timestamptz" } })),
                verify: `SELECT count(*) = 2 AS ok FROM pg_attribute WHERE attname = 'archived_at' AND attrelid IN ('${dotted(a)}'::regclass, '${dotted(b)}'::regclass)`,
            };
        },
    ];

    for (let attempt = 0; cases.length < count && attempt < count * 30; attempt++) {
        const made = generators[attempt % generators.length]();
        if (made) cases.push({ ...made, id: `v${cases.length + 1}` });
    }

    // requests that must be refused before any SQL is produced
    const refusals: Array<() => Case | undefined> = [
        () => {
            const t = r.pick(tables);
            return { id: "", kind: "index on a column that does not exist", style: "plain", text: `index the ${say(t, "plain")} table by its fiscal period`, truth: [t.qualified], operations: [{ type: "add_index", tableName: t.qualified, index: { name: `${t.name}_fiscal_idx`.slice(0, 60), columns: ["fiscal_period"] } }], refusedWith: "unknown-column" };
        },
        () => {
            const t = r.pick(populated.length ? populated : tables);
            return { id: "", kind: "NOT NULL column without a default on a table with rows", style: "plain", text: `add a required approver to ${say(t, "plain")}`, truth: [t.qualified], operations: [{ type: "add_column", tableName: t.qualified, field: { name: "approver", dataType: "text", nullable: false } }], refusedWith: "not-null-needs-default" };
        },
        () => {
            const t = r.pick(tables.filter((x) => x.role === "root"));
            const column = t.columns.find((c) => c.type.startsWith("varchar")) ?? t.columns[1];
            return { id: "", kind: "foreign key between different types", style: "plain", text: `${wordsOf(column.name)} of ${say(t, "plain")} should reference users`, truth: [t.qualified, "public.users"], operations: [{ type: "add_relationship", relationship: { sourceTable: "public.users", sourceColumn: "id", targetTable: t.qualified, targetColumn: column.name } }], refusedWith: "type-mismatch" };
        },
        () => {
            const roots = tables.filter((x) => x.role === "root" && schema.tables.some((c) => c.parent === x.qualified));
            const t = r.pick(roots);
            return { id: "", kind: "drop a table other tables point at", style: "plain", text: `drop the ${say(t, "plain")} table, we do not need it any more`, truth: [t.qualified, ...schema.tables.filter((c) => c.parent === t.qualified).map((c) => c.qualified)], operations: [{ type: "drop_table", tableName: t.qualified }], refusedWith: "referenced" };
        },
        () => {
            const t = r.pick(tables);
            return { id: "", kind: "default that carries a second statement", style: "plain", text: `${say(t, "plain")} gets a status note defaulting to nothing`, truth: [t.qualified], operations: [{ type: "add_column", tableName: t.qualified, field: { name: "status_note", dataType: "text", defaultValue: "'x'; DROP TABLE users" } }], refusedWith: "bad-default" };
        },
        () => {
            const t = r.pick(tables.filter((x) => x.role === "root"));
            return { id: "", kind: "make the primary key nullable", style: "plain", text: `${say(t, "plain")} ids may be empty`, truth: [t.qualified], operations: [{ type: "alter_column", tableName: t.qualified, columnName: "id", changes: { nullable: true } }], refusedWith: "primary-key-column" };
        },
    ];
    for (let i = 0; i < negatives; i++) {
        const made = refusals[i % refusals.length]();
        if (made) cases.push({ ...made, id: `n${i + 1}` });
    }
    return cases;
}

// ---- measuring -----------------------------------------------------------------------------------------------------------

const median = (values: number[]): number => (values.length === 0 ? 0 : [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]);
const percentile = (values: number[], p: number): number => (values.length === 0 ? 0 : [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]);
const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(0)}%`.padStart(4));
const ms = (value: number): string => `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
const time = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const start = performance.now();
    const result = await fn();
    return [result, performance.now() - start];
};

/** What a plain rendering of the same operations would be: one statement each, the way a schema diff tool writes them. */
function naiveSteps(operations: AiSchemaPlan["operations"], facts: Facts): RunbookStep[] {
    const base = { operation: 0, lock: "ACCESS EXCLUSIVE" as const, alsoLocks: [], work: "metadata" as const, risk: "low" as const, reason: "", notes: [], destructive: false, breaksClients: false, optional: false };
    const steps: RunbookStep[] = [];
    const push = (tableName: string, sql: string, work: RunbookStep["work"] = "metadata") => {
        const table = facts.tables.get(tableName);
        steps.push({ ...base, id: steps.length + 1, title: sql.slice(0, 40), sql, table: tableName, work, sizeClass: sizeClass(table), tableBytes: table?.heapBytes ?? null, tableRows: table?.estimatedRows ?? null });
    };
    for (const op of operations) {
        const t = "tableName" in op ? (op.tableName as string) : "";
        switch (op.type) {
            case "add_column":
                push(t, `ALTER TABLE ${t} ADD COLUMN ${op.field.name} ${op.field.dataType}${op.field.nullable === false ? " NOT NULL" : ""}${op.field.defaultValue ? ` DEFAULT ${op.field.defaultValue}` : ""};`, op.field.defaultValue?.includes("(") ? "rewrite" : "metadata");
                break;
            case "add_index":
                push(t, `CREATE ${op.index.unique ? "UNIQUE " : ""}INDEX ${op.index.name} ON ${t} (${op.index.columns.join(", ")});`, "index-build");
                break;
            case "drop_index":
                push(t, `DROP INDEX ${op.indexName};`);
                break;
            case "alter_column":
                if (op.changes.nullable === false) push(t, `ALTER TABLE ${t} ALTER COLUMN ${op.columnName} SET NOT NULL;`, "scan");
                if (op.changes.dataType) push(t, `ALTER TABLE ${t} ALTER COLUMN ${op.columnName} TYPE ${op.changes.dataType};`, "rewrite");
                if (op.changes.unique) push(t, `ALTER TABLE ${t} ADD CONSTRAINT ${t.split(".")[1]}_${op.columnName}_key UNIQUE (${op.columnName});`, "index-build");
                if (op.changes.newName) push(t, `ALTER TABLE ${t} RENAME COLUMN ${op.columnName} TO ${op.changes.newName};`);
                break;
            case "add_relationship":
                push(op.relationship.targetTable, `ALTER TABLE ${op.relationship.targetTable} ADD FOREIGN KEY (${op.relationship.targetColumn}) REFERENCES ${op.relationship.sourceTable} (${op.relationship.sourceColumn});`, "scan");
                break;
            default:
                break;
        }
    }
    return steps;
}

interface Row {
    kase: Case;
    style: Style;
    scopeSize: number;
    full: boolean;
    recall: number;
    searchMs: number;
    e2eOk: boolean;
    oracleOk?: boolean;
    lintOk?: boolean;
    executed?: boolean;
    verified?: boolean;
    refused?: boolean;
    refusedRight?: boolean;
    compileMs: number;
    factsMs: number;
    stageMs: number;
    scopedChars: number;
    steps: number;
    risk: Record<string, number>;
    naiveFlagged?: boolean;
    sizeClasses: string[];
    problem?: string;
}

async function evaluate(size: number): Promise<{ rows: Row[]; header: Record<string, number | string>; failures: string[] }> {
    const schema = generateSchema(size, SEED + size);
    const template = `sc_eval_${size}`;
    const header: Record<string, number | string> = { tables: schema.tables.length, populated: schema.tables.filter((t) => t.rows > 0).length };
    const failures: string[] = [];

    console.log(`\n=== ${size} tables ===`);
    const [, buildMs] = await time(async () => {
        await createDatabase(template, async (client) => {
            await client.query(schema.createSql.join(";\n"));
            for (const statement of schema.populateSql) await client.query(statement);
            for (const statement of schema.foreignKeySql) await client.query(statement);
            await client.query("ANALYZE");
        });
    });
    console.log(`  built and populated in ${(buildMs / 1000).toFixed(1)} s`);
    header.buildSeconds = Math.round(buildMs / 100) / 10;

    const rows: Row[] = [];
    try {
        // the catalog the page reads once and searches many times
        const catalogClient = await (await import("./lib/pg-scratch")).connect(template);
        const [catalog, catalogMs] = await time(() => loadCatalog(asRunner(catalogClient)));
        const [index, indexMs] = await time(async () => buildSearchIndex(catalog));
        header.catalogMs = Math.round(catalogMs);
        header.indexMs = Math.round(indexMs * 10) / 10;

        // what sending every table would cost, for comparison
        const everyone = catalog.tables.map((t) => t.qualified);
        const [allFacts, allFactsMs] = await time(() => loadFacts(asRunner(catalogClient), everyone));
        const fullChars = JSON.stringify(plannerInput({ prompt: "x", facts: allFacts, omittedTables: 0 })).length + plannerInstructions().length;
        header.allFactsMs = Math.round(allFactsMs);
        header.fullChars = fullChars;
        const sampleFacts = allFacts;
        await catalogClient.end();
        console.log(`  catalog ${ms(catalogMs)}, search index ${ms(indexMs)}, facts for all ${catalog.tables.length} tables ${ms(allFactsMs)} (${(fullChars / 1000).toFixed(0)}k characters if every table were sent)`);

        const cases = buildCases(schema, PER_SIZE, NEGATIVE_PER_SIZE, SEED * 1000 + size);
        console.log(`  ${cases.filter((c) => !c.refusedWith).length} change requests and ${cases.filter((c) => c.refusedWith).length} that should be refused`);

        for (const kase of cases) {
            const plan = aiSchemaPlanSchema.parse({ summary: kase.text, operations: kase.operations });

            // 1. which tables
            const [scope, searchMs] = await time(async () => selectScope(index, kase.text));
            const picked = new Set(scope.tables.map((t) => t.qualified));
            const hit = kase.truth.filter((name) => picked.has(name)).length;

            const row: Row = {
                kase, style: kase.style, scopeSize: scope.tables.length, full: hit === kase.truth.length, recall: kase.truth.length ? hit / kase.truth.length : 1, searchMs, e2eOk: false,
                compileMs: 0, factsMs: 0, stageMs: 0, scopedChars: 0, steps: 0, risk: { low: 0, medium: 0, high: 0 }, sizeClasses: [],
            };

            await withDatabase(async (client) => {
                const db = asRunner(client);
                const compileFor = async (scopeTables: string[], operations = plan) => {
                    const [facts, factsMs] = await time(() => loadFacts(db, scopeTables));
                    const [runbook, compileMs] = await time(async () => {
                        const probes = await probe(db, discoverProbes({ plan: operations, facts }));
                        return compilePlan({ plan: operations, facts, probes });
                    });
                    return { facts, runbook, factsMs, compileMs };
                };

                // 2. the plan against the tables retrieval chose (when it chose the right ones, this is what a person would get)
                const retrieved = await compileFor([...picked]);
                row.factsMs = retrieved.factsMs;
                row.compileMs = retrieved.compileMs;
                row.scopedChars = JSON.stringify(plannerInput({ prompt: kase.text, facts: retrieved.facts, omittedTables: size - picked.size })).length + plannerInstructions().length;
                const retrievedErrors = retrieved.runbook.findings.filter((f) => f.severity === "error");
                row.e2eOk = retrievedErrors.length === 0;

                // 3. the plan against the right tables
                const oracle = await compileFor(kase.truth);
                const errors = oracle.runbook.findings.filter((f) => f.severity === "error");
                row.stageMs = row.searchMs + oracle.factsMs + oracle.compileMs;

                if (kase.refusedWith) {
                    row.refused = errors.length > 0;
                    row.refusedRight = errors.some((f) => f.code === kase.refusedWith);
                    row.problem = row.refusedRight ? undefined : `expected ${kase.refusedWith}, got ${errors.map((f) => f.code).join(", ") || "no error"}`;
                    return;
                }

                row.oracleOk = errors.length === 0;
                if (!row.oracleOk) {
                    row.problem = errors.map((f) => f.message).join(" | ").slice(0, 300);
                    return;
                }
                const lint = lintSteps(oracle.runbook.steps);
                row.lintOk = lint.violations.length === 0;
                if (!row.lintOk) row.problem = lint.violations.map((v) => `${v.rule}: ${v.statement}`).join(" | ").slice(0, 300);
                row.steps = oracle.runbook.steps.length;
                for (const step of oracle.runbook.steps) if (!step.optional) row.risk[step.risk]++;
                row.sizeClasses = [...new Set(oracle.runbook.steps.map((s) => s.sizeClass))];

                const naive = lintSteps(naiveSteps(plan.operations, oracle.facts));
                row.naiveFlagged = naive.violations.length > 0;

                const result = await runRunbook(client, oracle.runbook, { includeOptional: true });
                row.executed = result.ok;
                if (!result.ok) {
                    row.problem = `step ${result.failure?.step} (${result.failure?.title}): ${result.failure?.message}`.slice(0, 300);
                    return;
                }
                if (kase.verify) row.verified = Boolean((await client.query(kase.verify)).rows[0]?.ok);
                if (row.verified === false) row.problem = "the schema is not what the request asked for after the runbook ran";
            }, { template });

            rows.push(row);
            const flag = kase.refusedWith ? (row.refusedRight ? "refused" : "MISSED") : row.verified ? "ok" : "FAILED";
            process.stdout.write(`  ${kase.id.padEnd(4)} ${flag.padEnd(8)} recall ${row.full ? "full" : "MISS"} scope ${String(row.scopeSize).padStart(2)}  ${kase.kind}\n`);
            if (flag === "FAILED" || flag === "MISSED") failures.push(`${size} tables, ${kase.id} (${kase.kind}): ${row.problem}`);
        }

        // 4. the same checks when a real model plans (only with --live)
        if (LIVE) {
            console.log("  live model: planning the valid requests through the full pipeline");
            const live = new LiveStats();
            await live.run(template, cases.filter((c) => !c.refusedWith), index, catalog.tables.length, sampleFacts);
            header.liveValid = live.valid;
            header.liveTotal = live.total;
            header.liveLatencyMedianMs = Math.round(median(live.latencies));
            header.liveInputTokens = live.inputTokens;
            header.liveOutputTokens = live.outputTokens;
        }
    } finally {
        if (!KEEP) await dropDatabase(template);
    }
    return { rows, header, failures };
}

class LiveStats {
    valid = 0;
    total = 0;
    latencies: number[] = [];
    inputTokens = 0;
    outputTokens = 0;

    async run(template: string, cases: Case[], _index: unknown, _tables: number, _facts: Facts) {
        const settings = getSettingsStore();
        settings.write({ ...DEFAULT_SETTINGS, model: process.env.EVAL_MODEL ?? "" });
        const connect = (await import("./lib/pg-scratch")).connect;
        const client = await connect(template);
        try {
            const db = asRunner(client);
            const catalog = await loadCatalog(db);
            const index = buildSearchIndex(catalog);
            for (const kase of cases) {
                this.total++;
                const scope = selectScope(index, kase.text).tables.map((t) => t.qualified);
                try {
                    const result = await planSchemaChange(
                        { loadFacts: (names) => loadFacts(db, names), probe: (request) => probe(db, request), wholeDatabase: async () => ({ tables: catalog.tables }), callModel: callModelJson },
                        { prompt: kase.text, tables: scope, redact: false, connection: { id: "eval", name: template } },
                    );
                    this.latencies.push(result.modelLatencyMs);
                    this.inputTokens += result.usage.inputTokens ?? 0;
                    this.outputTokens += result.usage.outputTokens ?? 0;
                    if (result.runbook && !result.findings.some((f) => f.severity === "error")) this.valid++;
                } catch (error) {
                    console.log(`    ${kase.id}: ${error instanceof Error ? error.message : error}`);
                }
            }
        } finally {
            await client.end();
        }
    }
}

// ---- report ----------------------------------------------------------------------------------------------------------------

function report(size: number, rows: Row[], header: Record<string, number | string>) {
    const valid = rows.filter((r) => !r.kase.refusedWith);
    const refused = rows.filter((r) => r.kase.refusedWith);
    console.log(`\n--- ${size} tables: results ---`);

    console.log("table selection (the tables the change touches, found from the request's words, columns and foreign keys)");
    console.log(`  every table found      ${pct(valid.filter((r) => r.full).length, valid.length)}  (${valid.filter((r) => r.full).length}/${valid.length})`);
    console.log(`  mean share found       ${pct(valid.reduce((s, r) => s + r.recall, 0), valid.length)}`);
    console.log(`  scope size             median ${median(valid.map((r) => r.scopeSize))}, max ${Math.max(0, ...valid.map((r) => r.scopeSize))} of ${size} tables`);
    for (const style of ["plain", "with-module", "typo", "partial-name", "column-only"] as Style[]) {
        const group = valid.filter((r) => r.style === style);
        if (group.length > 0) console.log(`    ${style.padEnd(13)} every table found ${pct(group.filter((r) => r.full).length, group.length)} (${group.filter((r) => r.full).length}/${group.length})`);
    }
    const misses = valid.filter((r) => !r.full);
    for (const miss of misses.slice(0, 4)) console.log(`    missed: "${miss.kase.text}" -> wanted ${miss.kase.truth.join(", ")}`);

    console.log("what is sent to the model");
    const scoped = median(valid.map((r) => r.scopedChars));
    const full = Number(header.fullChars);
    console.log(`  every table          ${(full / 1000).toFixed(0)}k characters (about ${Math.round(full / 4000)}k tokens, estimated)${size > OLD_TABLE_LIMIT ? `, and the old request refused anything over ${OLD_TABLE_LIMIT} tables` : ""}`);
    console.log(`  chosen scope         ${(scoped / 1000).toFixed(0)}k characters median (about ${Math.round(scoped / 4000)}k tokens), ${(full / Math.max(1, scoped)).toFixed(0)}x smaller`);

    console.log("plan checks against the real catalog (reference plans: these measure the checks and the compiler, not a model)");
    console.log(`  with the retrieved tables   ${pct(valid.filter((r) => r.e2eOk).length, valid.length)}  (a missed table makes its change unplannable)`);
    console.log(`  with the right tables       ${pct(valid.filter((r) => r.oracleOk).length, valid.length)}  (${valid.filter((r) => r.oracleOk).length}/${valid.length})`);
    console.log(`  invalid requests refused    ${pct(refused.filter((r) => r.refusedRight).length, refused.length)}  (${refused.filter((r) => r.refusedRight).length}/${refused.length}, each with the expected reason)`);

    console.log("migration lint and execution");
    const compiled = valid.filter((r) => r.oracleOk);
    console.log(`  lint passes                 ${pct(compiled.filter((r) => r.lintOk).length, compiled.length)}  (${compiled.filter((r) => r.lintOk).length}/${compiled.length})`);
    console.log(`  a plain rendering is flagged ${pct(compiled.filter((r) => r.naiveFlagged).length, compiled.length)}  (${compiled.filter((r) => r.naiveFlagged).length}/${compiled.length}: the same lint on one statement per operation)`);
    console.log(`  runs on PostgreSQL 16       ${pct(compiled.filter((r) => r.executed).length, compiled.length)}  (${compiled.filter((r) => r.executed).length}/${compiled.length}, every statement on its own)`);
    console.log(`  leaves the schema as asked  ${pct(compiled.filter((r) => r.verified).length, compiled.length)}  (${compiled.filter((r) => r.verified).length}/${compiled.length})`);
    const touched = compiled.filter((r) => r.sizeClasses.some((c) => c === "medium" || c === "large"));
    console.log(`  of those, on a table with data (16 MiB or more): ${touched.length}; steps by risk ${JSON.stringify(compiled.reduce((s, r) => ({ low: s.low + r.risk.low, medium: s.medium + r.risk.medium, high: s.high + r.risk.high }), { low: 0, medium: 0, high: 0 }))}`);

    console.log("latency (every stage that doesn't wait for a model)");
    console.log(`  read the catalog            ${ms(Number(header.catalogMs))} once, search index ${ms(Number(header.indexMs))}`);
    console.log(`  find the tables             median ${ms(median(valid.map((r) => r.searchMs)))}, p95 ${ms(percentile(valid.map((r) => r.searchMs), 0.95))}`);
    console.log(`  read facts of the scope     median ${ms(median(valid.map((r) => r.factsMs)))}`);
    console.log(`  check and compile           median ${ms(median(valid.map((r) => r.compileMs)))}, p95 ${ms(percentile(valid.map((r) => r.compileMs), 0.95))}`);
    console.log(`  whole deterministic path    median ${ms(median(rows.map((r) => r.stageMs)))}, p95 ${ms(percentile(rows.map((r) => r.stageMs), 0.95))}`);
    if (LIVE) console.log(`  model                       median ${ms(Number(header.liveLatencyMedianMs))}, ${header.liveValid}/${header.liveTotal} plans without errors, ${header.liveInputTokens} in / ${header.liveOutputTokens} out tokens (reported by the endpoint)`);
    else console.log("  model                       not measured (no live model: have OPENAI_API_KEY available and pass --live)");
}

async function main() {
    console.log(`Schema Change evaluation: sizes ${SIZES.join(", ")}, ${PER_SIZE} valid + ${NEGATIVE_PER_SIZE} invalid requests each, seed ${SEED}${LIVE ? ", live model" : ", reference plans"}`);
    const all: Row[] = [];
    const failures: string[] = [];
    for (const size of SIZES) {
        const { rows, header, failures: failed } = await evaluate(size);
        report(size, rows, header);
        all.push(...rows);
        failures.push(...failed);
    }

    const valid = all.filter((r) => !r.kase.refusedWith);
    const refused = all.filter((r) => r.kase.refusedWith);
    console.log(`\n=== all sizes: ${all.length} requests (${valid.length} valid, ${refused.length} invalid) ===`);
    console.log(`  every table found ${pct(valid.filter((r) => r.full).length, valid.length)} · plan valid (right tables) ${pct(valid.filter((r) => r.oracleOk).length, valid.length)} · lint ${pct(valid.filter((r) => r.lintOk).length, valid.filter((r) => r.oracleOk).length)} · executed ${pct(valid.filter((r) => r.executed).length, valid.filter((r) => r.oracleOk).length)} · verified ${pct(valid.filter((r) => r.verified).length, valid.filter((r) => r.oracleOk).length)} · invalid refused ${pct(refused.filter((r) => r.refusedRight).length, refused.length)}`);
    if (failures.length > 0) {
        console.log(`\n${failures.length} failure(s) in the checks or the compiler:`);
        for (const failure of failures) console.log(`  ${failure}`);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(2);
});
