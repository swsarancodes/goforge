import type { AiSchemaPlan } from "../ai/schema-plan.js";
import { keyedBackfill, pagedBackfill } from "./backfill.js";
import {
    castKey,
    checkKey,
    defaultKey,
    emptyProbes,
    qualifiedName,
    relationKey,
    splitQualified,
    type ColumnFacts,
    type Dependent,
    type Facts,
    type IndexFacts,
    type ProbeRequest,
    type Probes,
    type TableFacts,
} from "./facts.js";
import {
    DEFAULT_COMPILE_SETTINGS,
    describeSize,
    renderScript,
    riskOf,
    sizeClass,
    type CompileSettings,
    type Finding,
    type FindingSeverity,
    type LockMode,
    type Risk,
    type Runbook,
    type RunbookStep,
    type Work,
} from "./runbook.js";
import { checkDefaultExpression, formatBytes, formatCount, functionsIn, ident, isIntegerType, limitName, literal, qualifiedIdent, renderType } from "./sql-render.js";
import { expectedState } from "./expected-state.js";
import { canRetry, withLockRetry } from "./lock-retry.js";
import { classifyTypeChange, parseType, sameType } from "./type-change.js";

type Operation = AiSchemaPlan["operations"][number];

export interface CompileInput {
    plan: AiSchemaPlan;
    facts: Facts;
    probes: Probes;
    settings?: Partial<CompileSettings>;
}

/** Thrown inside an operation's handler to stop compiling it; the finding explaining why is already recorded. */
class Skip extends Error {}

type Mode = "short" | "long" | "concurrent";

interface StepSpec {
    title: string;
    sql: string;
    mode: Mode;
    lock: LockMode;
    also?: string[];
    work: Work;
    table?: TableFacts;
    notes?: string[];
    destructive?: boolean;
    breaksClients?: boolean;
    optional?: boolean;
    undo?: string;
    /** Overrides the rule-based class (a destructive step is never "low" on a table with data). */
    atLeast?: Risk;
}

const RISK_ORDER: Risk[] = ["low", "medium", "high"];
const lower = (text: string) => text.toLowerCase();

/** The compiler. One instance compiles one plan; `discovery` makes it ask for everything it will need to know about the database instead of failing on it. */
class Compiler {
    private readonly steps: RunbookStep[] = [];
    private readonly findings: Finding[] = [];
    private readonly uncompiled: number[] = [];
    private tables: Map<string, TableFacts>;
    private readonly settings: CompileSettings;
    private readonly needed: ProbeRequest = { types: [], typeChanges: [], functions: [], defaults: [], checks: [], enums: [], relations: [], schemas: [] };
    private current = -1;
    /** Names this plan has claimed so far, so two operations can't both create `orders_status_idx`. */
    private readonly claimedRelations = new Set<string>();
    /** Enum types this plan creates, and the labels they have so far (key: lower-case `schema.name`), so a later operation can use them before they exist. */
    private createdEnums = new Map<string, string[]>();

    constructor(
        private readonly plan: AiSchemaPlan,
        private readonly facts: Facts,
        private readonly probes: Probes,
        private readonly discovery: boolean,
        settings: Partial<CompileSettings> | undefined,
    ) {
        this.settings = { ...DEFAULT_COMPILE_SETTINGS, ...settings };
        this.tables = structuredClone(facts.tables);
    }

    run(): { runbook: Runbook; needed: ProbeRequest } {
        if (this.facts.serverVersionNum > 0 && this.facts.serverVersionNum < 120000) {
            this.findings.push({ severity: "warning", code: "old-server", message: `This server is PostgreSQL ${this.facts.serverVersion}. The steps are written for PostgreSQL 12 or newer (NOT NULL through a validated CHECK, CONCURRENTLY, procedures that commit); on this server some of them may lock for longer than stated.` });
        }

        this.plan.operations.forEach((operation, index) => {
            this.current = index;
            const keepSteps = this.steps.length;
            const keepTables = structuredClone(this.tables);
            const keepClaims = new Set(this.claimedRelations);
            const keepEnums = new Map([...this.createdEnums].map(([key, labels]) => [key, [...labels]]));
            try {
                this.compileOperation(operation, index);
            } catch (error) {
                if (!(error instanceof Skip)) throw error;
                this.steps.length = keepSteps;
                this.tables = keepTables;
                this.claimedRelations.clear();
                keepClaims.forEach((claim) => this.claimedRelations.add(claim));
                this.createdEnums = keepEnums;
                this.uncompiled.push(index);
            }
        });

        const steps = this.steps.map((step, position) => ({ ...step, id: position + 1 }));
        const server = { version: this.facts.serverVersion, collectedAt: this.facts.collectedAt };
        const runbook: Runbook = {
            steps,
            findings: this.findings,
            script: renderScript(steps, server, this.settings),
            uncompiled: this.uncompiled,
            server,
            settings: this.settings,
            expected: expectedState(this.facts.tables, this.tables),
        };
        return { runbook, needed: this.needed };
    }

    // ---- findings and lookups ---------------------------------------------------------------------------------------------

    private note(severity: FindingSeverity, code: string, message: string, table?: string): void {
        this.findings.push({ severity, code, message, operation: this.current, ...(table ? { table } : {}) });
    }

    private fail(code: string, message: string, table?: string): never {
        this.note("error", code, message, table);
        throw new Skip(message);
    }

    private findTable(name: string): TableFacts {
        const { schema, name: bare } = splitQualified(name.trim());
        const all = [...this.tables.values()];
        let found = all.filter((table) => table.name === bare && (schema === undefined || table.schema === schema));
        if (found.length === 0) found = all.filter((table) => lower(table.name) === lower(bare) && (schema === undefined || lower(table.schema) === lower(schema)));
        if (found.length > 1) {
            const inDefault = found.filter((table) => table.schema === this.settings.defaultSchema);
            if (inDefault.length === 1) return inDefault[0];
            this.fail("ambiguous-table", `"${name}" matches ${found.map((table) => table.qualified).join(" and ")}. Use the schema-qualified name.`);
        }
        if (found.length === 0) this.fail("unknown-table", `Table "${name}" is not in the scope that was read from the database.`);
        return found[0];
    }

    private findColumn(table: TableFacts, name: string): ColumnFacts {
        const column = table.columns.find((candidate) => candidate.name === name) ?? table.columns.find((candidate) => lower(candidate.name) === lower(name));
        if (!column) this.fail("unknown-column", `Column "${table.qualified}.${name}" does not exist.`, table.qualified);
        return column;
    }

    private hasColumn(table: TableFacts, name: string): boolean {
        return table.columns.some((candidate) => lower(candidate.name) === lower(name));
    }

    private rekey(table: TableFacts, oldQualified: string): void {
        this.tables.delete(oldQualified);
        this.tables.set(table.qualified, table);
    }

    /** A table counts as having rows when the planner thinks so or when it holds any data pages: an estimate made while the table was empty says 0 long after it was filled. */
    /** `trigger t_note on table t, view public.v`: what PostgreSQL would list, for a message. */
    private describeDependents(dependents: Dependent[]): string {
        return dependents.map((dependent) => dependent.description).join(", ");
    }

    private hasRows(table: TableFacts): boolean {
        return !table.isNew && (table.heapBytes > 0 || (table.estimatedRows ?? 0) > 0);
    }

    // ---- what the database has to say, or the request for it --------------------------------------------------------------

    private type(spec: { dataType: string; maxLength?: number | null; precision?: number | null; scale?: number | null }, label: string): string {
        const text = renderType(spec);
        if (this.createdEnum(text)) return text;
        if (this.discovery) {
            this.needed.types.push(text);
            return text;
        }
        if (!this.probes.types.has(text)) this.fail("type-unverified", `The type "${text}" for ${label} was not checked against the database.`);
        if (this.probes.types.get(text) === undefined) this.fail("unknown-type", `PostgreSQL does not know the type "${text}" (${label}).`);
        return text;
    }

    private checkNameLength(name: string, what: string): void {
        if (Buffer.byteLength(name) > 63) this.fail("name-too-long", `${what} name "${name.slice(0, 40)}…" is ${Buffer.byteLength(name)} bytes; PostgreSQL cuts names at 63, which can make two names the same. Choose a shorter one.`);
    }

    private claimRelation(schema: string, name: string, what: string): void {
        this.checkNameLength(name, what);
        const key = relationKey(schema, name);
        if (this.discovery) {
            this.needed.relations.push({ schema, name });
            this.needed.schemas.push(schema);
            return;
        }
        if (this.claimedRelations.has(key)) this.fail("name-taken", `${what} "${key}" is created twice in this plan.`);
        const inScope = [...this.tables.values()].some((table) => (table.schema === schema && table.name === name) || (table.schema === schema && table.indexes.some((index) => index.name === name)));
        const exists = inScope || this.probes.relationExists.get(key) === true;
        if (exists) this.fail("name-taken", `${what} "${key}" already exists in the database.`);
        if (this.probes.schemaExists.get(schema) === false) this.fail("unknown-schema", `Schema "${schema}" does not exist.`);
        this.claimedRelations.add(key);
    }

    private defaultExpression(expression: string, type: string, label: string): { expression: string; volatile: boolean } {
        const problem = checkDefaultExpression(expression);
        if (problem) this.fail("bad-default", `Default for ${label}: ${problem}`);
        const created = this.createdEnum(type);
        if (created) {
            // the type does not exist yet, so PostgreSQL cannot be asked: the default has to be one of its labels
            const literalLabel = /^'((?:[^']|'')*)'(?:\s*::\s*[A-Za-z_][\w."]*)?$/.exec(expression.trim());
            if (!literalLabel || !created.includes(literalLabel[1].replace(/''/g, "'"))) this.fail("bad-default", `The default for ${label} has to be one of the labels of ${type}: ${created.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ")}.`);
            return { expression, volatile: false };
        }
        const functions = functionsIn(expression);
        if (this.discovery) {
            this.needed.functions.push(...functions);
            this.needed.defaults.push({ expression, type });
            return { expression, volatile: false };
        }
        const rejected = this.probes.defaults.get(defaultKey(expression, type));
        if (!this.probes.defaults.has(defaultKey(expression, type))) this.fail("default-unverified", `The default for ${label} was not checked against the database.`);
        if (rejected) this.fail("bad-default", `PostgreSQL rejects the default ${expression} for ${label}: ${rejected}`);
        const unknown = functions.filter((name) => !this.probes.volatility.get(name));
        if (unknown.length > 0) this.fail("bad-default", `The default for ${label} calls ${unknown.join(", ")}, which PostgreSQL does not have.`);
        return { expression, volatile: functions.some((name) => this.probes.volatility.get(name) === "v") };
    }

    // ---- building steps ---------------------------------------------------------------------------------------------------

    private prelude(mode: Mode): string {
        const lock = mode === "concurrent" ? "0" : `'${this.settings.lockTimeoutSeconds}s'`;
        return mode === "short" ? `SET lock_timeout = ${lock};` : `SET lock_timeout = ${lock};\nSET statement_timeout = 0;`;
    }

    /** A step that takes a strong lock on an existing table retries when the lock is not free, instead of failing on the first wait. */
    private withRetry(spec: StepSpec): string {
        const strong: LockMode[] = ["ACCESS EXCLUSIVE", "SHARE ROW EXCLUSIVE", "SHARE"];
        if (spec.mode === "concurrent" || spec.optional || spec.work === "backfill" || !spec.table || spec.table.isNew) return spec.sql;
        if (!strong.includes(spec.lock) || this.settings.lockAttempts < 2 || !canRetry(spec.sql)) return spec.sql;
        const tables = [spec.table.qualified, ...(spec.also ?? [])].map((name) => {
            const { schema, name: table } = splitQualified(name);
            return schema ? qualifiedIdent(schema, table) : ident(table);
        });
        return withLockRetry(spec.sql, { lockTimeoutSeconds: this.settings.lockTimeoutSeconds, attempts: this.settings.lockAttempts, tables });
    }

    private add(spec: StepSpec): void {
        const size = sizeClass(spec.table);
        let { risk, reason } = riskOf({ lock: spec.lock, work: spec.work, size });
        if (spec.atLeast && RISK_ORDER.indexOf(spec.atLeast) > RISK_ORDER.indexOf(risk) && size !== "new") {
            risk = spec.atLeast;
            reason = spec.destructive ? "The change can't be taken back by running another statement." : reason;
        }
        const sizeNote = describeSize(spec.table);
        this.steps.push({
            id: 0,
            operation: this.current,
            title: spec.title,
            sql: `${this.prelude(spec.mode)}\n${this.withRetry(spec)}`,
            lock: spec.lock,
            alsoLocks: spec.also ?? [],
            work: spec.work,
            risk,
            reason,
            table: spec.table?.qualified ?? null,
            sizeClass: size,
            tableBytes: spec.table && !spec.table.isNew ? spec.table.heapBytes : null,
            tableRows: spec.table && !spec.table.isNew ? spec.table.estimatedRows : null,
            notes: [...(sizeNote ? [sizeNote] : []), ...(spec.notes ?? [])],
            destructive: spec.destructive ?? false,
            breaksClients: spec.breaksClients ?? false,
            optional: spec.optional ?? false,
            ...(spec.undo ? { undo: spec.undo } : {}),
        });
    }

    private names(table: TableFacts): Set<string> {
        return new Set([...table.indexes.map((index) => index.name), ...table.uniques.map((c) => c.name), ...table.checks.map((c) => c.name), ...table.foreignKeys.map((c) => c.name)]);
    }

    // ---- operations -------------------------------------------------------------------------------------------------------

    private compileOperation(operation: Operation, index: number): void {
        switch (operation.type) {
            case "create_table": return this.createTable(operation);
            case "rename_table": return this.renameTable(operation);
            case "drop_table": return this.dropTable(operation);
            case "add_column": return this.addColumn(operation);
            case "alter_column": return this.alterColumn(operation);
            case "drop_column": return this.dropColumn(operation);
            case "add_relationship": return this.addRelationship(operation);
            case "drop_relationship": return this.dropRelationship(operation);
            case "add_index": return this.addIndex(operation);
            case "drop_index": return this.dropIndex(operation);
            case "add_unique": return this.addUnique(operation);
            case "add_check": return this.addCheck(operation);
            case "drop_constraint": return this.dropConstraint(operation);
            case "add_primary_key": return this.addPrimaryKey(operation);
            case "create_enum": return this.createEnum(operation);
            case "add_enum_value": return this.addEnumValue(operation);
            default:
                this.fail("unsupported-operation", `Operation ${index + 1} has a type this compiler does not know.`);
        }
    }

    private newTableFacts(schema: string, name: string): TableFacts {
        return {
            schema, name, qualified: qualifiedName(schema, name), partitioned: false, partitionCount: 0, partitions: [], nestedPartitions: false,
            estimatedRows: 0, heapBytes: 0, indexBytes: 0, totalBytes: 0, columns: [], primaryKey: [], uniques: [], checks: [], foreignKeys: [], referencedBy: [],
            indexes: [], dependentViews: [], dependents: [], userTriggers: 0, rowSecurity: false, privileges: [], stats: null, isNew: true,
        };
    }

    private createTable(operation: Extract<Operation, { type: "create_table" }>): void {
        const parts = splitQualified(operation.table.name.trim());
        const schema = parts.schema ?? this.settings.defaultSchema;
        const name = parts.name;
        const qualified = qualifiedName(schema, name);
        if (this.tables.has(qualified) || [...this.tables.values()].some((t) => lower(t.qualified) === lower(qualified))) this.fail("table-exists", `Table "${qualified}" already exists.`, qualified);
        this.claimRelation(schema, name, "Table");

        const table = this.newTableFacts(schema, name);
        const lines: string[] = [];
        const primary: string[] = [];
        const seen = new Set<string>();
        const taken = new Set<string>([name]);

        for (const field of operation.table.fields) {
            if (seen.has(lower(field.name))) this.fail("column-exists", `Column "${field.name}" appears twice in ${qualified}.`, qualified);
            seen.add(lower(field.name));
            const type = this.type(field, `${qualified}.${field.name}`);
            const notNull = field.primaryKey === true || field.nullable === false;
            let line = `${ident(field.name)} ${type}`;
            let generated: ColumnFacts["generated"] = null;
            if (field.autoIncrement) {
                if (!isIntegerType(type)) this.fail("bad-identity", `${qualified}.${field.name} is auto-increment but its type is ${type}; use smallint, integer or bigint.`, qualified);
                line += " GENERATED BY DEFAULT AS IDENTITY";
                generated = "default-identity";
            }
            if (notNull) line += " NOT NULL";
            let defaultText: string | null = null;
            if (field.defaultValue !== undefined && field.defaultValue !== null) {
                if (field.autoIncrement) this.fail("bad-default", `${qualified}.${field.name} cannot be both auto-increment and have a default.`, qualified);
                defaultText = this.defaultExpression(field.defaultValue, type, `${qualified}.${field.name}`).expression;
                line += ` DEFAULT ${defaultText}`;
            }
            if (field.primaryKey) primary.push(field.name);
            lines.push(line);
            table.columns.push({ name: field.name, type, typeSchema: "pg_catalog", notNull, default: defaultText, generated, dependents: [], nullFraction: null, distinct: null });
        }
        if (primary.length > 0) {
            const pk = limitName(`${name}_pkey`, taken);
            taken.add(pk);
            lines.push(`CONSTRAINT ${ident(pk)} PRIMARY KEY (${primary.map(ident).join(", ")})`);
            table.primaryKey = primary;
            table.indexes.push({ name: pk, definition: "", columns: primary, uses: primary, method: "btree", unique: true, primary: true, valid: true, partial: false, constraint: pk, bytes: 0, scans: null });
        }
        for (const field of operation.table.fields) {
            if (field.unique && !field.primaryKey) {
                const unique = limitName(`${name}_${field.name}_key`, taken);
                taken.add(unique);
                lines.push(`CONSTRAINT ${ident(unique)} UNIQUE (${ident(field.name)})`);
                table.uniques.push({ name: unique, kind: "unique", definition: `UNIQUE (${ident(field.name)})`, columns: [field.name], validated: true });
                table.indexes.push({ name: unique, definition: "", columns: [field.name], uses: [field.name], method: "btree", unique: true, primary: false, valid: true, partial: false, constraint: unique, bytes: 0, scans: null });
            }
            if (field.values && field.values.length > 0) this.note("warning", "values-ignored", `"values" for ${qualified}.${field.name} was ignored: create the enum with create_enum (or a CHECK constraint) and give the column its type.`, qualified);
            if (field.unsigned) this.note("warning", "unsigned-ignored", `PostgreSQL has no unsigned types; "unsigned" for ${qualified}.${field.name} was ignored.`, qualified);
        }

        const statements = [`CREATE TABLE ${qualifiedIdent(schema, name)} (\n  ${lines.join(",\n  ")}\n);`];
        for (const spec of operation.table.indexes ?? []) {
            for (const column of spec.columns) if (!seen.has(lower(column))) this.fail("unknown-column", `Index ${spec.name} uses column "${column}", which ${qualified} does not have.`, qualified);
            this.claimRelation(schema, spec.name, "Index");
            statements.push(`CREATE INDEX ${ident(spec.name)} ON ${qualifiedIdent(schema, name)} (${spec.columns.map(ident).join(", ")});`.replace("CREATE INDEX", spec.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX"));
            table.indexes.push({ name: spec.name, definition: "", columns: spec.columns, uses: spec.columns, method: "btree", unique: spec.unique ?? false, primary: false, valid: true, partial: false, constraint: null, bytes: 0, scans: null });
        }

        this.add({
            title: `Create table ${qualified}`,
            sql: statements.join("\n"),
            mode: "short",
            lock: "none",
            work: "none",
            table,
            notes: ["A new table: nothing else uses it yet, so none of the online-safety steps are needed."],
            undo: `DROP TABLE ${qualifiedIdent(schema, name)};`,
        });
        this.tables.set(qualified, table);
    }

    private renameTable(operation: Extract<Operation, { type: "rename_table" }>): void {
        const table = this.findTable(operation.tableName);
        const newName = operation.newName.trim();
        const target = qualifiedName(table.schema, newName);
        this.claimRelation(table.schema, newName, "Table");
        const oldQualified = table.qualified;
        const oldName = table.name;
        const from = qualifiedIdent(table.schema, oldName);
        const to = qualifiedIdent(table.schema, newName);
        const keepOldName = this.settings.compatViews && !table.isNew;

        if (!keepOldName) {
            this.add({
                title: `Rename table ${oldQualified} to ${newName}`,
                sql: `ALTER TABLE ${from} RENAME TO ${ident(newName)};`,
                mode: "short",
                lock: "ACCESS EXCLUSIVE",
                work: "metadata",
                table,
                breaksClients: !table.isNew,
                notes: [
                    ...(table.isNew ? [] : ["The old name stops working immediately. Queries, functions and application code that use it will fail until they are changed."]),
                    "Views, foreign keys and indexes follow the table. Index and constraint names keep their old text.",
                    ...(table.dependentViews.length ? [`Views that use it: ${table.dependentViews.join(", ")}.`] : []),
                ],
                undo: `ALTER TABLE ${to} RENAME TO ${ident(oldName)};`,
            });
        } else {
            // The old name stays usable as a view over the renamed table, in the same transaction as the rename, so no query ever sees it missing.
            const invoker = this.facts.serverVersionNum >= 150000;
            if (table.rowSecurity && !invoker) {
                this.fail("unsupported", `${oldQualified} has row-level security. Before PostgreSQL 15 a view over it would run as its owner, who is not held to the policies, so a compatibility view under the old name would let applications around them. Rename it directly by turning compatibility views off (compatViews: false), or move to PostgreSQL 15 or later.`, table.qualified);
            }
            const skipped = new Set<string>();
            const grants = table.privileges
                .filter((privilege) => !privilege.owner)
                .filter((privilege) => {
                    const copied = ["SELECT", "INSERT", "UPDATE", "DELETE"].includes(privilege.privilege);
                    if (!copied) skipped.add(privilege.privilege);
                    return copied;
                });
            const byGrantee = new Map<string, { privileges: string[]; grantable: string[] }>();
            for (const grant of grants) {
                const entry = byGrantee.get(grant.grantee) ?? { privileges: [], grantable: [] };
                entry.privileges.push(grant.privilege);
                if (grant.grantable) entry.grantable.push(grant.privilege);
                byGrantee.set(grant.grantee, entry);
            }
            const grantSql: string[] = [];
            for (const [grantee, entry] of byGrantee) {
                const who = grantee === "PUBLIC" ? "PUBLIC" : ident(grantee);
                const plain = entry.privileges.filter((privilege) => !entry.grantable.includes(privilege));
                if (plain.length) grantSql.push(`GRANT ${plain.join(", ")} ON ${from} TO ${who};`);
                if (entry.grantable.length) grantSql.push(`GRANT ${entry.grantable.join(", ")} ON ${from} TO ${who} WITH GRANT OPTION;`);
            }
            this.add({
                title: `Rename table ${oldQualified} to ${newName}, and keep ${oldName} working as a view`,
                sql: [`ALTER TABLE ${from} RENAME TO ${ident(newName)};`, `CREATE VIEW ${from}${invoker ? " WITH (security_invoker = true)" : ""} AS SELECT * FROM ${to};`, ...grantSql].join("\n"),
                mode: "short",
                lock: "ACCESS EXCLUSIVE",
                work: "metadata",
                table,
                notes: [
                    `One transaction: ${newName} is the table and ${oldName} is a view over it, so applications using the old name keep working until they have switched.`,
                    `Through the view, SELECT, INSERT, UPDATE and DELETE work (a view that is just SELECT * is updatable, and the table's defaults still apply to INSERT). ALTER TABLE, TRUNCATE, COPY, LOCK and the like do not work on a view, and the view lists the columns the table has now: columns added later are not in it.`,
                    ...(grantSql.length ? [`The table's SELECT, INSERT, UPDATE and DELETE grants are copied onto the view (${[...byGrantee.keys()].join(", ")}).`] : ["The table has no grants other than its owner's, so none are copied."]),
                    ...(skipped.size ? [`Grants of ${[...skipped].join(", ")} are not copied (a view cannot hold them), and column-level grants are not copied either.`] : ["Column-level grants, if there are any, are not copied."]),
                    ...(invoker ? ["The view runs with the caller's own rights on the table (security_invoker), so row-level security and privileges apply as before."] : []),
                    "Index and constraint names keep their old text. Views, foreign keys and indexes follow the table.",
                    ...(table.dependentViews.length ? [`Views that use it: ${table.dependentViews.join(", ")}.`] : []),
                    `Until the view is dropped, a column of ${newName} that the view lists cannot be dropped or have its type changed: drop the view first.`,
                ],
                undo: `DROP VIEW ${from};\nALTER TABLE ${to} RENAME TO ${ident(oldName)};`,
            });
            this.add({
                title: `Contract: drop the old name ${oldQualified}, the compatibility view`,
                sql: `DROP VIEW ${from};`,
                mode: "short",
                lock: "ACCESS EXCLUSIVE",
                work: "metadata",
                table,
                optional: true,
                breaksClients: true,
                notes: ["Run this later, once nothing uses the old name any more. Anything that still does will fail from then on."],
                undo: `CREATE VIEW ${from}${invoker ? " WITH (security_invoker = true)" : ""} AS SELECT * FROM ${to};`,
            });
        }

        table.name = newName;
        table.qualified = target;
        this.rekey(table, oldQualified);
        for (const other of this.tables.values()) {
            for (const fk of other.foreignKeys) if (fk.refSchema === table.schema && fk.refTable === splitQualified(oldQualified).name) fk.refTable = newName;
            for (const inbound of other.referencedBy) if (inbound.schema === table.schema && inbound.table === splitQualified(oldQualified).name) inbound.table = newName;
        }
        if (keepOldName) {
            // the view now depends on every column it lists, and later steps in the plan have to know
            table.dependentViews.push(oldQualified);
            this.claimedRelations.add(relationKey(table.schema, oldName));
            for (const column of table.columns) column.dependents.push({ kind: "view", description: `view ${oldQualified}`, blocks: true, external: true });
        }
    }

    private dropTable(operation: Extract<Operation, { type: "drop_table" }>): void {
        const table = this.findTable(operation.tableName);
        const blockers = table.referencedBy.filter((fk) => qualifiedName(fk.schema, fk.table) !== table.qualified);
        if (blockers.length > 0) {
            this.fail("referenced", `${table.qualified} is referenced by ${blockers.map((fk) => `${fk.schema}.${fk.table} (${fk.name})`).join(", ")}. Drop those foreign keys first; the compiler never uses CASCADE.`, table.qualified);
        }
        if (table.dependentViews.length > 0) this.fail("dependent-views", `Views depend on ${table.qualified}: ${table.dependentViews.join(", ")}. Drop or change them first.`, table.qualified);
        const elsewhere = table.dependents.filter((dependent) => dependent.blocks && dependent.kind !== "view");
        if (elsewhere.length > 0) this.fail("dependents", `${table.qualified} is used by ${this.describeDependents(elsewhere)}. PostgreSQL refuses to drop it while they exist, and the compiler never uses CASCADE. Drop or change them first.`, table.qualified);

        const holdsData = this.hasRows(table) || table.heapBytes > 0;
        this.add({
            title: `Drop table ${table.qualified}`,
            sql: `DROP TABLE ${qualifiedIdent(table.schema, table.name)};`,
            mode: "short",
            lock: "ACCESS EXCLUSIVE",
            work: "metadata",
            table,
            destructive: true,
            breaksClients: true,
            atLeast: holdsData ? "high" : "low",
            notes: [
                "The data and the table's indexes are deleted and cannot be brought back without a backup.",
                "A softer way: rename the table to something like old_<name>, wait until nothing fails, then drop it.",
                ...(table.partitioned ? [`Its ${table.partitionCount} partitions are dropped with it.`] : []),
            ],
        });
        this.tables.delete(table.qualified);
        for (const other of this.tables.values()) {
            other.referencedBy = other.referencedBy.filter((fk) => qualifiedName(fk.schema, fk.table) !== table.qualified);
            other.foreignKeys = other.foreignKeys.filter((fk) => qualifiedName(fk.refSchema, fk.refTable) !== table.qualified);
        }
    }

    // ---- columns ----------------------------------------------------------------------------------------------------------

    private addColumn(operation: Extract<Operation, { type: "add_column" }>): void {
        const table = this.findTable(operation.tableName);
        const spec = operation.field;
        if (this.hasColumn(table, spec.name)) this.fail("column-exists", `Column "${table.qualified}.${spec.name}" already exists.`, table.qualified);
        this.checkNameLength(spec.name, "Column");
        if (spec.primaryKey) this.fail("unsupported", `Adding ${table.qualified}.${spec.name} as a primary key to an existing table is not compiled. Add the column, fill it, then add the key in a separate change.`, table.qualified);

        const label = `${table.qualified}.${spec.name}`;
        const type = this.type(spec, label);
        const identity = spec.autoIncrement === true;
        if (identity && !isIntegerType(type)) this.fail("bad-identity", `${label} is auto-increment but its type is ${type}.`, table.qualified);
        const withDefault = spec.defaultValue !== undefined && spec.defaultValue !== null;
        if (identity && withDefault) this.fail("bad-default", `${label} cannot be both auto-increment and have a default.`, table.qualified);
        const nullable = spec.nullable ?? true;
        const rows = this.hasRows(table);
        const size = sizeClass(table);
        const def = withDefault ? this.defaultExpression(spec.defaultValue as string, type, label) : undefined;

        if (!nullable && !withDefault && !identity && rows) {
            this.fail("not-null-needs-default", `${label} is NOT NULL with no default, and ${table.qualified} has rows (${table.estimatedRows === null ? "size unknown" : `about ${formatCount(table.estimatedRows)}`}): PostgreSQL would reject it. Give it a default, or add it as nullable, fill it, then make it NOT NULL.`, table.qualified);
        }
        if (spec.unique && withDefault && rows) this.fail("unique-with-default", `${label} is unique and has a default, so every existing row would get the same value.`, table.qualified);
        if (spec.values?.length) this.note("warning", "values-ignored", `"values" for ${label} was ignored: create the enum with create_enum (or a CHECK constraint) and give the column its type.`, table.qualified);
        if (spec.unsigned) this.note("warning", "unsigned-ignored", `PostgreSQL has no unsigned types; "unsigned" for ${label} was ignored.`, table.qualified);
        if (table.partitioned && spec.unique) this.fail("unsupported", `A unique column on the partitioned table ${table.qualified} is not compiled: the key must include the partition key.`, table.qualified);

        const column = ident(spec.name);
        const target = qualifiedIdent(table.schema, table.name);
        const undo = `ALTER TABLE ${target} DROP COLUMN ${column};`;
        const volatile = def?.volatile === true;
        const newColumn: ColumnFacts = { name: spec.name, type, typeSchema: "pg_catalog", notNull: !nullable, default: def?.expression ?? null, generated: identity ? "default-identity" : null, dependents: [], nullFraction: rows ? null : 0, distinct: null };

        if (identity && rows) {
            this.add({
                title: `Add column ${label} (identity)`,
                sql: `ALTER TABLE ${target} ADD COLUMN ${column} ${type} GENERATED BY DEFAULT AS IDENTITY;`,
                mode: "long",
                lock: "ACCESS EXCLUSIVE",
                work: "rewrite",
                table,
                notes: ["An identity column needs a different value for every existing row, so PostgreSQL rewrites the whole table under ACCESS EXCLUSIVE."],
                undo,
            });
            if (size !== "small") this.note("warning", "rewrite", `Adding the identity column ${label} rewrites ${table.qualified}. On a table this size, add a plain nullable column, fill it in batches and attach a default instead.`, table.qualified);
        } else if (volatile && rows && size !== "small") {
            // The expand path: nothing is rewritten, existing rows are filled in batches.
            this.add({ title: `Add column ${label} (nullable, no default yet)`, sql: `ALTER TABLE ${target} ADD COLUMN ${column} ${type};`, mode: "short", lock: "ACCESS EXCLUSIVE", work: "metadata", table, undo });
            this.add({ title: `Set the default of ${label}`, sql: `ALTER TABLE ${target} ALTER COLUMN ${column} SET DEFAULT ${def?.expression};`, mode: "short", lock: "ACCESS EXCLUSIVE", work: "metadata", table, notes: ["New rows get the default from now on; existing rows are filled in the next step."] });
            this.backfillStep(table, `Fill ${label} for the existing rows`, `${column} = ${def?.expression}`, `${column} IS NULL`);
            if (!nullable) this.notNullSteps(table, spec.name, { skipUpdate: true });
        } else {
            this.add({
                title: `Add column ${label}`,
                sql: `ALTER TABLE ${target} ADD COLUMN ${column} ${type}${identity ? " GENERATED BY DEFAULT AS IDENTITY" : ""}${!nullable ? " NOT NULL" : ""}${def ? ` DEFAULT ${def.expression}` : ""};`,
                mode: "short",
                lock: "ACCESS EXCLUSIVE",
                work: volatile && rows ? "rewrite" : "metadata",
                table,
                notes: [volatile && rows ? "The default is volatile, so PostgreSQL computes it per row and rewrites the table (small here)." : "From PostgreSQL 11 a constant default is stored in the catalog: existing rows are not rewritten."],
                undo,
            });
        }

        table.columns.push(newColumn);
        if (spec.unique) this.uniqueSteps(table, [spec.name]);
    }

    /** NOT NULL on a column of an existing table, in the order that never holds a long lock. */
    private notNullSteps(table: TableFacts, columnName: string, options: { skipUpdate?: boolean } = {}): void {
        const column = ident(columnName);
        const target = qualifiedIdent(table.schema, table.name);
        const size = sizeClass(table);
        const label = `${table.qualified}.${columnName}`;
        if (size === "new" || size === "small" || !this.hasRows(table)) {
            this.add({
                title: `Make ${label} NOT NULL`,
                sql: `ALTER TABLE ${target} ALTER COLUMN ${column} SET NOT NULL;`,
                mode: "long",
                lock: "ACCESS EXCLUSIVE",
                work: this.hasRows(table) ? "scan" : "metadata",
                table,
                notes: ["Fails if any row has NULL here; the table is small, so a direct SET NOT NULL is fine."],
                undo: `ALTER TABLE ${target} ALTER COLUMN ${column} DROP NOT NULL;`,
            });
            return;
        }
        const check = limitName(`${table.name}_${columnName}_not_null`, this.names(table));
        this.add({
            title: `Add a NOT VALID check that ${label} is not null`,
            sql: `ALTER TABLE ${target} ADD CONSTRAINT ${ident(check)} CHECK (${column} IS NOT NULL) NOT VALID;`,
            mode: "short",
            lock: "ACCESS EXCLUSIVE",
            work: "metadata",
            table,
            notes: ["NOT VALID adds the rule for new and changed rows without reading the existing ones."],
            undo: `ALTER TABLE ${target} DROP CONSTRAINT ${ident(check)};`,
        });
        this.add({
            title: `Validate that no row of ${label} is null`,
            sql: `ALTER TABLE ${target} VALIDATE CONSTRAINT ${ident(check)};`,
            mode: "long",
            lock: "SHARE UPDATE EXCLUSIVE",
            work: "scan",
            table,
            notes: [
                "Reads the whole table but does not block reads or writes.",
                `If it fails there are NULLs left. Find them with: SELECT * FROM ${target} WHERE ${column} IS NULL LIMIT 10;${options.skipUpdate ? "" : " Fill them (in batches), then run this step again."}`,
            ],
        });
        this.add({
            title: `Set ${label} NOT NULL`,
            sql: `ALTER TABLE ${target} ALTER COLUMN ${column} SET NOT NULL;`,
            mode: "short",
            lock: "ACCESS EXCLUSIVE",
            work: "metadata",
            table,
            notes: ["From PostgreSQL 12 the validated CHECK proves there are no NULLs, so this does not read the table again."],
            undo: `ALTER TABLE ${target} ALTER COLUMN ${column} DROP NOT NULL;`,
        });
        this.add({
            title: `Drop the helper check on ${label}`,
            sql: `ALTER TABLE ${target} DROP CONSTRAINT ${ident(check)};`,
            mode: "short",
            lock: "ACCESS EXCLUSIVE",
            work: "metadata",
            table,
        });
    }

    /** UPDATE ... in committed batches, keyed on the primary key (or a unique not-null column), or by page on PostgreSQL 14+. */
    private backfillStep(table: TableFacts, title: string, assignments: string, needsUpdate: string, extra: { optional?: boolean } = {}): void {
        const target = qualifiedIdent(table.schema, table.name);
        const key = this.batchKey(table);
        let sql: string;
        let how: string;
        if (key) {
            sql = keyedBackfill({ table: target, key: ident(key), assignments, needsUpdate, batchRows: this.settings.backfillBatchRows, pauseMs: this.settings.backfillPauseMs });
            how = `in batches of ${formatCount(this.settings.backfillBatchRows)} rows by ${key}`;
        } else if (this.facts.serverVersionNum >= 140000 && !table.partitioned) {
            const pages = Math.max(1, Math.round(table.heapBytes / 8192));
            const rowsPerPage = table.estimatedRows && pages > 0 ? Math.max(1, table.estimatedRows / pages) : 50;
            const pagesPerBatch = Math.max(1, Math.round(this.settings.backfillBatchRows / rowsPerPage));
            sql = pagedBackfill({ table: target, assignments, needsUpdate, pagesPerBatch, pauseMs: this.settings.backfillPauseMs });
            how = `${formatCount(pagesPerBatch)} pages per batch (the table has no usable key)`;
        } else {
            this.fail("unsupported", `${table.qualified} has no primary key or unique NOT NULL column to batch on${table.partitioned ? " and is partitioned" : ", and this server is older than PostgreSQL 14"}, so the backfill is not compiled.`, table.qualified);
        }
        this.add({
            title,
            sql,
            mode: "long",
            lock: "ROW EXCLUSIVE",
            work: "backfill",
            table,
            optional: extra.optional,
            notes: [
                `Runs ${how}, committing after each batch and pausing ${this.settings.backfillPauseMs} ms between batches.`,
                "Safe to stop and run again: rows that are already done are skipped. Needs the SQL Editor's no-transaction mode.",
                "Watch replica lag and autovacuum while it runs; change the batch size in the script if needed.",
            ],
        });
    }

    private batchKey(table: TableFacts): string | undefined {
        if (table.primaryKey.length === 1) return table.primaryKey[0];
        const unique = table.indexes.find((index) => index.unique && index.valid && !index.partial && index.columns.length === 1 && index.columns[0] !== null && table.columns.find((column) => column.name === index.columns[0])?.notNull);
        return unique?.columns[0] ?? undefined;
    }

    /** UNIQUE on columns of an existing table: the index is built without blocking writes, then attached as a constraint. */
    private uniqueSteps(table: TableFacts, columns: string[], given?: string): void {
        const target = qualifiedIdent(table.schema, table.name);
        const name = given ?? limitName(`${table.name}_${columns.join("_")}_key`, this.names(table));
        this.claimRelation(table.schema, name, "Index");
        const list = columns.map(ident).join(", ");
        const size = sizeClass(table);
        if (size === "new") {
            this.add({ title: `Make ${table.qualified}(${columns.join(", ")}) unique`, sql: `ALTER TABLE ${target} ADD CONSTRAINT ${ident(name)} UNIQUE (${list});`, mode: "short", lock: "ACCESS EXCLUSIVE", work: "none", table });
        } else {
            this.concurrentIndexStep(table, name, columns, true, `Build a unique index on ${table.qualified}(${columns.join(", ")})`);
            this.add({
                title: `Attach the index as a unique constraint on ${table.qualified}(${columns.join(", ")})`,
                sql: `ALTER TABLE ${target} ADD CONSTRAINT ${ident(name)} UNIQUE USING INDEX ${ident(name)};`,
                mode: "short",
                lock: "ACCESS EXCLUSIVE",
                work: "metadata",
                table,
                undo: `ALTER TABLE ${target} DROP CONSTRAINT ${ident(name)};`,
            });
        }
        table.uniques.push({ name, kind: "unique", definition: `UNIQUE (${list})`, columns, validated: true });
        table.indexes.push({ name, definition: "", columns, uses: columns, method: "btree", unique: true, primary: false, valid: true, partial: false, constraint: name, bytes: 0, scans: null });
    }

    /** CREATE INDEX CONCURRENTLY, with the check for the invalid index a failed build leaves behind. */
    private concurrentIndexStep(table: TableFacts, name: string, columns: string[], unique: boolean, title: string): void {
        const target = qualifiedIdent(table.schema, table.name);
        const list = columns.map(ident).join(", ");
        const invalid = `SELECT indexrelid::regclass AS invalid_index FROM pg_index WHERE indrelid = ${literal(target)}::regclass AND NOT indisvalid;`;

        if (table.partitioned) {
            if (table.nestedPartitions) this.fail("unsupported", `${table.qualified} has partitions that are partitioned themselves; indexes on it are not compiled.`, table.qualified);
            if (table.partitions.length < table.partitionCount) this.fail("unsupported", `${table.qualified} has ${table.partitionCount} partitions, more than the ${table.partitions.length} that were read.`, table.qualified);
            const statements = [`CREATE ${unique ? "UNIQUE " : ""}INDEX ${ident(name)} ON ONLY ${target} (${list});`];
            const children = table.partitions.map((partition) => ({ partition, index: limitName(`${splitQualified(partition).name}_${columns.join("_")}_idx`, new Set([name])) }));
            for (const child of children) {
                const { schema, name: partitionName } = splitQualified(child.partition);
                statements.push(`CREATE ${unique ? "UNIQUE " : ""}INDEX CONCURRENTLY ${ident(child.index)} ON ${qualifiedIdent(schema ?? table.schema, partitionName)} (${list});`);
                statements.push(`ALTER INDEX ${qualifiedIdent(table.schema, name)} ATTACH PARTITION ${qualifiedIdent(schema ?? table.schema, child.index)};`);
            }
            this.add({
                title,
                sql: statements.join("\n"),
                mode: "concurrent",
                lock: "SHARE UPDATE EXCLUSIVE",
                work: "index-build",
                table,
                notes: [
                    "CREATE INDEX CONCURRENTLY is not allowed on a partitioned table, so the parent index is created first (ON ONLY, no data), each partition's index is built without blocking writes, and each is attached.",
                    `${children.length} partitions. The parent index becomes valid when the last one is attached.`,
                ],
                undo: `DROP INDEX ${qualifiedIdent(table.schema, name)};`,
            });
            return;
        }

        const isNew = sizeClass(table) === "new";
        this.add({
            title,
            sql: isNew
                ? `CREATE ${unique ? "UNIQUE " : ""}INDEX ${ident(name)} ON ${target} (${list});`
                : `CREATE ${unique ? "UNIQUE " : ""}INDEX CONCURRENTLY ${ident(name)} ON ${target} (${list});\n${invalid}`,
            mode: isNew ? "short" : "concurrent",
            lock: isNew ? "SHARE" : "SHARE UPDATE EXCLUSIVE",
            work: isNew ? "none" : "index-build",
            table,
            notes: isNew
                ? []
                : [
                      "Does not block reads or writes. Reads the table twice and waits for transactions that started before it, so it can take a while on a busy table.",
                      "Needs the SQL Editor's no-transaction mode. If it fails or is cancelled it leaves an INVALID index: the query after it lists any; drop it with DROP INDEX CONCURRENTLY and run the step again.",
                      ...(unique ? ["A unique index fails if the table already has duplicates."] : []),
                  ],
            undo: isNew ? undefined : `DROP INDEX CONCURRENTLY ${qualifiedIdent(table.schema, name)};`,
        });
    }

    private alterColumn(operation: Extract<Operation, { type: "alter_column" }>): void {
        const table = this.findTable(operation.tableName);
        const column = this.findColumn(table, operation.columnName);
        const changes = operation.changes;
        const label = `${table.qualified}.${column.name}`;
        const target = qualifiedIdent(table.schema, table.name);
        const ref = ident(column.name);

        if (changes.primaryKey !== undefined) this.fail("unsupported", `Changing whether ${label} is part of the primary key is not compiled; the key and every foreign key that points at it have to change together.`, table.qualified);
        if (changes.autoIncrement === true && column.generated === "stored") this.fail("generated-column", `${label} is a generated column and cannot also be an identity column.`, table.qualified);

        const wantsType = changes.dataType !== undefined || changes.maxLength !== undefined || changes.precision !== undefined || changes.scale !== undefined;
        let changed = false;

        if (wantsType) {
            const base = changes.dataType ?? parseType(column.type).base;
            const to = renderType({ dataType: base, maxLength: changes.maxLength, precision: changes.precision, scale: changes.scale });
            const target2 = this.type({ dataType: to }, label);
            if (sameType(column.type, target2)) this.note("info", "no-change", `${label} already has the type ${column.type}.`, table.qualified);
            else {
                this.typeChange(table, column, target2);
                changed = true;
            }
        }

        if (changes.nullable === false && !column.notNull) {
            if (column.nullFraction !== null && column.nullFraction > 0) this.note("warning", "has-nulls", `${label} has NULLs according to the table statistics (about ${(column.nullFraction * 100).toFixed(1)}% of rows). The validation step will fail until they are filled.`, table.qualified);
            this.notNullSteps(table, column.name);
            column.notNull = true;
            changed = true;
        } else if (changes.nullable === true && column.notNull) {
            if (table.primaryKey.includes(column.name)) this.fail("primary-key-column", `${label} is part of the primary key and cannot become nullable.`, table.qualified);
            this.add({ title: `Allow NULL in ${label}`, sql: `ALTER TABLE ${target} ALTER COLUMN ${ref} DROP NOT NULL;`, mode: "short", lock: "ACCESS EXCLUSIVE", work: "metadata", table, undo: `ALTER TABLE ${target} ALTER COLUMN ${ref} SET NOT NULL;` });
            column.notNull = false;
            changed = true;
        }

        if (changes.defaultValue !== undefined) {
            if (changes.defaultValue === null) {
                this.add({ title: `Remove the default of ${label}`, sql: `ALTER TABLE ${target} ALTER COLUMN ${ref} DROP DEFAULT;`, mode: "short", lock: "ACCESS EXCLUSIVE", work: "metadata", table, undo: column.default ? `ALTER TABLE ${target} ALTER COLUMN ${ref} SET DEFAULT ${column.default};` : undefined });
                column.default = null;
            } else {
                const def = this.defaultExpression(changes.defaultValue, column.type, label);
                this.add({
                    title: `Set the default of ${label}`,
                    sql: `ALTER TABLE ${target} ALTER COLUMN ${ref} SET DEFAULT ${def.expression};`,
                    mode: "short",
                    lock: "ACCESS EXCLUSIVE",
                    work: "metadata",
                    table,
                    notes: ["Only rows inserted from now on get the default; existing rows keep their value."],
                    undo: column.default ? `ALTER TABLE ${target} ALTER COLUMN ${ref} SET DEFAULT ${column.default};` : `ALTER TABLE ${target} ALTER COLUMN ${ref} DROP DEFAULT;`,
                });
                column.default = def.expression;
            }
            changed = true;
        }

        if (changes.autoIncrement === true && column.generated === null) {
            this.identitySteps(table, column);
            changed = true;
        } else if (changes.autoIncrement === true) {
            this.note("info", "no-change", `${label} is already an identity column.`, table.qualified);
        }

        if (changes.autoIncrement === false && column.generated !== null) {
            this.add({ title: `Remove the identity from ${label}`, sql: `ALTER TABLE ${target} ALTER COLUMN ${ref} DROP IDENTITY;`, mode: "short", lock: "ACCESS EXCLUSIVE", work: "metadata", table });
            column.generated = null;
            changed = true;
        }

        if (changes.unique === true) {
            const covered = table.uniques.some((unique) => unique.columns.length === 1 && lower(unique.columns[0]) === lower(column.name)) || (table.primaryKey.length === 1 && lower(table.primaryKey[0]) === lower(column.name));
            if (covered) this.note("info", "no-change", `${label} is already unique.`, table.qualified);
            else {
                this.uniqueSteps(table, [column.name]);
                changed = true;
            }
        } else if (changes.unique === false) {
            const constraint = table.uniques.find((unique) => unique.kind === "unique" && unique.columns.length === 1 && lower(unique.columns[0]) === lower(column.name));
            if (!constraint) this.fail("no-unique-constraint", `${label} has no single-column unique constraint to drop.`, table.qualified);
            this.add({
                title: `Drop the unique constraint ${constraint.name} on ${label}`,
                sql: `ALTER TABLE ${target} DROP CONSTRAINT ${ident(constraint.name)};`,
                mode: "short",
                lock: "ACCESS EXCLUSIVE",
                work: "metadata",
                table,
                notes: ["Its index is dropped with it. Rows that now violate uniqueness can be inserted immediately."],
            });
            table.uniques = table.uniques.filter((unique) => unique !== constraint);
            table.indexes = table.indexes.filter((index) => index.name !== constraint.name);
            changed = true;
        }

        if (changes.newName !== undefined && changes.newName !== column.name) {
            if (this.hasColumn(table, changes.newName)) this.fail("column-exists", `Column "${table.qualified}.${changes.newName}" already exists.`, table.qualified);
            this.add({
                title: `Rename ${label} to ${changes.newName}`,
                sql: `ALTER TABLE ${target} RENAME COLUMN ${ref} TO ${ident(changes.newName)};`,
                mode: "short",
                lock: "ACCESS EXCLUSIVE",
                work: "metadata",
                table,
                breaksClients: true,
                notes: ["The old name stops working immediately. Queries, functions and application code that use it will fail until they are changed.", "Indexes, constraints and views follow the column."],
                undo: `ALTER TABLE ${target} RENAME COLUMN ${ident(changes.newName)} TO ${ref};`,
            });
            for (const index of table.indexes) {
                index.columns = index.columns.map((name) => (name === column.name ? changes.newName ?? name : name));
                index.uses = index.uses.map((name) => (name === column.name ? changes.newName ?? name : name));
            }
            table.primaryKey = table.primaryKey.map((name) => (name === column.name ? changes.newName ?? name : name));
            column.name = changes.newName;
            changed = true;
        }

        if (!changed && !this.findings.some((finding) => finding.operation === this.current)) {
            this.note("info", "no-change", `Nothing to change on ${label}.`, table.qualified);
        }
    }

    /**
     * An existing column becomes `GENERATED BY DEFAULT AS IDENTITY`, with its sequence started after the largest value it holds. Both happen in one
     * transaction, so no insert can be handed a number that is already taken. The largest value is read through an index on the column: without one it
     * would be a scan of the table under the lock, so a table that is not small needs one first.
     */
    private identitySteps(table: TableFacts, column: ColumnFacts): void {
        const label = `${table.qualified}.${column.name}`;
        if (!isIntegerType(column.type)) this.fail("unsupported", `${label} is ${column.type}; an identity column has to be smallint, integer or bigint.`, table.qualified);
        if (!column.notNull) this.fail("not-null-required", `${label} allows NULL. An identity column has to be NOT NULL: make it NOT NULL in the same change (nullable: false), or first.`, table.qualified);
        if (column.default !== null) this.fail("has-default", `${label} has a default (${column.default}), and an identity column cannot have one. Remove it in the same change (defaultValue: null). If it is a serial column, its old sequence stays, owned by the column, and is dropped with it.`, table.qualified);
        const small = sizeClass(table) === "new" || sizeClass(table) === "small" || !this.hasRows(table);
        const indexed = table.indexes.some((index) => index.valid && !index.partial && index.method === "btree" && index.columns[0] === column.name);
        if (!small && !indexed) this.fail("index-needed", `${label} has no index to find its largest value with, and finding it would read all of ${table.qualified} under a lock. Add an index on the column first (add_index), then change it to an identity column.`, table.qualified);

        const target = qualifiedIdent(table.schema, table.name);
        const ref = ident(column.name);
        // Before PostgreSQL 13 a column that owns the sequence of an old serial default and also has an identity makes every INSERT fail ("more than
        // one owned sequence found"), so the old sequence is detached first. It stays, for anything that calls nextval on it by name.
        const detach = this.facts.serverVersionNum < 130000
            ? `EXECUTE COALESCE((SELECT string_agg(format('ALTER SEQUENCE %s OWNED BY NONE', d.objid::regclass), '; ') FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid WHERE d.refobjid = ${literal(target)}::regclass AND a.attname = ${literal(column.name)} AND d.classid = 'pg_class'::regclass AND d.deptype = 'a'), 'SELECT 1');`
            : undefined;
        const alter = `ALTER TABLE ${target} ALTER COLUMN ${ref} ADD GENERATED BY DEFAULT AS IDENTITY;`;
        // The identity's own sequence is the one the column depends on internally. pg_get_serial_sequence would be ambiguous for a column that still
        // owns the sequence of an old serial default, and would start the wrong one.
        const sequence = `(SELECT d.objid FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid WHERE d.refobjid = ${literal(target)}::regclass AND a.attname = ${literal(column.name)} AND d.classid = 'pg_class'::regclass AND d.deptype = 'i')::regclass`;
        const start = `setval(${sequence}, (SELECT COALESCE(max(${ref}), 0) + 1 FROM ${target}), false)`;
        this.add({
            title: `Make ${label} an identity column, starting after its largest value`,
            // one transaction either way: inside the lock-retry block when there is one, otherwise as a DO block of its own
            sql: this.settings.lockAttempts >= 2
                ? `${detach ? `${detach}\n` : ""}${alter}\nPERFORM ${start};`
                : `DO $identity$\nBEGIN\n  SET LOCAL lock_timeout = '${this.settings.lockTimeoutSeconds}s';\n  ${detach ? `${detach}\n  ` : ""}${alter}\n  PERFORM ${start};\nEND\n$identity$;`,
            mode: "short",
            lock: "ACCESS EXCLUSIVE",
            work: "metadata",
            table,
            notes: [
                "BY DEFAULT: an insert that gives the column a value still works, and one that leaves it out gets the next number.",
                `The sequence is started at the largest value the column holds plus one, in the same transaction, so a new row cannot be given a number that is already used.${small ? "" : " The largest value is read through an index."}`,
                ...(detach ? ["This server is older than PostgreSQL 13, which cannot have an identity and the sequence of an old serial default on one column, so any such old sequence is detached from the column first. It stays, and is no longer dropped with the column."] : []),
            ],
            undo: `ALTER TABLE ${target} ALTER COLUMN ${ref} DROP IDENTITY;`,
        });
        column.generated = "default-identity";
    }

    /** ALTER COLUMN ... TYPE: in place when PostgreSQL only has to change the catalog, otherwise the expand/contract sequence. */
    private typeChange(table: TableFacts, column: ColumnFacts, to: string): void {
        const target = qualifiedIdent(table.schema, table.name);
        const ref = ident(column.name);
        const label = `${table.qualified}.${column.name}`;
        const blockers = column.dependents.filter((dependent) => dependent.blocks);
        if (blockers.length > 0) {
            this.fail("dependents", `${label} is used by ${this.describeDependents(blockers)}. PostgreSQL refuses to change the type of a column they use, and the expand/contract swap would leave them on the old column. Drop or re-create them around the change by hand.`, table.qualified);
        }
        const castMethod = this.discovery ? undefined : this.probes.casts.get(castKey(column.type, to));
        if (this.discovery) this.needed.typeChanges.push({ from: column.type, to });
        const verdict = classifyTypeChange(column.type, to, castMethod);
        const size = sizeClass(table);

        if (table.dependentViews.length > 0) this.fail("dependent-views", `Views depend on ${table.qualified}: ${table.dependentViews.join(", ")}. PostgreSQL will not change a column's type while a view uses it; drop the views and recreate them afterwards.`, table.qualified);
        if (table.partitioned) this.fail("unsupported", `Changing the type of a column of the partitioned table ${table.qualified} is not compiled.`, table.qualified);

        const using = castMethod === undefined && !verdict.rewrite ? "" : castMethod === undefined ? ` USING ${ref}::${to}` : "";
        const direct = `ALTER TABLE ${target} ALTER COLUMN ${ref} TYPE ${to}${using};`;
        const undo = `ALTER TABLE ${target} ALTER COLUMN ${ref} TYPE ${column.type}${using ? ` USING ${ref}::${column.type}` : ""};`;

        if (!verdict.rewrite) {
            this.add({ title: `Change the type of ${label} to ${to}`, sql: direct, mode: "short", lock: "ACCESS EXCLUSIVE", work: "metadata", table, notes: [verdict.reason], undo });
            column.type = to;
            return;
        }

        if (size === "new" || size === "small" || !this.hasRows(table)) {
            this.add({
                title: `Change the type of ${label} to ${to}`,
                sql: direct,
                mode: "long",
                lock: "ACCESS EXCLUSIVE",
                work: "rewrite",
                table,
                notes: [verdict.reason, "The table is small, so rewriting it in place is acceptable."],
                undo,
            });
            this.note("warning", "rewrite", `Changing ${label} from ${column.type} to ${to} rewrites ${table.qualified} (${formatBytes(table.heapBytes)}) under ACCESS EXCLUSIVE.`, table.qualified);
            column.type = to;
            return;
        }

        // Expand / contract: nothing is rewritten under a lock. A trigger keeps the new column in step while the old one is copied across.
        const inKey = table.primaryKey.includes(column.name) || table.uniques.some((u) => u.columns.includes(column.name));
        if (inKey) this.fail("unsupported", `${label} is part of a key. Changing its type on a table this size means changing the key, and every foreign key that points at it; that needs a hand-written plan. ${verdict.reason}`, table.qualified);
        const checks = table.checks.filter((check) => check.columns.includes(column.name));
        const foreign = [...table.foreignKeys.filter((fk) => fk.columns.includes(column.name)), ...table.referencedBy.filter((fk) => fk.refColumns.includes(column.name))];
        if (foreign.length > 0 || checks.length > 0) {
            this.fail("unsupported", `${label} appears in ${foreign.length ? `foreign key ${[...table.foreignKeys.filter((fk) => fk.columns.includes(column.name)).map((fk) => fk.name), ...table.referencedBy.filter((fk) => fk.refColumns.includes(column.name)).map((fk) => fk.name)].join(", ")}` : `check ${checks.map((c) => c.name).join(", ")}`}. Changing its type online needs those re-created by hand. ${verdict.reason}`, table.qualified);
        }

        const taken = new Set(table.columns.map((c) => c.name));
        const fresh = limitName(`${column.name}__new`, taken);
        const old = limitName(`${column.name}__old`, taken);
        const freshRef = ident(fresh);
        const fn = limitName(`${table.name}_${column.name}__sync`, this.names(table));
        const fnName = qualifiedIdent(table.schema, fn);
        const convert = `${ref}::${to}`;

        this.note("warning", "rewrite", `Changing ${label} from ${column.type} to ${to} would rewrite ${table.qualified} (${formatBytes(table.heapBytes)}) under ACCESS EXCLUSIVE. The runbook uses expand/contract instead.`, table.qualified);

        this.add({
            title: `Expand: add ${fresh} (${to}) next to ${label}`,
            sql: `ALTER TABLE ${target} ADD COLUMN ${freshRef} ${to};`,
            mode: "short",
            lock: "ACCESS EXCLUSIVE",
            work: "metadata",
            table,
            notes: [verdict.reason, `Instead of changing ${column.name} in place, a second column is added, kept in step, filled and then swapped in.`],
            undo: `ALTER TABLE ${target} DROP COLUMN ${freshRef};`,
        });
        this.add({
            title: `Expand: keep ${fresh} in step with ${column.name}`,
            sql: `CREATE OR REPLACE FUNCTION ${fnName}() RETURNS trigger LANGUAGE plpgsql AS $sync$\nBEGIN\n  NEW.${freshRef} := NEW.${ref}::${to};\n  RETURN NEW;\nEND\n$sync$;\nCREATE TRIGGER ${ident(fn)} BEFORE INSERT OR UPDATE OF ${ref} ON ${target} FOR EACH ROW EXECUTE FUNCTION ${fnName}();`,
            mode: "short",
            lock: "SHARE ROW EXCLUSIVE",
            work: "metadata",
            table,
            notes: ["Every insert and every update of the old column also writes the new one, converted with ::" + to + ". Edit the expression if the plain cast is not the conversion you want."],
            undo: `DROP TRIGGER ${ident(fn)} ON ${target};\nDROP FUNCTION ${fnName}();`,
        });
        this.backfillStep(table, `Expand: copy ${column.name} into ${fresh}`, `${freshRef} = ${convert}`, `${freshRef} IS DISTINCT FROM ${convert}`);
        this.add({
            title: `Check that ${fresh} matches ${column.name}`,
            sql: `SELECT count(*) AS rows_that_differ FROM ${target} WHERE ${freshRef} IS DISTINCT FROM ${convert};`,
            mode: "long",
            lock: "ACCESS SHARE",
            work: "scan",
            table,
            notes: ["Reads the whole table without blocking anything. Expect 0 before you continue."],
        });

        const plainIndexes = table.indexes.filter((index) => index.uses.includes(column.name) && !index.constraint);
        const renames: string[] = [];
        // After the swap the old column is still there, named `old`, with whatever was not copied; the copies carry the original names.
        const staysOnOld: IndexFacts[] = [];
        const leftOnOld: IndexFacts[] = [];
        for (const index of plainIndexes) {
            if (index.partial || index.columns.some((c) => c === null) || index.method !== "btree" || !index.columns.includes(column.name)) {
                this.note("warning", "index-not-copied", `Index ${index.name} on ${label} is partial, an expression index or not a btree index, so it was not copied to ${fresh}. Recreate it after the swap.`, table.qualified);
                staysOnOld.push(index);
                continue;
            }
            const copy = limitName(`${index.name}__new`, this.names(table));
            this.claimRelation(table.schema, copy, "Index");
            const columns = index.columns.map((c) => (c === column.name ? fresh : (c as string)));
            this.concurrentIndexStep(table, copy, columns, index.unique, `Expand: build the copy of index ${index.name} on ${fresh}`);
            const oldName = limitName(`${index.name}__old`, this.names(table));
            renames.push(`ALTER INDEX ${qualifiedIdent(table.schema, index.name)} RENAME TO ${ident(oldName)};`, `ALTER INDEX ${qualifiedIdent(table.schema, copy)} RENAME TO ${ident(index.name)};`);
            leftOnOld.push({ ...index, name: oldName, definition: "", columns: index.columns.map((c) => (c === column.name ? old : c)), uses: index.uses.map((name) => (name === column.name ? old : name)), constraint: null });
        }

        if (column.notNull) {
            this.notNullSteps(table, fresh, { skipUpdate: true });
        }
        if (column.default) this.add({ title: `Give ${fresh} the default of ${column.name}`, sql: `ALTER TABLE ${target} ALTER COLUMN ${freshRef} SET DEFAULT ${column.default};`, mode: "short", lock: "ACCESS EXCLUSIVE", work: "metadata", table });

        this.add({
            title: `Swap: ${fresh} becomes ${column.name}`,
            // one transaction either way: inside the lock-retry block when there is one, otherwise as a DO block of its own
            sql: this.settings.lockAttempts >= 2
                ? `DROP TRIGGER ${ident(fn)} ON ${target};\nALTER TABLE ${target} RENAME COLUMN ${ref} TO ${ident(old)};\nALTER TABLE ${target} RENAME COLUMN ${freshRef} TO ${ref};${renames.map((line) => `\n${line}`).join("")}`
                : `DO $swap$\nBEGIN\n  SET LOCAL lock_timeout = '${this.settings.lockTimeoutSeconds}s';\n  DROP TRIGGER ${ident(fn)} ON ${target};\n  ALTER TABLE ${target} RENAME COLUMN ${ref} TO ${ident(old)};\n  ALTER TABLE ${target} RENAME COLUMN ${freshRef} TO ${ref};${renames.map((line) => `\n  ${line}`).join("")}\nEND\n$swap$;`,
            mode: "short",
            lock: "ACCESS EXCLUSIVE",
            work: "metadata",
            table,
            notes: ["One transaction (a DO block), so applications see the old column or the new one, never neither. Applications now read and write the new type."],
        });
        this.add({
            title: `Contract: drop the old column ${old} and the sync function`,
            sql: `ALTER TABLE ${target} DROP COLUMN ${ident(old)};\nDROP FUNCTION ${fnName}();`,
            mode: "short",
            lock: "ACCESS EXCLUSIVE",
            work: "metadata",
            table,
            optional: true,
            destructive: true,
            notes: ["Run this later, once nothing needs the old column and you are sure about the result. Until then the old data is still there to go back to."],
        });
        // The model after the steps that run by default: the old column and its indexes are still there until the contract step.
        table.columns.push({ ...column, name: old, dependents: [] });
        for (const index of staysOnOld) {
            index.columns = index.columns.map((c) => (c === column.name ? old : c));
            index.uses = index.uses.map((name) => (name === column.name ? old : name));
        }
        table.indexes.push(...leftOnOld);
        column.type = to;
    }

    private dropColumn(operation: Extract<Operation, { type: "drop_column" }>): void {
        const table = this.findTable(operation.tableName);
        const column = this.findColumn(table, operation.columnName);
        const label = `${table.qualified}.${column.name}`;
        if (table.primaryKey.includes(column.name)) this.fail("primary-key-column", `${label} is part of the primary key.`, table.qualified);
        const inbound = table.referencedBy.filter((fk) => fk.refColumns.includes(column.name));
        if (inbound.length > 0) this.fail("referenced", `${label} is referenced by ${inbound.map((fk) => `${fk.schema}.${fk.table} (${fk.name})`).join(", ")}. Drop those foreign keys first.`, table.qualified);
        const blockers = column.dependents.filter((dependent) => dependent.blocks);
        if (blockers.length > 0) this.fail("dependents", `${label} is used by ${this.describeDependents(blockers)}. PostgreSQL refuses to drop the column while they exist, and the compiler never uses CASCADE. Drop or change them first.`, table.qualified);
        const removedWith = column.dependents.filter((dependent) => !dependent.blocks);

        const indexes = table.indexes.filter((index) => index.uses.includes(column.name));
        const foreign = table.foreignKeys.filter((fk) => fk.columns.includes(column.name));
        const checks = table.checks.filter((check) => check.columns.includes(column.name));
        const used = indexes.filter((index) => (index.scans ?? 0) > 0);
        this.add({
            title: `Drop column ${label}`,
            sql: `ALTER TABLE ${qualifiedIdent(table.schema, table.name)} DROP COLUMN ${ident(column.name)};`,
            mode: "short",
            lock: "ACCESS EXCLUSIVE",
            work: "metadata",
            table,
            destructive: true,
            breaksClients: true,
            atLeast: this.hasRows(table) ? "high" : "low",
            notes: [
                "The column's data is gone for good. The table is not rewritten: the space comes back as rows are updated or after a full rewrite.",
                "Stop the application writing to this column first, or its inserts will start to fail.",
                ...(indexes.length ? [`Indexes dropped with it: ${indexes.map((index) => `${index.name}${(index.scans ?? 0) > 0 ? ` (used ${formatCount(index.scans ?? 0)} times)` : ""}`).join(", ")}.`] : []),
                ...(foreign.length ? [`Foreign keys dropped with it: ${foreign.map((fk) => fk.name).join(", ")}.`] : []),
                ...(checks.length ? [`${checks.length === 1 ? "CHECK constraint" : "CHECK constraints"} dropped with it: ${checks.map((check) => check.name).join(", ")}.`] : []),
                ...(removedWith.length ? [`Also removed with it: ${this.describeDependents(removedWith)}.`] : []),
            ],
        });
        if (used.length > 0) this.note("warning", "used-index", `Dropping ${label} also drops index ${used.map((index) => index.name).join(", ")}, which has been used since the statistics were reset.`, table.qualified);

        table.columns = table.columns.filter((c) => c !== column);
        table.indexes = table.indexes.filter((index) => !indexes.includes(index));
        table.foreignKeys = table.foreignKeys.filter((fk) => !foreign.includes(fk));
        table.uniques = table.uniques.filter((unique) => !unique.columns.includes(column.name));
        table.checks = table.checks.filter((check) => !checks.includes(check));
    }

    // ---- relationships and indexes ----------------------------------------------------------------------------------------

    /** `sourceTable/sourceColumn` is the referenced (parent) side, `targetTable/targetColumn` the column that holds the foreign key. */
    private addRelationship(operation: Extract<Operation, { type: "add_relationship" }>): void {
        const rel = operation.relationship;
        const parent = this.findTable(rel.sourceTable);
        const child = this.findTable(rel.targetTable);
        const parentColumn = this.findColumn(parent, rel.sourceColumn);
        const childColumn = this.findColumn(child, rel.targetColumn);
        const label = `${child.qualified}.${childColumn.name} -> ${parent.qualified}.${parentColumn.name}`;

        const compatible = baseOf(parentColumn.type) === baseOf(childColumn.type) || (isIntegerType(parentColumn.type) && isIntegerType(childColumn.type));
        if (!compatible) this.fail("type-mismatch", `${label}: the column types differ (${childColumn.type} and ${parentColumn.type}).`, child.qualified);
        const unique = (parent.primaryKey.length === 1 && lower(parent.primaryKey[0]) === lower(parentColumn.name)) || parent.uniques.some((u) => u.columns.length === 1 && lower(u.columns[0]) === lower(parentColumn.name)) || parent.indexes.some((i) => i.unique && i.valid && !i.partial && i.columns.length === 1 && i.columns[0] !== null && lower(i.columns[0]) === lower(parentColumn.name));
        if (!unique) this.fail("not-unique", `${parent.qualified}.${parentColumn.name} is not a primary key or unique, so no foreign key can point at it.`, parent.qualified);
        if (child.foreignKeys.some((fk) => fk.columns.length === 1 && lower(fk.columns[0]) === lower(childColumn.name) && qualifiedName(fk.refSchema, fk.refTable) === parent.qualified)) {
            this.fail("relationship-exists", `${label} already exists.`, child.qualified);
        }

        const name = limitName(rel.name?.trim() || `${child.name}_${childColumn.name}_fkey`, this.names(child));
        const onDelete = actionSql(rel.onDelete);
        const onUpdate = actionSql(rel.onUpdate);
        const clause = `FOREIGN KEY (${ident(childColumn.name)}) REFERENCES ${qualifiedIdent(parent.schema, parent.name)} (${ident(parentColumn.name)})${onDelete ? ` ON DELETE ${onDelete}` : ""}${onUpdate ? ` ON UPDATE ${onUpdate}` : ""}`;
        const target = qualifiedIdent(child.schema, child.name);
        const rows = this.hasRows(child);
        const hadIndex = child.indexes.some((index) => index.valid && index.columns[0] !== null && lower(index.columns[0] ?? "") === lower(childColumn.name));

        if (sizeClass(child) === "new" || !rows) {
            this.add({
                title: `Add foreign key ${name} on ${child.qualified}`,
                sql: `ALTER TABLE ${target} ADD CONSTRAINT ${ident(name)} ${clause};`,
                mode: "short",
                lock: "SHARE ROW EXCLUSIVE",
                also: [parent.qualified],
                work: "metadata",
                table: child,
                notes: [`${child.qualified} is empty, so the constraint can be checked right away. It briefly locks ${parent.qualified} against writes.`],
                undo: `ALTER TABLE ${target} DROP CONSTRAINT ${ident(name)};`,
            });
        } else {
            this.add({
                title: `Add foreign key ${name} on ${child.qualified} (NOT VALID)`,
                sql: `ALTER TABLE ${target} ADD CONSTRAINT ${ident(name)} ${clause} NOT VALID;`,
                mode: "short",
                lock: "SHARE ROW EXCLUSIVE",
                also: [parent.qualified],
                work: "metadata",
                table: child,
                notes: ["NOT VALID enforces the key for new and changed rows without reading the existing ones. It briefly locks both tables against writes."],
                undo: `ALTER TABLE ${target} DROP CONSTRAINT ${ident(name)};`,
            });
            this.add({
                title: `Validate foreign key ${name}`,
                sql: `ALTER TABLE ${target} VALIDATE CONSTRAINT ${ident(name)};`,
                mode: "long",
                lock: "SHARE UPDATE EXCLUSIVE",
                also: [parent.qualified],
                work: "scan",
                table: child,
                notes: [
                    "Checks every existing row against the parent without blocking reads or writes.",
                    `If it fails, rows have no parent. Find them with: SELECT c.${ident(childColumn.name)} FROM ${target} c LEFT JOIN ${qualifiedIdent(parent.schema, parent.name)} p ON p.${ident(parentColumn.name)} = c.${ident(childColumn.name)} WHERE c.${ident(childColumn.name)} IS NOT NULL AND p.${ident(parentColumn.name)} IS NULL LIMIT 10;`,
                ],
            });
        }

        child.foreignKeys.push({ name, columns: [childColumn.name], refSchema: parent.schema, refTable: parent.name, refColumns: [parentColumn.name], onDelete: onDelete ?? "NO ACTION", onUpdate: onUpdate ?? "NO ACTION", validated: true });
        parent.referencedBy.push({ name, schema: child.schema, table: child.name, columns: [childColumn.name], refColumns: [parentColumn.name] });

        if (!hadIndex) {
            const indexName = limitName(`${child.name}_${childColumn.name}_idx`, this.names(child));
            this.claimRelation(child.schema, indexName, "Index");
            this.concurrentIndexStep(child, indexName, [childColumn.name], false, `Index the foreign key column ${child.qualified}.${childColumn.name}`);
            this.steps[this.steps.length - 1].notes.unshift(`Recommended, not required: without an index on ${childColumn.name}, every delete or key change in ${parent.qualified} has to scan ${child.qualified}.`);
            child.indexes.push({ name: indexName, definition: "", columns: [childColumn.name], uses: [childColumn.name], method: "btree", unique: false, primary: false, valid: true, partial: false, constraint: null, bytes: 0, scans: null });
        }
    }

    private dropRelationship(operation: Extract<Operation, { type: "drop_relationship" }>): void {
        const parent = this.findTable(operation.sourceTable);
        const child = this.findTable(operation.targetTable);
        const parentColumn = this.findColumn(parent, operation.sourceColumn);
        const childColumn = this.findColumn(child, operation.targetColumn);
        const fk = child.foreignKeys.find((candidate) => candidate.columns.length === 1 && lower(candidate.columns[0]) === lower(childColumn.name) && qualifiedName(candidate.refSchema, candidate.refTable) === parent.qualified && lower(candidate.refColumns[0] ?? "") === lower(parentColumn.name));
        if (!fk) this.fail("no-such-relationship", `There is no foreign key from ${child.qualified}.${childColumn.name} to ${parent.qualified}.${parentColumn.name}.`, child.qualified);

        const target = qualifiedIdent(child.schema, child.name);
        this.add({
            title: `Drop foreign key ${fk.name} on ${child.qualified}`,
            sql: `ALTER TABLE ${target} DROP CONSTRAINT ${ident(fk.name)};`,
            mode: "short",
            lock: "ACCESS EXCLUSIVE",
            also: [parent.qualified],
            work: "metadata",
            table: child,
            destructive: true,
            atLeast: "medium",
            notes: ["Rows can reference parents that don't exist from now on. The index on the column, if any, stays."],
            undo: `ALTER TABLE ${target} ADD CONSTRAINT ${ident(fk.name)} FOREIGN KEY (${ident(childColumn.name)}) REFERENCES ${qualifiedIdent(parent.schema, parent.name)} (${ident(parentColumn.name)}) NOT VALID;`,
        });
        child.foreignKeys = child.foreignKeys.filter((candidate) => candidate !== fk);
        parent.referencedBy = parent.referencedBy.filter((inbound) => inbound.name !== fk.name || inbound.table !== child.name);
    }

    private addIndex(operation: Extract<Operation, { type: "add_index" }>): void {
        const table = this.findTable(operation.tableName);
        const spec = operation.index;
        const columns = spec.columns.map((name) => this.findColumn(table, name).name);
        this.claimRelation(table.schema, spec.name, "Index");

        const same = table.indexes.find((index) => index.valid && !index.partial && sameColumns(index.columns, columns));
        if (same) this.note("warning", "duplicate-index", `${table.qualified} already has index ${same.name} on (${columns.join(", ")}).`, table.qualified);
        else {
            const covering = table.indexes.find((index) => index.valid && !index.partial && index.method === "btree" && index.columns.length > columns.length && sameColumns(index.columns.slice(0, columns.length), columns));
            if (covering) this.note("warning", "covered-index", `${covering.name} on (${covering.columns.join(", ")}) already serves queries on (${columns.join(", ")}) as its leading columns.`, table.qualified);
        }

        this.concurrentIndexStep(table, spec.name, columns, spec.unique === true, `Build index ${spec.name} on ${table.qualified}(${columns.join(", ")})`);
        table.indexes.push({ name: spec.name, definition: "", columns, uses: columns, method: "btree", unique: spec.unique === true, primary: false, valid: true, partial: false, constraint: null, bytes: 0, scans: null });
    }

    private dropIndex(operation: Extract<Operation, { type: "drop_index" }>): void {
        const table = this.findTable(operation.tableName);
        const index = table.indexes.find((candidate) => candidate.name === operation.indexName) ?? table.indexes.find((candidate) => lower(candidate.name) === lower(operation.indexName));
        if (!index) this.fail("unknown-index", `Index "${operation.indexName}" is not on ${table.qualified}.`, table.qualified);
        if (index.constraint) this.fail("constraint-index", `${index.name} enforces the constraint ${index.constraint}. Change the constraint, not the index.`, table.qualified);
        if (table.partitioned) this.fail("unsupported", `Dropping an index of the partitioned table ${table.qualified} is not compiled.`, table.qualified);

        const scans = index.scans;
        if (scans !== null && scans > 0) {
            this.note("warning", "used-index", `${index.name} was scanned ${formatCount(scans)} times since the statistics were reset${this.facts.statsResetAt ? ` (${this.facts.statsResetAt.slice(0, 10)})` : ""}. Queries that used it will be slower.`, table.qualified);
        }
        this.add({
            title: `Drop index ${index.name}`,
            sql: `DROP INDEX CONCURRENTLY ${qualifiedIdent(table.schema, index.name)};`,
            mode: "concurrent",
            lock: "SHARE UPDATE EXCLUSIVE",
            work: "metadata",
            table,
            destructive: true,
            notes: [
                "CONCURRENTLY waits for running queries instead of locking the table. Needs the SQL Editor's no-transaction mode.",
                `Its size (${formatBytes(index.bytes)}) is freed. ${scans === null ? "" : `Scans since statistics reset: ${formatCount(scans)}.`}`.trim(),
            ],
            undo: index.definition ? index.definition.replace(/^CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX CONCURRENTLY ") + ";" : undefined,
        });
        table.indexes = table.indexes.filter((candidate) => candidate !== index);
    }

    // ---- constraints ------------------------------------------------------------------------------------------------------

    private addUnique(operation: Extract<Operation, { type: "add_unique" }>): void {
        const table = this.findTable(operation.tableName);
        const columns = operation.columns.map((name) => this.findColumn(table, name).name);
        if (new Set(columns.map(lower)).size !== columns.length) this.fail("duplicate-column", `The unique constraint on ${table.qualified} names a column twice.`, table.qualified);
        const same = (names: readonly (string | null)[]) => names.length === columns.length && names.every((name, i) => name !== null && lower(name) === lower(columns[i]));
        if (same(table.primaryKey) || table.uniques.some((unique) => unique.kind === "unique" && same(unique.columns))) {
            this.note("info", "no-change", `${table.qualified} (${columns.join(", ")}) is already unique.`, table.qualified);
            return;
        }
        // the index that enforces it carries the constraint's name, so uniqueSteps claims the name
        this.uniqueSteps(table, columns, operation.constraintName ?? undefined);
    }

    private addCheck(operation: Extract<Operation, { type: "add_check" }>): void {
        const table = this.findTable(operation.tableName);
        const expression = operation.expression.trim();
        const label = `${table.qualified}`;
        const problem = checkDefaultExpression(expression);
        if (problem) this.fail("bad-check", `CHECK on ${label}: ${problem.replace(/^The default/, "The expression")}`, table.qualified);
        const functions = functionsIn(expression);
        const target = qualifiedIdent(table.schema, table.name);
        if (this.discovery) {
            this.needed.functions.push(...functions);
            this.needed.checks.push({ table: target, expression });
            return;
        }
        const rejected = this.probes.checks.get(checkKey(target, expression));
        if (!this.probes.checks.has(checkKey(target, expression))) this.fail("check-unverified", `The CHECK on ${label} was not tried against the database.`, table.qualified);
        if (rejected) this.fail("bad-check", `PostgreSQL rejects the CHECK (${expression}) on ${label}: ${rejected}`, table.qualified);
        const unknown = functions.filter((fn) => !this.probes.volatility.get(fn));
        if (unknown.length > 0) this.fail("bad-check", `The CHECK on ${label} calls ${unknown.join(", ")}, which PostgreSQL does not have.`, table.qualified);
        const notImmutable = functions.filter((fn) => this.probes.volatility.get(fn) !== "i");
        if (notImmutable.length > 0) this.fail("bad-check", `The CHECK on ${label} calls ${notImmutable.join(", ")}, which is not immutable. A constraint has to give the same answer for the same row every time.`, table.qualified);

        const name = operation.constraintName ?? limitName(`${table.name}_check`, this.names(table));
        this.checkNameLength(name, "Constraint");
        if (this.names(table).has(name)) this.fail("name-taken", `${label} already has a constraint called ${name}.`, table.qualified);
        // the columns the expression uses, outside string literals: what a later column drop or type change has to know about
        const bare = expression.replace(/'(?:[^']|'')*'/g, " ");
        const used = table.columns.filter((column) => new RegExp(`(^|[^A-Za-z0-9_$"])"?${column.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?($|[^A-Za-z0-9_$"])`, "i").test(bare)).map((column) => column.name);

        if (sizeClass(table) === "new" || !this.hasRows(table)) {
            this.add({ title: `Add the check ${name} to ${label}`, sql: `ALTER TABLE ${target} ADD CONSTRAINT ${ident(name)} CHECK (${expression});`, mode: "short", lock: "ACCESS EXCLUSIVE", work: this.hasRows(table) ? "scan" : "metadata", table, notes: ["The table is empty, so there is nothing to check."], undo: `ALTER TABLE ${target} DROP CONSTRAINT ${ident(name)};` });
        } else {
            this.add({
                title: `Add the check ${name} to ${label} as NOT VALID`,
                sql: `ALTER TABLE ${target} ADD CONSTRAINT ${ident(name)} CHECK (${expression}) NOT VALID;`,
                mode: "short",
                lock: "ACCESS EXCLUSIVE",
                work: "metadata",
                table,
                notes: ["NOT VALID enforces the rule for new and changed rows without reading the existing ones."],
                undo: `ALTER TABLE ${target} DROP CONSTRAINT ${ident(name)};`,
            });
            this.add({
                title: `Validate the check ${name} on ${label}`,
                sql: `ALTER TABLE ${target} VALIDATE CONSTRAINT ${ident(name)};`,
                mode: "long",
                lock: "SHARE UPDATE EXCLUSIVE",
                work: "scan",
                table,
                notes: ["Reads the whole table but does not block reads or writes.", `If it fails, rows break the rule. Find them with: SELECT * FROM ${target} WHERE NOT (${expression}) LIMIT 10; fix them, then run this step again.`],
            });
        }
        table.checks.push({ name, kind: "check", definition: `CHECK ((${expression}))`, columns: used, validated: true });
    }

    // ---- enums ------------------------------------------------------------------------------------------------------------

    private enumName(name: string): { schema: string; name: string; key: string; sql: string } {
        const { schema, name: bare } = splitQualified(name.trim());
        const resolved = schema ?? this.settings.defaultSchema;
        return { schema: resolved, name: bare, key: lower(`${resolved}.${bare}`), sql: qualifiedIdent(resolved, bare) };
    }

    /** The labels of an enum this plan creates, when `type` (a column's type, arrays included) names one. */
    private createdEnum(type: string): string[] | undefined {
        const bare = type.replace(/\s*\[.*$/, "").replace(/"/g, "").trim();
        if (!bare || /[()]/.test(bare)) return undefined;
        return this.createdEnums.get(this.enumName(bare).key);
    }

    private createEnum(operation: Extract<Operation, { type: "create_enum" }>): void {
        const type = this.enumName(operation.typeName);
        this.checkNameLength(type.name, "Type");
        const values = operation.values.map((value) => value);
        if (new Set(values).size !== values.length) this.fail("duplicate-value", `The enum ${type.schema}.${type.name} lists a label twice.`);
        for (const value of values) {
            if (Buffer.byteLength(value) > 63) this.fail("name-too-long", `The label "${value.slice(0, 30)}…" of ${type.schema}.${type.name} is longer than the 63 bytes PostgreSQL allows.`);
            if (value.includes("\0")) this.fail("bad-value", `A label of ${type.schema}.${type.name} contains a null byte.`);
        }
        if (this.discovery) this.needed.enums.push({ schema: type.schema, name: type.name });
        // a type and a table of the same name cannot both exist, so the relation namespace is checked as well as the types
        this.claimRelation(type.schema, type.name, "Type");
        if (!this.discovery) {
            const known = this.probes.enums.get(relationKey(type.schema, type.name));
            if (!known) this.fail("type-unverified", `The type ${type.schema}.${type.name} was not looked for in the database.`);
            if (known.exists || this.createdEnums.has(type.key)) this.fail("name-taken", `A type called "${type.schema}.${type.name}" already exists.`);
        }
        this.add({
            title: `Create the enum ${type.schema}.${type.name} (${values.join(", ")})`,
            sql: `CREATE TYPE ${type.sql} AS ENUM (${values.map(literal).join(", ")});`,
            mode: "short",
            lock: "none",
            work: "none",
            notes: ["A new type: nothing existing is locked or rewritten.", "Labels can be added later but never removed or reordered without recreating the type."],
            undo: `DROP TYPE ${type.sql};`,
        });
        this.createdEnums.set(type.key, [...values]);
    }

    private addEnumValue(operation: Extract<Operation, { type: "add_enum_value" }>): void {
        const type = this.enumName(operation.typeName);
        const value = operation.value;
        if (Buffer.byteLength(value) > 63) this.fail("name-too-long", `The label "${value.slice(0, 30)}…" is longer than the 63 bytes PostgreSQL allows.`);
        if (value.includes("\0")) this.fail("bad-value", `The label contains a null byte.`);
        if (operation.before && operation.after) this.fail("bad-position", `Say BEFORE or AFTER a label, not both.`);
        if (this.discovery) {
            this.needed.enums.push({ schema: type.schema, name: type.name });
            return;
        }
        let labels = this.createdEnums.get(type.key);
        if (!labels) {
            const known = this.probes.enums.get(relationKey(type.schema, type.name));
            if (!known) this.fail("type-unverified", `The type ${type.schema}.${type.name} was not looked for in the database.`);
            if (!known.exists) this.fail("unknown-type", `PostgreSQL has no type called ${type.schema}.${type.name}.`);
            if (known.kind !== "e") this.fail("not-an-enum", `${type.schema}.${type.name} is not an enum type.`);
            labels = [...known.labels];
        }
        const neighbour = operation.before ?? operation.after ?? undefined;
        if (neighbour !== undefined && !labels.includes(neighbour)) this.fail("unknown-value", `${type.schema}.${type.name} has no label "${neighbour}" to put the new one ${operation.before ? "before" : "after"}.`);
        if (labels.includes(value)) {
            this.note("info", "no-change", `${type.schema}.${type.name} already has the label "${value}".`);
            return;
        }
        this.add({
            title: `Add the label ${value} to the enum ${type.schema}.${type.name}`,
            sql: `ALTER TYPE ${type.sql} ADD VALUE IF NOT EXISTS ${literal(value)}${operation.before ? ` BEFORE ${literal(operation.before)}` : operation.after ? ` AFTER ${literal(operation.after)}` : ""};`,
            mode: "short",
            lock: "none",
            work: "none",
            notes: [
                "Changes only the type: no table that uses it is locked, scanned or rewritten.",
                "A label can never be removed from an enum again (only by recreating the type), and it cannot be used in the same transaction that adds it: this step runs on its own, so later steps can use it.",
            ],
        });
        const at = neighbour === undefined ? labels.length : labels.indexOf(neighbour) + (operation.after ? 1 : 0);
        labels.splice(at, 0, value);
        this.createdEnums.set(type.key, labels);
    }

    private addPrimaryKey(operation: Extract<Operation, { type: "add_primary_key" }>): void {
        const table = this.findTable(operation.tableName);
        const label = table.qualified;
        if (table.primaryKey.length > 0) this.fail("has-primary-key", `${label} already has a primary key (${table.primaryKey.join(", ")}). Drop it first, or change the key some other way.`, table.qualified);
        if (table.partitioned) this.fail("unsupported", `${label} is partitioned. A primary key on a partitioned table has to include the partition key and is built partition by partition; that is not compiled.`, table.qualified);
        const columns = operation.columns.map((name) => this.findColumn(table, name));
        if (new Set(columns.map((column) => lower(column.name))).size !== columns.length) this.fail("duplicate-column", `The primary key of ${label} names a column twice.`, table.qualified);
        const names = columns.map((column) => column.name);
        const target = qualifiedIdent(table.schema, table.name);
        const given = operation.constraintName ?? undefined;
        const name = given ?? limitName(`${table.name}_pkey`, this.names(table));
        this.claimRelation(table.schema, name, "Primary key");
        if (this.names(table).has(name)) this.fail("name-taken", `${label} already has a constraint called ${name}.`, table.qualified);

        // A primary key makes its columns NOT NULL. Doing that first, through the validated CHECK, keeps ADD PRIMARY KEY from having to read the table under its lock.
        for (const column of columns) {
            if (column.notNull) continue;
            if (column.nullFraction !== null && column.nullFraction > 0) this.note("warning", "has-nulls", `${label}.${column.name} has NULLs according to the table statistics (about ${(column.nullFraction * 100).toFixed(1)}% of rows). A primary key cannot have any: the validation step will fail until they are filled.`, table.qualified);
            if (column.generated === null && column.default === null) this.note("info", "null-key", `${label}.${column.name} has no default, so rows inserted without it would fail once it is NOT NULL.`, table.qualified);
            this.notNullSteps(table, column.name);
            column.notNull = true;
        }

        const list = names.map(ident).join(", ");
        if (sizeClass(table) === "new") {
            this.add({ title: `Add the primary key ${name} to ${label}`, sql: `ALTER TABLE ${target} ADD CONSTRAINT ${ident(name)} PRIMARY KEY (${list});`, mode: "short", lock: "ACCESS EXCLUSIVE", work: "none", table });
        } else {
            this.concurrentIndexStep(table, name, names, true, `Build a unique index for the primary key of ${label}(${names.join(", ")})`);
            this.add({
                title: `Make the index the primary key of ${label}`,
                sql: `ALTER TABLE ${target} ADD CONSTRAINT ${ident(name)} PRIMARY KEY USING INDEX ${ident(name)};`,
                mode: "short",
                lock: "ACCESS EXCLUSIVE",
                work: "metadata",
                table,
                notes: ["The columns are already NOT NULL and the index is built and valid, so this only changes the catalog.", "A unique index fails to build if the table already has duplicates: find them with SELECT " + list + ", count(*) FROM " + target + " GROUP BY " + list + " HAVING count(*) > 1 LIMIT 10;"],
                undo: `ALTER TABLE ${target} DROP CONSTRAINT ${ident(name)};`,
            });
        }
        table.primaryKey = names;
        table.indexes.push({ name, definition: "", columns: names, uses: names, method: "btree", unique: true, primary: true, valid: true, partial: false, constraint: name, bytes: 0, scans: null });
    }

    private dropConstraint(operation: Extract<Operation, { type: "drop_constraint" }>): void {
        const table = this.findTable(operation.tableName);
        const name = operation.constraintName;
        const target = qualifiedIdent(table.schema, table.name);
        if (table.indexes.some((index) => index.primary && index.constraint === name)) this.fail("primary-key-constraint", `${name} is the primary key of ${table.qualified}; dropping it is not compiled.`, table.qualified);
        if (table.foreignKeys.some((fk) => fk.name === name)) this.fail("foreign-key-constraint", `${name} is a foreign key of ${table.qualified}: use drop_relationship.`, table.qualified);
        const check = table.checks.find((candidate) => candidate.name === name);
        const unique = table.uniques.find((candidate) => candidate.name === name);
        const found = check ?? unique;
        if (!found) this.fail("unknown-constraint", `${table.qualified} has no unique or check constraint called ${name}.`, table.qualified);

        if (unique) {
            const inbound = table.referencedBy.filter((fk) => fk.refColumns.length === unique.columns.length && fk.refColumns.every((column, i) => lower(column) === lower(unique.columns[i])));
            if (inbound.length > 0) this.fail("referenced", `${name} is the unique key that ${inbound.map((fk) => `${fk.schema}.${fk.table} (${fk.name})`).join(", ")} points at. Drop those foreign keys first.`, table.qualified);
        }
        const index = unique ? table.indexes.find((candidate) => candidate.constraint === name) : undefined;
        this.add({
            title: `Drop the ${check ? "check" : "unique constraint"} ${name} on ${table.qualified}`,
            sql: `ALTER TABLE ${target} DROP CONSTRAINT ${ident(name)};`,
            mode: "short",
            lock: "ACCESS EXCLUSIVE",
            work: "metadata",
            table,
            notes: [
                check ? "Rows that break the rule can be written as soon as this runs." : "Its index is dropped with it, and duplicates can be written as soon as this runs.",
                `To put it back: ALTER TABLE ${target} ADD CONSTRAINT ${ident(name)} ${found.definition}; (this reads the whole table under a lock; for a large table use add_${check ? "check" : "unique"} instead, which does it online).`,
                ...(index && (index.scans ?? 0) > 0 ? [`Its index has been scanned ${formatCount(index.scans ?? 0)} times since the statistics were reset, so queries use it.`] : []),
            ],
        });
        table.checks = table.checks.filter((candidate) => candidate !== check);
        table.uniques = table.uniques.filter((candidate) => candidate !== unique);
        if (index) table.indexes = table.indexes.filter((candidate) => candidate !== index);
    }
}

const baseOf = (type: string): string => parseType(type).base;

const sameColumns = (a: (string | null)[], b: (string | null)[]): boolean => a.length === b.length && a.every((value, i) => value !== null && lower(value) === lower(b[i] ?? ""));

function actionSql(action: string | null | undefined): string | undefined {
    switch (action) {
        case "cascade": return "CASCADE";
        case "set_null": return "SET NULL";
        case "set_default": return "SET DEFAULT";
        case "restrict": return "RESTRICT";
        case "no_action": return undefined;
        default: return undefined;
    }
}

/** Everything the compiler will want to ask the database about this plan. Run it, call `probe`, then call `compilePlan`. */
export function discoverProbes(input: Omit<CompileInput, "probes">): ProbeRequest {
    return new Compiler(input.plan, input.facts, emptyProbes(), true, input.settings).run().needed;
}

export function compilePlan(input: CompileInput): Runbook {
    return new Compiler(input.plan, input.facts, input.probes, false, input.settings).run().runbook;
}
