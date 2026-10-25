import { qualifiedName, type Facts, type TableFacts } from "./facts.js";
import { Redactor, type NameEntry } from "./redact.js";

/** What the planning model is told and shown. Facts come from the catalog; the person's words go in as written (or masked). */

export function plannerInstructions(): string {
    return [
        "You are GoForge's schema change planner for a large, live PostgreSQL database. You decide WHAT should change; a separate compiler turns your operations into online-safe SQL and checks them against the real catalog.",
        "Return JSON only. Do not use markdown fences or prose outside the JSON object.",
        "The JSON object must contain: summary (string), assumptions (string[]), warnings (string[]), clarifyingQuestions (string[]), operations (array).",
        "Supported operation types: create_table, rename_table, drop_table, add_column, alter_column, drop_column, add_relationship, drop_relationship, add_index, drop_index, add_unique, add_check, drop_constraint.",
        "create_table.table contains name, optional note, fields, and optional indexes. A field contains name, dataType, and optional nullable, primaryKey, unique, autoIncrement, defaultValue, maxLength, precision, scale, note.",
        "add_column has tableName and field. alter_column has tableName, columnName and changes (any of newName, dataType, maxLength, precision, scale, nullable, unique, defaultValue, autoIncrement). drop_column has tableName and columnName.",
        "Every key of the answer's shape is always written: give null for any that does not apply (a field with no default has defaultValue null). To remove an existing column's default, set changes.dropDefault to true; to leave the default alone, leave it null.",
        "An index contains name, columns (existing column names, in order) and optional unique. add_index has tableName and index; drop_index has tableName and indexName.",
        "add_unique has tableName, optional constraintName and columns (existing column names). add_check has tableName, optional constraintName and expression: ONE boolean SQL expression over the table's columns exactly as it follows CHECK, using only immutable functions and no subqueries. drop_constraint has tableName and constraintName of an existing unique or check constraint (use drop_relationship for a foreign key; the primary key is not dropped this way).",
        "add_relationship has relationship: sourceTable and sourceColumn are the REFERENCED (parent) side, targetTable and targetColumn are the column that HOLDS the foreign key (child side); optional name, onDelete, onUpdate (no_action, cascade, set_null, set_default, restrict).",
        "drop_relationship has sourceTable, sourceColumn, targetTable, targetColumn, with the same meaning of source and target.",
        "Table names are exactly as given in the facts, schema-qualified (schema.table). Use existing table, column and index names exactly. New object names may be anything valid.",
        "The request may ask for new tables. Use create_table for each one (with add_relationship for its foreign keys and add_index for its indexes); a new table needs no facts, so it can be created even when no table is shown. Give every new table a primary key unless the request says otherwise, and name it in the schema the existing tables use unless told otherwise.",
        "Only some tables are shown in full. otherTables lists the names of the rest. To reference one of those (a foreign key to it, for instance), use its exact name from otherTables and the column you expect it to have (usually its primary key); its columns are read for you after you answer. Never refer to a table that is in neither tables nor otherTables unless this plan creates it with create_table.",
        "dataType is a PostgreSQL type name such as integer, bigint, smallint, text, varchar (give maxLength), numeric (give precision and scale), boolean, date, timestamptz, uuid, jsonb. defaultValue is one SQL expression exactly as it follows DEFAULT: numbers as 0, text in single quotes as 'new', functions as now().",
        "The facts give each table's row estimate (null: never analyzed, size unknown), data size in bytes, columns, keys, indexes with how often each was scanned since the statistics were reset, and the views that depend on it. Use them: do not add an index that duplicates an existing one, do not drop an index that is still being used unless asked, and mention in warnings anything the size makes risky.",
        "Do not describe how to run the change safely: no CONCURRENTLY, NOT VALID, batching or lock advice. The compiler does that. Never write SQL.",
        "Create the smallest set of operations that satisfies the request. Never drop or rename an existing table, column or index unless the request says so.",
        "If a missing detail would change keys, types, nullability, defaults or deletion behaviour in a way you cannot choose safely, ask concise clarifying questions and return no operations.",
        "You are only shown names, types, sizes and counts. Do not ask for, invent or return data, credentials or secrets.",
    ].join("\n");
}

export interface PlannerInputOptions {
    prompt: string;
    facts: Facts;
    /** Tables in the database that are not in the scope. */
    omittedTables: number;
    /** The names of (some of) the tables that are not in the scope, so the model can refer to them. */
    otherTables?: { schema: string; name: string }[];
    redactor?: Redactor;
    /** What went wrong with the last answer, to repair it. */
    problems?: string[];
    previousPlan?: unknown;
}

const columnFacts = (table: TableFacts, id: (name: string) => string, type: (text: string) => string) =>
    table.columns.map((column) => ({
        name: id(column.name),
        type: column.typeSchema === "pg_catalog" ? column.type : type(column.type),
        notNull: column.notNull,
        ...(column.default !== null ? { hasDefault: true } : {}),
        ...(column.generated ? { generated: column.generated } : {}),
        ...(column.nullFraction !== null ? { nullFraction: Number(column.nullFraction.toFixed(3)) } : {}),
        ...(column.distinct !== null ? { distinctEstimate: column.distinct } : {}),
    }));

export function describeTable(table: TableFacts, id: (name: string) => string, type: (text: string) => string): Record<string, unknown> {
    const name = (schema: string, tableName: string) => `${id(schema)}.${id(tableName)}`;
    return {
        name: name(table.schema, table.name),
        kind: table.partitioned ? "partitioned table" : "table",
        ...(table.partitioned ? { partitions: table.partitionCount } : {}),
        rows: table.estimatedRows,
        dataBytes: table.heapBytes,
        indexBytes: table.indexBytes,
        columns: columnFacts(table, id, type),
        primaryKey: table.primaryKey.map(id),
        uniqueConstraints: table.uniques.map((unique) => ({ name: id(unique.name), columns: unique.columns.map(id) })),
        checkConstraints: table.checks.map((check) => ({ name: id(check.name), validated: check.validated })),
        foreignKeys: table.foreignKeys.map((fk) => ({ name: id(fk.name), columns: fk.columns.map(id), references: name(fk.refSchema, fk.refTable), referencedColumns: fk.refColumns.map(id), validated: fk.validated })),
        referencedBy: table.referencedBy.map((fk) => ({ table: name(fk.schema, fk.table), columns: fk.columns.map(id) })),
        indexes: table.indexes.map((index) => ({
            name: id(index.name),
            columns: index.columns.map((column) => (column === null ? "(expression)" : id(column))),
            method: index.method,
            unique: index.unique,
            ...(index.partial ? { partial: true } : {}),
            ...(index.valid ? {} : { valid: false }),
            ...(index.constraint ? { enforces: id(index.constraint) } : {}),
            sizeBytes: index.bytes,
            scans: index.scans,
        })),
        dependentViews: table.dependentViews.map((view) => {
            const { schema, name: viewName } = splitView(view);
            return name(schema, viewName);
        }),
        ...(table.stats ? { rowsInsertedOrChangedSinceAnalyze: table.stats.modificationsSinceAnalyze } : {}),
    };
}

const splitView = (qualified: string): { schema: string; name: string } => {
    const dot = qualified.indexOf(".");
    return dot === -1 ? { schema: "public", name: qualified } : { schema: qualified.slice(0, dot), name: qualified.slice(dot + 1) };
};

export function plannerInput(options: PlannerInputOptions): Record<string, unknown> {
    const { facts, redactor } = options;
    const id = (name: string) => (redactor ? redactor.id(name) : name);
    const type = (text: string) => (redactor ? redactor.type(text) : text);
    const tables = [...facts.tables.values()].sort((a, b) => a.qualified.localeCompare(b.qualified));

    return {
        request: redactor ? redactor.mask(options.prompt) : options.prompt,
        database: {
            postgresVersion: facts.serverVersion,
            tablesShown: tables.length,
            otherTablesNotShown: options.omittedTables,
            ...(options.otherTables && options.otherTables.length < options.omittedTables ? { otherTablesListed: options.otherTables.length } : {}),
            statisticsResetAt: facts.statsResetAt,
        },
        tables: tables.map((table) => describeTable(table, id, type)),
        ...(options.otherTables && options.otherTables.length > 0 ? { otherTables: options.otherTables.map((other) => `${id(other.schema)}.${id(other.name)}`) } : {}),
        ...(options.problems?.length
            ? { previousAnswerProblems: options.problems.map((problem) => (redactor ? redactor.mask(problem) : problem)), previousAnswer: redactor ? redactor.maskDeep(options.previousPlan) : options.previousPlan }
            : {}),
    };
}

/** Every name in the scope that redaction has to hide, with what kind of name it is. `prose` adds table and schema names of the whole database, for the request text only. */
export function namesToRedact(facts: Facts, prose: { schema: string; name: string }[] = []): NameEntry[] {
    const entries: NameEntry[] = [];
    for (const table of facts.tables.values()) {
        entries.push({ name: table.schema, kind: "schema" }, { name: table.name, kind: "table" });
        for (const column of table.columns) {
            entries.push({ name: column.name, kind: "column" });
            if (column.typeSchema !== "pg_catalog") {
                const base = column.type.replace(/\[.*$/, "").replace(/"/g, "");
                const dot = base.lastIndexOf(".");
                if (dot !== -1) entries.push({ name: base.slice(0, dot), kind: "schema" });
                entries.push({ name: base.slice(dot + 1), kind: "type" });
            }
        }
        for (const index of table.indexes) entries.push({ name: index.name, kind: "index" }, ...(index.constraint ? [{ name: index.constraint, kind: "constraint" as const }] : []));
        for (const constraint of [...table.uniques, ...table.checks]) entries.push({ name: constraint.name, kind: "constraint" });
        for (const fk of table.foreignKeys) entries.push({ name: fk.name, kind: "constraint" }, { name: fk.refSchema, kind: "schema" }, { name: fk.refTable, kind: "table" });
        for (const fk of table.referencedBy) entries.push({ name: fk.name, kind: "constraint" }, { name: fk.schema, kind: "schema" }, { name: fk.table, kind: "table" });
        for (const view of table.dependentViews) {
            const { schema, name } = splitView(view);
            entries.push({ name: schema, kind: "schema" }, { name, kind: "view" });
        }
    }
    for (const other of prose) entries.push({ name: other.schema, kind: "schema" }, { name: other.name, kind: "table" });
    return entries.filter((entry) => entry.name.length > 0);
}

export { qualifiedName };
