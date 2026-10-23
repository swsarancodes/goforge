import type { Client } from "pg";
import { oracledb } from "./oracle-client.js";
import { dateText, numberText } from "./oracle-sql.js";

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
}

export interface PlannedTable {
    oracleName: string;
    pgName: string;
    columns: PlannedColumn[];
    rows: number;
}

export interface MigrationPlan {
    tables: PlannedTable[];
    /** What stops the migration, one line each; empty when it can go ahead. */
    problems: string[];
    /** Creates the tables with their primary keys and unique constraints. Runs before the rows. */
    createSql: string[];
    /** Adds the foreign keys. Runs after the rows, so no order of tables matters and the data is checked against them. */
    linkSql: string[];
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

/** The migration of the Oracle schema described by `tables`, with the row counts to report. */
export function planMigration(tables: OracleTable[], counts: Map<string, number>): MigrationPlan {
    const problems: string[] = [];
    const planned: PlannedTable[] = tables.map((table) => ({
        oracleName: table.name,
        pgName: foldName(table.name),
        rows: counts.get(table.name) ?? 0,
        columns: table.columns.map((column): PlannedColumn => {
            const type = pgTypeOf(column);
            const label = `${table.name}.${column.name}`;
            const fallback: PlannedColumn = { oracleName: column.name, pgName: foldName(column.name), oracleType: column.type, pgType: "", kind: "other", nullable: column.nullable, pgDefault: null };
            if (typeof type === "string") {
                problems.push(`${label}: ${type}.`);
                return fallback;
            }
            const def = pgDefaultOf(column);
            if (typeof def === "string") problems.push(`${label}: ${def}.`);
            return { ...fallback, pgType: type.type, kind: type.kind, pgDefault: typeof def === "string" ? null : def.value };
        }),
    }));

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
    return { tables: planned, problems, createSql, linkSql };
}

export async function planOracleMigration(connection: oracledb.Connection): Promise<MigrationPlan> {
    const tables = await introspectOracle(connection);
    const counts = new Map<string, number>();
    for (const table of tables) counts.set(table.name, Number(((await connection.execute(`SELECT COUNT(*) FROM ${oracleQuote(table.name)}`)).rows as unknown[][])[0][0]));
    return planMigration(tables, counts);
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

export interface TableVerification {
    table: string;
    oracleRows: number;
    postgresRows: number;
    /** How many column checks (sums of numbers, first and last dates, total text length) were compared. */
    checks: number;
    /** What differed, in words; empty when the table matches. */
    mismatches: string[];
}

const sameNumber = (a: string | null, b: string | null): boolean => {
    if (a === null || b === null) return a === b;
    const [x, y] = [Number(a), Number(b)];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return a === b;
    return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
};

/** Row counts and, for every column that can have one, a sum (numbers), a first and last value (dates) or a total length (text), on both sides. */
export async function verifyTable(oracle: oracledb.Connection, pg: Client, table: PlannedTable): Promise<TableVerification> {
    const sums = table.columns.filter((column) => column.kind === "number");
    const dates = table.columns.filter((column) => column.kind === "date");
    const texts = table.columns.filter((column) => column.kind === "string");
    const oracleParts = ["COUNT(*)", ...sums.map((c) => `SUM(${oracleQuote(c.oracleName)})`), ...dates.flatMap((c) => [oracleSelectExpression({ ...c, oracleName: c.oracleName }).replace(oracleQuote(c.oracleName), `MIN(${oracleQuote(c.oracleName)})`), oracleSelectExpression({ ...c, oracleName: c.oracleName }).replace(oracleQuote(c.oracleName), `MAX(${oracleQuote(c.oracleName)})`)]), ...texts.map((c) => `SUM(LENGTH(${oracleQuote(c.oracleName)}))`)];
    const pgParts = ["count(*)", ...sums.map((c) => `sum(${quote(c.pgName)})::text`), ...dates.flatMap((c) => [`min(${quote(c.pgName)})::text`, `max(${quote(c.pgName)})::text`]), ...texts.map((c) => `sum(length(${quote(c.pgName)}))::text`)];

    const o = ((await oracle.execute(`SELECT ${oracleParts.join(", ")} FROM ${oracleQuote(table.oracleName)}`, [], { fetchTypeHandler: migrationFetch })).rows as unknown[][])[0].map((cell) => (cell === null ? null : String(cell)));
    const p = Object.values((await pg.query({ text: `SELECT ${pgParts.join(", ")} FROM ${quote(table.pgName)}`, rowMode: "array" })).rows[0] as unknown as Record<string, string | null>).map((cell) => (cell === null ? null : String(cell)));

    const mismatches: string[] = [];
    let at = 1;
    for (const column of sums) {
        if (!sameNumber(o[at], p[at])) mismatches.push(`sum of ${column.pgName}: Oracle ${o[at]}, PostgreSQL ${p[at]}`);
        at++;
    }
    for (const column of dates) {
        if (o[at] !== p[at]) mismatches.push(`first ${column.pgName}: Oracle ${o[at]}, PostgreSQL ${p[at]}`);
        if (o[at + 1] !== p[at + 1]) mismatches.push(`last ${column.pgName}: Oracle ${o[at + 1]}, PostgreSQL ${p[at + 1]}`);
        at += 2;
    }
    for (const column of texts) {
        if (!sameNumber(o[at], p[at])) mismatches.push(`total length of ${column.pgName}: Oracle ${o[at]}, PostgreSQL ${p[at]}`);
        at++;
    }
    const [oracleRows, postgresRows] = [Number(o[0]), Number(p[0])];
    if (oracleRows !== postgresRows) mismatches.unshift(`rows: Oracle ${oracleRows}, PostgreSQL ${postgresRows}`);
    return { table: table.pgName, oracleRows, postgresRows, checks: sums.length + dates.length * 2 + texts.length + 1, mismatches };
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
