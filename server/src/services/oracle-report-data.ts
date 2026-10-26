import type oracledb from "oracledb";
import { oracledb as driver } from "./oracle-client.js";
import type { ColumnFacts, DataFacts, ReportSample } from "./migration-report.js";
import { migrationFetch, oracleSelectExpression, type MigrationPlan, type PlannedColumn, type PlannedTable } from "./oracle-migration.js";
import { oracleFamily } from "./oracle-type-edits.js";

/**
 * What the report reads from the Oracle data, read only: for every column how many values are NULL and how many the copy changes or loses
 * (a time of day going into a date, an offset that is not kept, a leading dot that gets its 0), and a few rows of every table with each
 * value as Oracle shows it beside the value PostgreSQL will receive, read with the very expressions the copy reads with.
 */

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** How many characters of a long value the sample shows; the copy carries all of it. */
export const SAMPLE_TEXT = 200;
const SAMPLE_BYTES = 32;

type Shape = Pick<PlannedColumn, "oracleName" | "oracleType" | "pgType">;

/** The SQL that returns a value as Oracle itself writes it: a number as Oracle prints it, a date with its time, a time zone with the offset it was stored with. */
export function oracleDisplayExpression(column: Shape): string {
    const name = quote(column.oracleName);
    const type = column.oracleType.toUpperCase();
    const digits = /\((\d+)\)/.exec(type)?.[1] ?? "6";
    const family = oracleFamily({ type });
    switch (family) {
        case "number":
        case "float":
        case "rowid":
            return `TO_CHAR(${name})`;
        case "date":
            return `TO_CHAR(${name}, 'YYYY-MM-DD HH24:MI:SS')`;
        case "timestamp":
            return `TO_CHAR(${name}, 'YYYY-MM-DD HH24:MI:SS.FF${digits}')`;
        case "timestamptz":
            return `TO_CHAR(${name}, 'YYYY-MM-DD HH24:MI:SS.FF${digits} TZH:TZM')`;
        case "clob":
            return `DBMS_LOB.SUBSTR(${name}, ${SAMPLE_TEXT}, 1)`;
        case "binary":
            return type === "BLOB" ? `RAWTOHEX(DBMS_LOB.SUBSTR(${name}, ${SAMPLE_BYTES}, 1))` : `RAWTOHEX(${name})`;
        default:
            return `SUBSTR(${name}, 1, ${SAMPLE_TEXT})`;
    }
}

interface Counter {
    label: string;
    /** The condition that makes a value count, over the quoted column. */
    where: string;
}

/** What is worth counting on a column, beyond its NULLs, from what the copy does to its values. */
function countersFor(column: Shape): Counter[] {
    const name = quote(column.oracleName);
    const type = column.oracleType.toUpperCase();
    const family = oracleFamily({ type });
    if (family === "date" || family === "timestamp") {
        const dropped = column.pgType === "date";
        return [{ label: dropped ? "values with a time of day, which the date drops" : "values with a time of day, which is kept", where: `${name} <> TRUNC(${name})` }];
    }
    if (family === "timestamptz" && !/LOCAL/.test(type)) {
        return [{ label: "values written in an offset other than UTC, which is not kept", where: `EXTRACT(TIMEZONE_HOUR FROM ${name}) <> 0 OR EXTRACT(TIMEZONE_MINUTE FROM ${name}) <> 0` }];
    }
    if (family === "number" || family === "float") {
        return [{ label: "values between -1 and 1, whose leading 0 the copy adds", where: `ABS(${name}) < 1 AND ${name} <> 0` }];
    }
    return [];
}

/** NULLs and changed values for every column of every table, one aggregate query per table. */
export async function readDataFacts(connection: oracledb.Connection, plan: MigrationPlan): Promise<DataFacts> {
    const facts: DataFacts = {};
    for (const table of plan.tables) {
        if (table.columns.length === 0) continue;
        const parts: { column: PlannedColumn; counters: Counter[] }[] = table.columns.map((column) => ({ column, counters: countersFor(column) }));
        const select = ["COUNT(*)"];
        for (const { column, counters } of parts) {
            select.push(`COUNT(CASE WHEN ${quote(column.oracleName)} IS NULL THEN 1 END)`);
            for (const counter of counters) select.push(`COUNT(CASE WHEN ${counter.where} THEN 1 END)`);
        }
        const row = ((await connection.execute(`SELECT ${select.join(", ")} FROM ${quote(table.oracleName)}`)).rows as unknown[][])[0].map(Number);
        const total = row[0];
        let at = 1;
        for (const { column, counters } of parts) {
            const nulls = row[at++];
            const affected = counters.map((counter) => ({ label: counter.label, count: row[at++], sql: `SELECT COUNT(*) FROM ${quote(table.oracleName)} WHERE ${counter.where}` }));
            const entry: ColumnFacts = { nulls, values: total - nulls, affected };
            facts[`${table.oracleName}.${column.oracleName}`] = entry;
        }
    }
    return facts;
}

const asText = (cell: unknown): string | null => {
    if (cell === null || cell === undefined) return null;
    if (Buffer.isBuffer(cell)) return `\\x${cell.subarray(0, SAMPLE_BYTES).toString("hex")}${cell.length > SAMPLE_BYTES ? "…" : ""}`;
    const text = String(cell);
    return text.length > SAMPLE_TEXT ? `${text.slice(0, SAMPLE_TEXT)}…` : text;
};

/** What a value is, as PostgreSQL will receive it, shortened the way the sample shows it. Exported for the test that compares it with what the copy wrote. */
export const receivedText = asText;

/** The first rows of a table as one query: for each column the value as Oracle shows it and the value the copy reads, so both views are of the same rows. */
export async function readTableSample(connection: oracledb.Connection, table: PlannedTable, rows = 5): Promise<ReportSample> {
    const order = table.oraclePrimaryKey.length > 0 ? ` ORDER BY ${table.oraclePrimaryKey.map(quote).join(", ")}` : "";
    const select = table.columns.flatMap((column, index) => [`${oracleDisplayExpression(column)} AS "D${index}"`, `${oracleSelectExpression(column)} AS "R${index}"`]);
    const sql = `SELECT ${select.join(", ")} FROM ${quote(table.oracleName)}${order} FETCH FIRST ${rows} ROWS ONLY`;
    const result = await connection.execute(sql, [], { fetchTypeHandler: migrationFetch, outFormat: driver.OUT_FORMAT_ARRAY });
    const all = (result.rows ?? []) as unknown[][];
    return {
        columns: table.columns.map((column) => column.pgName),
        oracle: all.map((row) => table.columns.map((_, index) => asText(row[index * 2]))),
        postgres: all.map((row) => table.columns.map((_, index) => asText(row[index * 2 + 1]))),
        ordered: table.oraclePrimaryKey.length > 0,
        sql,
    };
}

/** A few rows of every table, by Oracle table name. */
export async function readSamples(connection: oracledb.Connection, plan: MigrationPlan, rows = 5): Promise<Record<string, ReportSample>> {
    const samples: Record<string, ReportSample> = {};
    for (const table of plan.tables) if (table.columns.length > 0) samples[table.oracleName] = await readTableSample(connection, table, rows);
    return samples;
}
