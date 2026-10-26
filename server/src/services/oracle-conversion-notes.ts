import type oracledb from "oracledb";
import { oracledb as driver } from "./oracle-client.js";

/**
 * What the Oracle to PostgreSQL migration says about each column, and about what it does not carry over, before it runs. The migration refuses
 * what it cannot do faithfully (see `pgTypeOf`); these notes are for what it does, so that a person can see where a value keeps its meaning
 * and where something is different or can be lost, instead of finding out in a query.
 */

/** `exact`: the same values, the same meaning. `changed`: the same stored values, but the type behaves differently in queries. `risk`: information can be lost or rounded. */
export type ConversionStatus = "exact" | "changed" | "risk";

export interface ConversionNote {
    status: ConversionStatus;
    text: string;
}

interface ColumnShape {
    type: string;
    precision: number | null;
    scale: number | null;
    defaultValue: string | null;
}

/** How one Oracle column's values fare in the PostgreSQL type the migration chose for it. */
export function conversionNote(column: ColumnShape, pgType: string, pgDefault: string | null): ConversionNote {
    const base = column.type.replace(/\(\d+\)/, "").toUpperCase();
    const { precision: p, scale: s } = column;
    const note = (status: ConversionStatus, text: string): ConversionNote => {
        const defaultNote = column.defaultValue !== null && pgDefault !== null && column.defaultValue.toUpperCase() !== pgDefault.toUpperCase() ? ` Its default ${column.defaultValue} becomes ${pgDefault}.` : "";
        return { status, text: text + defaultNote };
    };

    switch (base) {
        case "NUMBER":
            if (p === null) return note("exact", "NUMBER with no precision becomes numeric, which holds the same digits.");
            if (s !== null && s < 0) return note("changed", `Oracle rounds new values of NUMBER(${p},${s}) to ${10 ** -s}s; ${pgType} keeps the values already stored, but PostgreSQL will not round new ones.`);
            if (s !== null && s > 0) return note("exact", `${pgType} keeps every digit and the scale.`);
            if (/^(smallint|integer|bigint)$/.test(pgType)) return note("exact", `${pgType} holds every value of ${p} digits. Dividing two integer columns in PostgreSQL drops the fraction, which Oracle does not.`);
            return note("exact", `${pgType} keeps every digit.`);
        case "FLOAT":
            return p !== null && p <= 53
                ? note("exact", "FLOAT with up to 53 binary digits fits double precision exactly.")
                : note("risk", "Oracle FLOAT keeps about 38 decimal digits; double precision keeps about 15, so a value with more digits is rounded.");
        case "BINARY_DOUBLE":
            return note("exact", "The same 64-bit floating-point number.");
        case "BINARY_FLOAT":
            return note("exact", "The same 32-bit floating-point number.");
        case "VARCHAR2":
        case "NVARCHAR2":
            return note("exact", `${pgType} keeps the same text, with the length counted in characters.`);
        case "CHAR":
        case "NCHAR":
            return note("exact", `${pgType} pads with blanks as Oracle does.`);
        case "CLOB":
        case "NCLOB":
            return note("exact", "text keeps the same characters; one value over 1 GB would make the copy fail, not be cut.");
        case "BLOB":
        case "RAW":
            return note("exact", "bytea keeps the same bytes; one value over 1 GB would make the copy fail, not be cut.");
        case "DATE":
            return note("changed", "An Oracle DATE has a time to the second, so it becomes timestamp(0), not date: no time of day is lost. Date arithmetic (date + 1, date - date) works differently in PostgreSQL.");
        case "TIMESTAMP":
            return note("exact", `${pgType} keeps the same fractional digits.`);
        case "TIMESTAMP WITH TIME ZONE":
            return note("risk", "PostgreSQL keeps the moment (as UTC) but not the time zone each value was written in; the same moment is shown in the session's zone.");
        case "TIMESTAMP WITH LOCAL TIME ZONE":
            return note("changed", "Both keep the moment and show it in the session's time zone.");
        case "ROWID":
        case "UROWID":
            return note("changed", "Copied as text: the value is Oracle's physical row address and means nothing in PostgreSQL.");
        default:
            return note("risk", "No faithful PostgreSQL type.");
    }
}

export interface NotCarried {
    /** What kind of object: `index`, `check constraint`, `sequence`, `view`, `trigger`, `procedure`, ... */
    kind: string;
    name: string;
    /** The table it belongs to, or what it does, when that helps. */
    detail?: string;
}

type Row = Record<string, unknown>;

/**
 * Objects of the Oracle schema that the migration does not create in PostgreSQL: it carries tables, columns, NOT NULL, defaults with the same
 * meaning, primary keys, unique constraints and foreign keys, and nothing else. A query that could not be read is said so, never left out quietly.
 */
export async function findNotCarried(connection: oracledb.Connection): Promise<NotCarried[]> {
    const run = async (sql: string): Promise<Row[]> => (await connection.execute(sql, [], { outFormat: driver.OUT_FORMAT_OBJECT })).rows as Row[];
    const found: NotCarried[] = [];
    const scan = async (kind: string, sql: string, name: (row: Row) => string, detail?: (row: Row) => string | undefined) => {
        try {
            for (const row of await run(sql)) found.push({ kind, name: name(row), detail: detail?.(row) });
        } catch (error) {
            found.push({ kind: `${kind} (could not be read)`, name: "?", detail: error instanceof Error ? error.message.split("\n")[0] : String(error) });
        }
    };

    await scan(
        "index",
        `SELECT i.index_name AS N, i.table_name AS T, i.uniqueness AS U FROM user_indexes i
         WHERE i.index_type NOT IN ('LOB') AND i.table_name NOT LIKE 'BIN$%'
           AND NOT EXISTS (SELECT 1 FROM user_constraints c WHERE c.index_name = i.index_name AND c.constraint_type IN ('P', 'U'))
         ORDER BY i.table_name, i.index_name`,
        (row) => String(row.N),
        (row) => `on ${row.T}${row.U === "UNIQUE" ? ", unique" : ""}`,
    );
    await scan(
        "check constraint",
        `SELECT constraint_name AS N, table_name AS T, search_condition_vc AS C FROM user_constraints
         WHERE constraint_type = 'C' AND table_name NOT LIKE 'BIN$%' AND NOT (generated = 'GENERATED NAME' AND search_condition_vc LIKE '"%" IS NOT NULL')
         ORDER BY table_name, constraint_name`,
        (row) => String(row.N),
        (row) => `on ${row.T}: ${row.C}`,
    );
    await scan("sequence", "SELECT sequence_name AS N FROM user_sequences ORDER BY sequence_name", (row) => String(row.N));
    await scan("view", "SELECT view_name AS N FROM user_views ORDER BY view_name", (row) => String(row.N));
    await scan("trigger", "SELECT trigger_name AS N, table_name AS T FROM user_triggers ORDER BY trigger_name", (row) => String(row.N), (row) => `on ${row.T}`);
    await scan(
        "program",
        "SELECT object_name AS N, object_type AS K FROM user_objects WHERE object_type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'TYPE', 'SYNONYM', 'MATERIALIZED VIEW') ORDER BY object_type, object_name",
        (row) => String(row.N),
        (row) => String(row.K).toLowerCase(),
    );
    return found;
}

interface PlannedShape {
    columns: { oracleType: string; pgType: string }[];
}

/** What behaves differently in queries on the PostgreSQL side even though every stored value is kept. Only what this schema has is listed. */
export function behaviourNotes(tables: PlannedShape[]): string[] {
    const columns = tables.flatMap((table) => table.columns);
    const has = (test: (column: { oracleType: string; pgType: string }) => boolean) => columns.some(test);
    const notes: string[] = [];
    if (has((c) => /^(VARCHAR2|NVARCHAR2|CHAR|NCHAR|CLOB|NCLOB)/i.test(c.oracleType))) {
        notes.push("Oracle stores an empty string as NULL; PostgreSQL keeps '' and NULL apart. No stored value changes, but a query that tests for one of them can behave differently.");
        notes.push("Sorting and comparing text can order differently: the two databases use their own collations.");
    }
    if (has((c) => /^DATE$/i.test(c.oracleType))) notes.push("DATE arithmetic: in Oracle date + 1 adds a day and date - date is a number of days; in PostgreSQL use intervals, and a timestamp difference is an interval.");
    if (has((c) => /^(smallint|integer|bigint)$/.test(c.pgType))) notes.push("Dividing two integer columns drops the fraction in PostgreSQL; Oracle returns it.");
    notes.push("Names: unquoted Oracle names are upper case and become lower case, so a query without quotes finds the same tables and columns.");
    return notes;
}
