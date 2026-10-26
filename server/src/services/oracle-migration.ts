import type { Client } from "pg";
import { oracledb } from "./oracle-client.js";
import { dateText, numberText } from "./oracle-sql.js";
import { behaviourNotes, conversionNote, findNotCarried, type ConversionNote, type NotCarried } from "./oracle-conversion-notes.js";
import { columnKey, dataCheckFor, defaultFitsType, resolveName, resolvePgType, type MigrationEdits, type ParsedPgType } from "./oracle-type-edits.js";

export type { MigrationEdits } from "./oracle-type-edits.js";

/**
 * Oracle schema to PostgreSQL: read the Oracle schema from its dictionary, work out the PostgreSQL schema, copy the rows, add the
 * foreign keys, and check that what arrived matches what was there. Nothing is dropped silently: a column type or default with no
 * faithful PostgreSQL form is a problem the caller reports, and the migration does not start.
 *
 *   NUMBER(p)     smallint / integer / bigint / numeric(p,0)    NUMBER(p,s)  numeric(p,s)     NUMBER  numeric
 *   VARCHAR2(n)   varchar(n)    CHAR(n)  char(n)    CLOB  text    BLOB, RAW  bytea
 *   DATE          timestamp(0) (an Oracle DATE carries a time)  TIMESTAMP(n)  timestamp(n)   WITH TIME ZONE  timestamptz
 *   Upper-case names become lower-case (Oracle folds unquoted names to upper case, PostgreSQL to lower case), so a legacy query written
 *   without quotes finds the same tables and columns in both.
 */

export interface OracleColumn {
    name: string;
    /** USER_TAB_COLUMNS.DATA_TYPE: NUMBER, VARCHAR2, DATE, TIMESTAMP(6), TIMESTAMP(6) WITH TIME ZONE, ... */
    type: string;
    charLength: number | null;
    dataLength: number | null;
    precision: number | null;
    scale: number | null;
    nullable: boolean;
    /** DATA_DEFAULT as Oracle stores it, trimmed. */
    defaultValue: string | null;
}

export interface OracleConstraintColumns {
    name: string;
    columns: string[];
}

export interface OracleForeignKey extends OracleConstraintColumns {
    refTable: string;
    refColumns: string[];
}

export interface OracleTable {
    name: string;
    columns: OracleColumn[];
    primaryKey: OracleConstraintColumns | undefined;
    uniques: OracleConstraintColumns[];
    foreignKeys: OracleForeignKey[];
}

/** Oracle folds unquoted names to upper case; an all-upper-case name is the default spelling and becomes lower case, a mixed-case one was quoted on purpose and is kept. */
export const foldName = (name: string): string => (/[A-Z]/.test(name) && name === name.toUpperCase() ? name.toLowerCase() : name);
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const oracleQuote = (name: string) => `"${name.replace(/"/g, '""')}"`;

// ---- reading the Oracle schema -----------------------------------------------------------------------------------------------------

export async function introspectOracle(connection: oracledb.Connection): Promise<OracleTable[]> {
    type Row = Record<string, unknown>;
    const run = async (sql: string): Promise<Row[]> => (await connection.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT })).rows as Row[];

    const tableRows = await run("SELECT table_name FROM user_tables WHERE table_name NOT LIKE 'BIN$%' AND secondary = 'N' AND temporary = 'N' ORDER BY table_name");
    const columnRows = await run(
        "SELECT table_name, column_name, data_type, data_length, char_length, data_precision, data_scale, nullable, data_default FROM user_tab_columns ORDER BY table_name, column_id",
    );
    const constraintRows = await run("SELECT constraint_name, constraint_type, table_name, r_constraint_name FROM user_constraints WHERE constraint_type IN ('P', 'U', 'R') AND status = 'ENABLED'");
    const consColumnRows = await run("SELECT constraint_name, table_name, column_name FROM user_cons_columns ORDER BY constraint_name, position");

    const columnsOf = new Map<string, string[]>();
    const tableOfConstraint = new Map<string, string>();
    for (const row of consColumnRows) {
        const name = String(row.CONSTRAINT_NAME);
        columnsOf.set(name, [...(columnsOf.get(name) ?? []), String(row.COLUMN_NAME)]);
        tableOfConstraint.set(name, String(row.TABLE_NAME));
    }

    const tables = new Map<string, OracleTable>();
    for (const row of tableRows) tables.set(String(row.TABLE_NAME), { name: String(row.TABLE_NAME), columns: [], primaryKey: undefined, uniques: [], foreignKeys: [] });
    for (const row of columnRows) {
        const table = tables.get(String(row.TABLE_NAME));
        if (!table) continue;
        table.columns.push({
            name: String(row.COLUMN_NAME),
            type: String(row.DATA_TYPE),
            charLength: row.CHAR_LENGTH === null ? null : Number(row.CHAR_LENGTH),
            dataLength: row.DATA_LENGTH === null ? null : Number(row.DATA_LENGTH),
            precision: row.DATA_PRECISION === null ? null : Number(row.DATA_PRECISION),
            scale: row.DATA_SCALE === null ? null : Number(row.DATA_SCALE),
            nullable: row.NULLABLE === "Y",
            defaultValue: row.DATA_DEFAULT === null || row.DATA_DEFAULT === undefined ? null : String(row.DATA_DEFAULT).trim() || null,
        });
    }
    for (const row of constraintRows) {
        const table = tables.get(String(row.TABLE_NAME));
        if (!table) continue;
        const name = String(row.CONSTRAINT_NAME);
        const columns = columnsOf.get(name) ?? [];
        if (row.CONSTRAINT_TYPE === "P") table.primaryKey = { name, columns };
        else if (row.CONSTRAINT_TYPE === "U") table.uniques.push({ name, columns });
        else {
            const referenced = String(row.R_CONSTRAINT_NAME);
            table.foreignKeys.push({ name, columns, refTable: tableOfConstraint.get(referenced) ?? "", refColumns: columnsOf.get(referenced) ?? [] });
        }
    }
    return [...tables.values()];
}

// ---- types, defaults and DDL -------------------------------------------------------------------------------------------------------

export type ColumnKind = "number" | "date" | "string" | "other";

export interface PlannedColumn {
    oracleName: string;
    pgName: string;
    oracleType: string;
    pgType: string;
    kind: ColumnKind;
    nullable: boolean;
    pgDefault: string | null;
    /** What happens to this column's values: kept as they are, kept but behaving differently, or at risk. */
    note: ConversionNote;
    /** What the person changed on this column: its name, its type, or dropping its default. */
    edited: ("name" | "type" | "default")[];
    /** The default Oracle has, as it stores it; null when there is none. */
    oracleDefault: string | null;
    /** A query on the Oracle data that counts the values this type would change or lose, and the answer. Absent when nothing can be lost. */
    check?: DataCheck;
}

/** A query run on the Oracle data before anything is migrated, and what it counted. `count` is null when the query itself failed. */
export interface DataCheck {
    description: string;
    sql: string;
    count: number | null;
    /** The database's message when the query failed. */
    error?: string;
}

export interface PlannedTable {
    oracleName: string;
    pgName: string;
    columns: PlannedColumn[];
    rows: number;
    /** The person gave the table a name of their own. */
    renamed: boolean;
    /** The primary key's columns, by their Oracle and PostgreSQL names; empty when the table has none. */
    oraclePrimaryKey: string[];
    pgPrimaryKey: string[];
}

export interface MigrationPlan {
    tables: PlannedTable[];
    /** What stops the migration, one line each; empty when it can go ahead. */
    problems: string[];
    /** Changes the person asked for that could not be made, with the reason. They are not part of the plan. */
    editProblems: string[];
    /** Creates the tables with their primary keys and unique constraints. Runs before the rows. */
    createSql: string[];
    /** Adds the foreign keys. Runs after the rows, so no order of tables matters and the data is checked against them. */
    linkSql: string[];
    /** Objects of the Oracle schema the migration does not create (indexes, CHECK constraints, sequences, views, triggers, programs). */
    notCarried: NotCarried[];
    /** What behaves differently in queries on the PostgreSQL side, for this schema. */
    behaviour: string[];
}

/** The PostgreSQL type for one Oracle column, or why there is none. */
export function pgTypeOf(column: OracleColumn): { type: string; kind: ColumnKind } | string {
    const base = column.type.replace(/\(\d+\)/, "").toUpperCase();
    const fractional = Number(/\((\d+)\)/.exec(column.type)?.[1] ?? 6);
    switch (base) {
        case "NUMBER": {
            const { precision: p, scale: s } = column;
            if (p === null) return { type: "numeric", kind: "number" };
            if (s === null || s === 0) {
                if (p <= 4) return { type: "smallint", kind: "number" };
                if (p <= 9) return { type: "integer", kind: "number" };
                if (p <= 18) return { type: "bigint", kind: "number" };
                return { type: `numeric(${p},0)`, kind: "number" };
            }
            return { type: s > 0 ? `numeric(${p},${s})` : `numeric(${p},0)`, kind: "number" };
        }
        case "FLOAT":
        case "BINARY_DOUBLE":
            return { type: "double precision", kind: "number" };
        case "BINARY_FLOAT":
            return { type: "real", kind: "number" };
        case "VARCHAR2":
        case "NVARCHAR2":
            return { type: `varchar(${column.charLength || column.dataLength || 1})`, kind: "string" };
        case "CHAR":
        case "NCHAR":
            return { type: `char(${column.charLength || column.dataLength || 1})`, kind: "other" };
        case "CLOB":
        case "NCLOB":
            return { type: "text", kind: "string" };
        case "BLOB":
        case "RAW":
            return { type: "bytea", kind: "other" };
        case "DATE":
            return { type: "timestamp(0)", kind: "date" };
        case "TIMESTAMP":
            return fractional > 6 ? `${column.type} has more than PostgreSQL's six fractional digits` : { type: `timestamp(${fractional})`, kind: "date" };
        case "TIMESTAMP WITH TIME ZONE":
        case "TIMESTAMP WITH LOCAL TIME ZONE":
            return fractional > 6 ? `${column.type} has more than PostgreSQL's six fractional digits` : { type: `timestamptz(${fractional})`, kind: "other" };
        case "ROWID":
        case "UROWID":
            return { type: "text", kind: "other" };
        default:
            return `${column.type} has no PostgreSQL type this migration creates`;
    }
}

/** A column default, in PostgreSQL, or why it cannot be carried over. Only what has the same meaning on both sides is carried. */
export function pgDefaultOf(column: OracleColumn): { value: string | null } | string {
    const text = column.defaultValue;
    if (text === null) return { value: null };
    if (/^(sysdate|systimestamp|current_date|current_timestamp)(\s*\(\s*\d*\s*\))?$/i.test(text)) return { value: "CURRENT_TIMESTAMP" };
    if (/^-?\d+(\.\d+)?$/.test(text)) return { value: text };
    if (/^'([^']|'')*'$/.test(text)) return { value: text };
    if (/^null$/i.test(text)) return { value: null };
    return `its default ${text} is Oracle code`;
}

const defaultName = (name: string): string => foldName(name);

/** The migration of the Oracle schema described by `tables`, with the row counts to report and the person's `edits` applied. */
export function planMigration(tables: OracleTable[], counts: Map<string, number>, edits: MigrationEdits = {}): MigrationPlan {
    const problems: string[] = [];
    const editProblems: string[] = [];

    const planned: PlannedTable[] = tables.map((table) => {
        const tableEdit = edits.tables?.[table.name];
        let pgName = defaultName(table.name);
        let renamed = false;
        if (tableEdit?.pgName !== undefined) {
            const name = resolveName(tableEdit.pgName);
            if (name) {
                pgName = name;
                renamed = name !== defaultName(table.name);
            } else editProblems.push(`${table.name}: "${tableEdit.pgName}" is not a usable PostgreSQL name.`);
        }

        const columns = table.columns.map((column): PlannedColumn => {
            const label = `${table.name}.${column.name}`;
            const edit = edits.columns?.[columnKey(table.name, column.name)];
            const edited: PlannedColumn["edited"] = [];
            let columnName = defaultName(column.name);
            if (edit?.pgName !== undefined) {
                const name = resolveName(edit.pgName);
                if (name) {
                    if (name !== columnName) edited.push("name");
                    columnName = name;
                } else editProblems.push(`${label}: "${edit.pgName}" is not a usable PostgreSQL name.`);
            }
            const fallback: PlannedColumn = { oracleName: column.name, pgName: columnName, oracleType: column.type, pgType: "", kind: "other", nullable: column.nullable, pgDefault: null, note: { status: "risk", text: "Not migrated." }, edited, oracleDefault: column.defaultValue };

            const base = pgTypeOf(column);
            let type = base;
            let parsedType: ParsedPgType | undefined;
            if (edit?.pgType !== undefined) {
                const resolved = resolvePgType(column, edit.pgType);
                if (typeof resolved === "string") editProblems.push(`${label}: ${resolved}`);
                else {
                    parsedType = resolved.parsed;
                    type = { type: resolved.type, kind: resolved.kind };
                    if (typeof base === "string" || base.type !== resolved.type) edited.push("type");
                }
            }
            if (typeof type === "string") {
                problems.push(`${label}: ${type}.`);
                return fallback;
            }

            let def = pgDefaultOf(column);
            let droppedBecause: string | undefined;
            if (edit?.dropDefault && column.defaultValue !== null) {
                def = { value: null };
                edited.push("default");
                droppedBecause = "you dropped it";
            } else if (typeof def !== "string" && def.value !== null && parsedType && edited.includes("type") && !defaultFitsType(def.value, parsedType)) {
                droppedBecause = `it does not fit ${type.type}`;
                def = { value: null };
            }
            if (typeof def === "string") problems.push(`${label}: ${def}.`);
            const pgDefault = typeof def === "string" ? null : def.value;

            let note = conversionNote(column, type.type, pgDefault);
            if (edited.includes("type")) note = { status: note.status === "risk" ? "risk" : "changed", text: `You changed this to ${type.type}. ${note.text}` };
            if (droppedBecause) note = { ...note, text: `${note.text} Its default ${column.defaultValue} was not carried over: ${droppedBecause}.` };
            return { ...fallback, pgType: type.type, kind: type.kind, pgDefault, note };
        });

        return {
            oracleName: table.name,
            pgName,
            renamed,
            rows: counts.get(table.name) ?? 0,
            oraclePrimaryKey: table.primaryKey?.columns ?? [],
            pgPrimaryKey: (table.primaryKey?.columns ?? []).map((name) => columns.find((column) => column.oracleName === name)?.pgName ?? defaultName(name)),
            columns,
        };
    });

    // two tables, or two columns of a table, that would end up with one name
    const seenTables = new Map<string, string>();
    for (const table of planned) {
        const other = seenTables.get(table.pgName);
        if (other) problems.push(`${other} and ${table.oracleName} would both be called ${table.pgName}.`);
        else seenTables.set(table.pgName, table.oracleName);
        const seenColumns = new Map<string, string>();
        for (const column of table.columns) {
            const clash = seenColumns.get(column.pgName);
            if (clash) problems.push(`${table.oracleName}: ${clash} and ${column.oracleName} would both be called ${column.pgName}.`);
            else seenColumns.set(column.pgName, column.oracleName);
        }
    }

    const pgNameOf = new Map(planned.map((table) => [table.oracleName, table.pgName]));
    const pgColumn = (table: OracleTable, name: string) => planned.find((candidate) => candidate.oracleName === table.name)?.columns.find((column) => column.oracleName === name)?.pgName ?? foldName(name);
    const createSql: string[] = [];
    const linkSql: string[] = [];
    for (const table of tables) {
        const plan = planned.find((candidate) => candidate.oracleName === table.name)!;
        const lines = plan.columns.map((column) => `  ${quote(column.pgName)} ${column.pgType}${column.nullable ? "" : " NOT NULL"}${column.pgDefault === null ? "" : ` DEFAULT ${column.pgDefault}`}`);
        if (table.primaryKey) lines.push(`  PRIMARY KEY (${table.primaryKey.columns.map((name) => quote(pgColumn(table, name))).join(", ")})`);
        for (const unique of table.uniques) lines.push(`  CONSTRAINT ${quote(foldName(unique.name))} UNIQUE (${unique.columns.map((name) => quote(pgColumn(table, name))).join(", ")})`);
        createSql.push(`CREATE TABLE ${quote(plan.pgName)} (\n${lines.join(",\n")}\n)`);
        for (const key of table.foreignKeys) {
            const target = tables.find((candidate) => candidate.name === key.refTable);
            if (!target) {
                problems.push(`${table.name}: the foreign key ${key.name} points at ${key.refTable || "a table outside this schema"}.`);
                continue;
            }
            linkSql.push(
                `ALTER TABLE ${quote(plan.pgName)} ADD CONSTRAINT ${quote(foldName(key.name))} FOREIGN KEY (${key.columns.map((name) => quote(pgColumn(table, name))).join(", ")}) REFERENCES ${quote(pgNameOf.get(key.refTable) ?? foldName(key.refTable))} (${key.refColumns.map((name) => quote(pgColumn(target, name))).join(", ")})`,
            );
        }
    }
    if (planned.length === 0) problems.push("The schema has no tables.");
    return { tables: planned, problems, editProblems, createSql, linkSql, notCarried: [], behaviour: behaviourNotes(planned) };
}

/**
 * Runs, on the Oracle data, the query that counts the values each column's PostgreSQL type would change or lose, and puts the answer on the
 * column. Only columns with something to lose have one. A query that fails is recorded as failed (count null), never as zero.
 */
export async function runDataChecks(connection: oracledb.Connection, tables: OracleTable[], plan: MigrationPlan): Promise<void> {
    for (const table of plan.tables) {
        const source = tables.find((candidate) => candidate.name === table.oracleName);
        if (!source) continue;
        for (const column of table.columns) {
            const oracleColumn = source.columns.find((candidate) => candidate.name === column.oracleName);
            if (!oracleColumn || column.pgType === "") continue;
            // Only what can lose something is counted: a type the person changed, and the two defaults that can (a wide FLOAT, a time zone).
            if (!column.edited.includes("type") && !/^(FLOAT|TIMESTAMP(\(\d\))? WITH TIME ZONE)/i.test(oracleColumn.type)) continue;
            const query = dataCheckFor(table.oracleName, oracleColumn, column.pgType);
            if (!query) continue;
            try {
                column.check = { description: query.description, sql: query.sql, count: Number(((await connection.execute(query.sql)).rows as unknown[][])[0][0]) };
            } catch (error) {
                column.check = { description: query.description, sql: query.sql, count: null, error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
            }
            if (column.check.count !== null && column.check.count > 0 && column.note.status !== "risk") column.note = { status: "risk", text: `${column.check.count} value${column.check.count === 1 ? "" : "s"} would be affected (${column.check.description}). ${column.note.text}` };
            if (column.check.count === null) column.note = { status: "risk", text: `The check on your data could not run (${column.check.error}). ${column.note.text}` };
        }
    }
}

/** The checks that found something, or could not run: what has to be accepted before the migration may go ahead. */
export const failedChecks = (plan: MigrationPlan): { table: string; column: string; check: DataCheck }[] =>
    plan.tables.flatMap((table) => table.columns.flatMap((column) => (column.check && (column.check.count === null || column.check.count > 0) ? [{ table: table.pgName, column: column.pgName, check: column.check }] : [])));

export async function planOracleMigration(connection: oracledb.Connection, edits: MigrationEdits = {}): Promise<MigrationPlan> {
    const tables = await introspectOracle(connection);
    const counts = new Map<string, number>();
    for (const table of tables) counts.set(table.name, Number(((await connection.execute(`SELECT COUNT(*) FROM ${oracleQuote(table.name)}`)).rows as unknown[][])[0][0]));
    const plan = { ...planMigration(tables, counts, edits), notCarried: await findNotCarried(connection) };
    await runDataChecks(connection, tables, plan);
    return plan;
}

// ---- copying the rows --------------------------------------------------------------------------------------------------------------

type FetchTypeHandler = NonNullable<oracledb.ExecuteOptions["fetchTypeHandler"]>;

/** Rows as text PostgreSQL parses (numbers without a leading-dot form, dates as wall-clock text, instants as ISO), with binary as Buffers. */
const migrationFetch: FetchTypeHandler = (metaData) => {
    switch (metaData.dbType) {
        case oracledb.DB_TYPE_NUMBER:
        case oracledb.DB_TYPE_BINARY_DOUBLE:
        case oracledb.DB_TYPE_BINARY_FLOAT:
            return { type: oracledb.DB_TYPE_VARCHAR, converter: (value: unknown) => (typeof value === "string" ? numberText(value) : value) };
        case oracledb.DB_TYPE_DATE:
        case oracledb.DB_TYPE_TIMESTAMP:
            return { converter: (value: unknown) => (value instanceof Date ? dateText(value) : value) };
        case oracledb.DB_TYPE_TIMESTAMP_TZ:
        case oracledb.DB_TYPE_TIMESTAMP_LTZ:
            return { converter: (value: unknown) => (value instanceof Date ? value.toISOString() : value) };
        case oracledb.DB_TYPE_CLOB:
        case oracledb.DB_TYPE_NCLOB:
            return { type: oracledb.DB_TYPE_VARCHAR };
        case oracledb.DB_TYPE_BLOB:
            return { type: oracledb.DB_TYPE_RAW };
        default:
            return undefined;
    }
};

/**
 * How a column is read from Oracle. Dates and timestamps are read as text made by Oracle itself: the driver hands them over as JavaScript
 * dates, and those turn the year 0001 into 1901 and depend on the server's time zone. Instants (WITH TIME ZONE) are read in UTC with an offset.
 */
export function oracleSelectExpression(column: PlannedColumn): string {
    const name = oracleQuote(column.oracleName);
    const type = column.oracleType.toUpperCase();
    const digits = /\((\d+)\)/.exec(type)?.[1] ?? "6";
    // a date or timestamp that becomes a PostgreSQL date is read as its day, without the time of day
    if ((type === "DATE" || type.startsWith("TIMESTAMP")) && !type.includes("TIME ZONE") && column.pgType === "date") return `TO_CHAR(TRUNC(${name}), 'YYYY-MM-DD')`;
    if (type === "DATE") return `TO_CHAR(${name}, 'YYYY-MM-DD HH24:MI:SS')`;
    if (type.startsWith("TIMESTAMP") && (type.includes("TIME ZONE"))) return `CASE WHEN ${name} IS NULL THEN NULL ELSE TO_CHAR(SYS_EXTRACT_UTC(${name}), 'YYYY-MM-DD HH24:MI:SS.FF${digits}') || '+00' END`; // (a NULL joined with || is '' in Oracle, hence the CASE)
    if (type.startsWith("TIMESTAMP")) return `TO_CHAR(${name}, 'YYYY-MM-DD HH24:MI:SS.FF${digits}')`;
    return name;
}

const BATCH_ROWS = 500;
const MAX_PARAMETERS = 60_000;

/** Copies every row of one table. Returns how many were copied. */
export async function copyTable(oracle: oracledb.Connection, pg: Client, table: PlannedTable): Promise<number> {
    if (table.columns.length === 0) return 0;
    const select = `SELECT ${table.columns.map(oracleSelectExpression).join(", ")} FROM ${oracleQuote(table.oracleName)}`;
    const perInsert = Math.max(1, Math.min(BATCH_ROWS, Math.floor(MAX_PARAMETERS / table.columns.length)));
    const columnList = table.columns.map((column) => quote(column.pgName)).join(", ");
    const result = await oracle.execute(select, [], { resultSet: true, fetchArraySize: BATCH_ROWS, fetchTypeHandler: migrationFetch });
    const resultSet = result.resultSet!;
    let copied = 0;
    try {
        for (;;) {
            const rows = (await resultSet.getRows(perInsert)) as unknown[][];
            if (rows.length === 0) break;
            const values: unknown[] = [];
            const groups = rows.map((row, index) => {
                row.forEach((cell) => values.push(cell === undefined ? null : cell));
                return `(${table.columns.map((_, column) => `$${index * table.columns.length + column + 1}`).join(", ")})`;
            });
            await pg.query({ text: `INSERT INTO ${quote(table.pgName)} (${columnList}) VALUES ${groups.join(", ")}`, values });
            copied += rows.length;
        }
    } finally {
        await resultSet.close().catch(() => undefined);
    }
    return copied;
}

// ---- checking what arrived ---------------------------------------------------------------------------------------------------------

/** One thing compared between the two databases: the expression run on each side and what each returned. */
export interface ProofCheck {
    label: string;
    oracleExpression: string;
    postgresExpression: string;
    oracle: string | null;
    postgres: string | null;
    match: boolean;
}

/** The first rows of a table by primary key, as each database returns them. */
export interface ProofSample {
    columns: string[];
    oracleSql: string;
    postgresSql: string;
    oracleRows: (string | null)[][];
    postgresRows: (string | null)[][];
    /** Whether the cells that can be compared (numbers, dates, text) are equal; a binary or time-zone cell is shown, not compared. */
    match: boolean;
}

export interface TableProof {
    /** The one statement run on each side for the checks. */
    oracleSql: string;
    postgresSql: string;
    checks: ProofCheck[];
    /** Absent when the table has no primary key to order a sample by. */
    sample?: ProofSample;
}

export interface TableVerification {
    table: string;
    oracleRows: number;
    postgresRows: number;
    /** How many comparisons were made (the row count, NULLs and sums of numbers, first and last dates, total text length, and the sample rows). */
    checks: number;
    /** What differed, in words; empty when the table matches. */
    mismatches: string[];
    proof: TableProof;
}

const sameNumber = (a: string | null, b: string | null): boolean => {
    if (a === null || b === null) return a === b;
    const [x, y] = [Number(a), Number(b)];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return a === b;
    return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
};

const SAMPLE_ROWS = 5;
const asText = (cell: unknown): string | null => (cell === null || cell === undefined ? null : Buffer.isBuffer(cell) ? `\\x${cell.toString("hex")}` : String(cell));

/**
 * What arrived, compared with what was there, by queries run on both sides: the row count, the NULLs of every column, a sum for each
 * number, the first and last of each date, the total length of each text, and the first rows by primary key. Every comparison keeps the
 * expression it ran and both answers, so the result can be shown and repeated.
 */
export async function verifyTable(oracle: oracledb.Connection, pg: Client, table: PlannedTable): Promise<TableVerification> {
    const oq = (column: PlannedColumn) => oracleQuote(column.oracleName);
    const pq = (column: PlannedColumn) => quote(column.pgName);
    type Planned = { label: string; oracleExpression: string; postgresExpression: string; how: "number" | "text" };
    const planned: Planned[] = [{ label: "rows", oracleExpression: "COUNT(*)", postgresExpression: "count(*)", how: "number" }];
    for (const column of table.columns) planned.push({ label: `NULLs in ${column.pgName}`, oracleExpression: `COUNT(CASE WHEN ${oq(column)} IS NULL THEN 1 END)`, postgresExpression: `count(*) FILTER (WHERE ${pq(column)} IS NULL)`, how: "number" });
    for (const column of table.columns.filter((c) => c.kind === "number")) planned.push({ label: `sum of ${column.pgName}`, oracleExpression: `SUM(${oq(column)})`, postgresExpression: `sum(${pq(column)})`, how: "number" });
    for (const column of table.columns.filter((c) => c.kind === "date")) {
        planned.push({ label: `first ${column.pgName}`, oracleExpression: oracleSelectExpression(column).replace(oq(column), `MIN(${oq(column)})`), postgresExpression: `min(${pq(column)})`, how: "text" });
        planned.push({ label: `last ${column.pgName}`, oracleExpression: oracleSelectExpression(column).replace(oq(column), `MAX(${oq(column)})`), postgresExpression: `max(${pq(column)})`, how: "text" });
    }
    for (const column of table.columns.filter((c) => c.kind === "string")) planned.push({ label: `total length of ${column.pgName}`, oracleExpression: `SUM(LENGTH(${oq(column)}))`, postgresExpression: `sum(length(${pq(column)}))`, how: "number" });

    const oracleSql = `SELECT ${planned.map((entry) => entry.oracleExpression).join(", ")} FROM ${oracleQuote(table.oracleName)}`;
    const postgresSql = `SELECT ${planned.map((entry) => `(${entry.postgresExpression})::text`).join(", ")} FROM ${quote(table.pgName)}`;
    const o = ((await oracle.execute(oracleSql, [], { fetchTypeHandler: migrationFetch })).rows as unknown[][])[0].map(asText);
    const p = ((await pg.query({ text: postgresSql, rowMode: "array" })).rows[0] as unknown[]).map(asText);

    const checks: ProofCheck[] = planned.map((entry, at) => ({
        label: entry.label,
        oracleExpression: entry.oracleExpression,
        postgresExpression: entry.postgresExpression,
        oracle: o[at],
        postgres: p[at],
        match: entry.how === "number" ? sameNumber(o[at], p[at]) : o[at] === p[at],
    }));
    const mismatches = checks.filter((check) => !check.match).map((check) => `${check.label}: Oracle ${check.oracle}, PostgreSQL ${check.postgres}`);

    let sample: ProofSample | undefined;
    if (table.pgPrimaryKey.length > 0) {
        const key = table.oraclePrimaryKey.map((name) => table.columns.find((c) => c.oracleName === name)!);
        // (The PostgreSQL select list is aliased c0, c1, ...: ORDER BY a name that is also an output column sorts by that output, here the text of the number.)
        // Text keys are ordered by bytes on both sides, so the same rows come first whatever each database's collation is.
        const oracleOrder = key.map((c) => oq(c)).join(", ");
        const postgresOrder = key.map((c) => (c.kind === "string" || c.kind === "other" ? `${pq(c)} COLLATE "C"` : pq(c))).join(", ");
        const sampleOracleSql = `SELECT ${table.columns.map(oracleSelectExpression).join(", ")} FROM ${oracleQuote(table.oracleName)} ORDER BY ${oracleOrder} FETCH FIRST ${SAMPLE_ROWS} ROWS ONLY`;
        const samplePostgresSql = `SELECT ${table.columns.map((c, at) => `${pq(c)}::text AS ${quote(`c${at}`)}`).join(", ")} FROM ${quote(table.pgName)} ORDER BY ${postgresOrder} LIMIT ${SAMPLE_ROWS}`;
        const oracleRows = ((await oracle.execute(sampleOracleSql, [], { fetchTypeHandler: migrationFetch })).rows as unknown[][]).map((row) => row.map(asText));
        const postgresRows = ((await pg.query({ text: samplePostgresSql, rowMode: "array" })).rows as unknown[][]).map((row) => row.map(asText));
        let same = oracleRows.length === postgresRows.length;
        if (!same) mismatches.push(`sample: Oracle returned ${oracleRows.length} rows, PostgreSQL ${postgresRows.length}`);
        else {
            oracleRows.forEach((row, r) =>
                table.columns.forEach((column, c) => {
                    if (column.kind === "other") return;
                    const equal = column.kind === "number" ? sameNumber(row[c], postgresRows[r][c]) : row[c] === postgresRows[r][c];
                    if (!equal) {
                        same = false;
                        mismatches.push(`sample row ${r + 1}, ${column.pgName}: Oracle ${row[c]}, PostgreSQL ${postgresRows[r][c]}`);
                    }
                }),
            );
        }
        sample = { columns: table.columns.map((c) => c.pgName), oracleSql: sampleOracleSql, postgresSql: samplePostgresSql, oracleRows, postgresRows, match: same };
    }

    const [oracleRows, postgresRows] = [Number(o[0]), Number(p[0])];
    return { table: table.pgName, oracleRows, postgresRows, checks: checks.length + (sample ? 1 : 0), mismatches, proof: { oracleSql, postgresSql, checks, sample } };
}

export interface MigrationResult {
    tables: { name: string; rows: number }[];
    verification: TableVerification[];
}

/**
 * Loads the rows into the new database, adds the foreign keys, and verifies every table, in one transaction: if any of it fails or any
 * table does not match, nothing is kept. `pg` is connected to the new database as the role that owns its tables.
 */
export async function loadAndVerify(oracle: oracledb.Connection, pg: Client, plan: MigrationPlan): Promise<MigrationResult> {
    await pg.query("BEGIN");
    try {
        const tables: MigrationResult["tables"] = [];
        for (const table of plan.tables) tables.push({ name: table.pgName, rows: await copyTable(oracle, pg, table) });
        for (const statement of plan.linkSql) await pg.query(statement);
        const verification: TableVerification[] = [];
        for (const table of plan.tables) verification.push(await verifyTable(oracle, pg, table));
        const wrong = verification.filter((entry) => entry.mismatches.length > 0);
        if (wrong.length > 0) throw new Error(`The copy does not match Oracle: ${wrong.map((entry) => `${entry.table} (${entry.mismatches.join("; ")})`).join(" · ")}`);
        await pg.query("COMMIT");
        return { tables, verification };
    } catch (error) {
        await pg.query("ROLLBACK").catch(() => undefined);
        throw error;
    }
}
