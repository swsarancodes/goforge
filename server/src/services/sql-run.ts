import { truncateCell } from "./pg-data.js";

export const ROW_CAP = 1000;
export const RUN_STATEMENT_TIMEOUT_MS = 60_000;
export const RUN_LOCK_TIMEOUT_MS = 10_000;

export const SAVEPOINT = "goforge_run";
const CURSOR = "goforge_cur";

export interface ResultColumn {
    name: string;
    dataType: string;
}

export interface StatementResult {
    /** Command tag verb as reported by Postgres: SELECT, INSERT, CREATE, ... */
    command: string;
    rowCount: number | null;
    columns: ResultColumn[];
    /** Every cell is the value's text form; SQL NULL is null. At most ROW_CAP rows. */
    rows: (string | null)[][];
    /** More rows existed than ROW_CAP. */
    truncated: boolean;
    /** [rowIndex, columnIndex] of cells cut to the cell limit. */
    truncatedCells: [number, number][];
}

export interface RunError {
    message: string;
    code?: string;
    /** 1-based offset into the SQL that was run (not into the wrapped batch). */
    position?: number;
    detail?: string;
    hint?: string;
}

export interface PgResultLike {
    command: string | null;
    rowCount: number | null;
    fields: { name: string; dataTypeID: number }[];
    rows: unknown[][];
}

// Built-in type OIDs are stable across Postgres versions; anything else (enums, domains, extensions) is looked up once.
const BUILTIN_TYPE_NAMES: Record<number, string> = {
    16: "boolean", 17: "bytea", 18: '"char"', 19: "name", 20: "bigint", 21: "smallint", 23: "integer", 25: "text", 26: "oid",
    114: "json", 142: "xml", 199: "json[]", 650: "cidr", 700: "real", 701: "double precision", 790: "money", 829: "macaddr", 869: "inet",
    1000: "boolean[]", 1005: "smallint[]", 1007: "integer[]", 1009: "text[]", 1014: "character[]", 1015: "character varying[]",
    1016: "bigint[]", 1021: "real[]", 1022: "double precision[]", 1042: "character", 1043: "character varying", 1082: "date",
    1083: "time without time zone", 1114: "timestamp without time zone", 1115: "timestamp without time zone[]", 1182: "date[]",
    1184: "timestamp with time zone", 1185: "timestamp with time zone[]", 1186: "interval", 1266: "time with time zone",
    1560: "bit", 1562: "bit varying", 1700: "numeric", 1231: "numeric[]", 2950: "uuid", 2951: "uuid[]", 3802: "jsonb", 3807: "jsonb[]",
    3904: "int4range", 3906: "numrange", 3908: "tsrange", 3910: "tstzrange", 3912: "daterange", 3926: "int8range",
};

export const builtinTypeName = (oid: number): string | undefined => BUILTIN_TYPE_NAMES[oid];

export function unknownTypeOids(results: PgResultLike[], known: Map<number, string>): number[] {
    const oids = new Set<number>();
    for (const result of results) {
        for (const field of result.fields ?? []) {
            if (BUILTIN_TYPE_NAMES[field.dataTypeID] === undefined && !known.has(field.dataTypeID)) oids.add(field.dataTypeID);
        }
    }
    return Array.from(oids);
}

export function mapResult(result: PgResultLike, typeNames: Map<number, string>): StatementResult {
    const fields = result.fields ?? [];
    const columns = fields.map((field) => ({ name: field.name, dataType: BUILTIN_TYPE_NAMES[field.dataTypeID] ?? typeNames.get(field.dataTypeID) ?? "unknown" }));

    const truncatedCells: [number, number][] = [];
    const rawRows = result.rows ?? [];
    const rows = rawRows.slice(0, ROW_CAP).map((row, rowIndex) =>
        row.map((cell, columnIndex) => {
            if (cell === null || cell === undefined) return null;
            const { value, truncated } = truncateCell(String(cell));
            if (truncated) truncatedCells.push([rowIndex, columnIndex]);
            return value;
        }),
    );

    return {
        command: result.command ?? "",
        rowCount: result.rowCount ?? null,
        columns,
        rows,
        truncated: rawRows.length > ROW_CAP,
        truncatedCells,
    };
}

/** Commands that cannot have changed anything; everything else marks the transaction as having changes. */
const READ_ONLY_COMMANDS = new Set(["SELECT", "SHOW", "EXPLAIN", "VALUES", "TABLE", "FETCH", "DECLARE", "CLOSE", "SET", "RESET"]);

export const changesData = (results: StatementResult[]): boolean => results.some((result) => !READ_ONLY_COMMANDS.has(result.command.toUpperCase()));

export function mapError(error: unknown, prefixLength: number, sqlLength: number): RunError {
    const source = (error ?? {}) as { message?: unknown; code?: unknown; position?: unknown; detail?: unknown; hint?: unknown };
    const message = typeof source.message === "string" && source.message ? source.message : String(error);

    // Postgres counts the error position from the start of the whole batch we sent; shift it onto the user's SQL.
    const raw = typeof source.position === "string" || typeof source.position === "number" ? Number(source.position) : NaN;
    const position = Number.isFinite(raw) && raw - prefixLength >= 1 && raw - prefixLength <= sqlLength + 1 ? raw - prefixLength : undefined;

    return {
        message,
        ...(typeof source.code === "string" ? { code: source.code } : {}),
        ...(position !== undefined ? { position } : {}),
        ...(typeof source.detail === "string" ? { detail: source.detail } : {}),
        ...(typeof source.hint === "string" ? { hint: source.hint } : {}),
    };
}

export type RunMode = "in-transaction" | "one-shot-read";

export interface RunBatch {
    /** The single multi-statement query to send. */
    text: string;
    /** Characters before the user's SQL, for mapping error positions. */
    prefixLength: number;
    /** Where the user's statement results sit in the returned array. */
    resultStart: number;
    /** How many of them (undefined = everything up to the trailing statement). */
    resultCount?: number;
}

const TIMEOUTS = [`SET LOCAL statement_timeout = ${RUN_STATEMENT_TIMEOUT_MS}`, `SET LOCAL lock_timeout = ${RUN_LOCK_TIMEOUT_MS}`];

/**
 * Builds the one query sent per run.
 *  - in-transaction: [BEGIN + timeouts if the transaction isn't open yet] SAVEPOINT; <sql>; RELEASE SAVEPOINT. The savepoint makes the whole
 *    run atomic: on any error it is rolled back to before the run while earlier uncommitted work stays.
 *  - one-shot-read: BEGIN READ ONLY; timeouts; <sql>; ROLLBACK - no transaction is left open for a plain SELECT.
 * With `cursor`, a single SELECT is fetched through a cursor so a huge table can't flood the API's memory.
 */
export function buildRunBatch(sql: string, options: { mode: RunMode; transactionOpen: boolean; cursor: boolean }): RunBatch {
    const header: string[] =
        options.mode === "one-shot-read"
            ? ["BEGIN READ ONLY", ...TIMEOUTS]
            : options.transactionOpen
              ? [`SAVEPOINT ${SAVEPOINT}`]
              : ["BEGIN", ...TIMEOUTS, `SAVEPOINT ${SAVEPOINT}`];
    const footer = options.mode === "one-shot-read" ? "ROLLBACK" : `RELEASE SAVEPOINT ${SAVEPOINT}`;

    // The trailing newline stops a final `-- comment` in the user's SQL from swallowing the `;` that follows it.
    if (options.cursor) {
        const declare = `DECLARE ${CURSOR} NO SCROLL CURSOR FOR `;
        const head = `${header.join("; ")}; ${declare}`;
        return {
            text: `${head}${sql}\n; FETCH FORWARD ${ROW_CAP + 1} FROM ${CURSOR}; CLOSE ${CURSOR}; ${footer}`,
            prefixLength: head.length,
            resultStart: header.length + 1,
            resultCount: 1,
        };
    }

    const head = `${header.join("; ")}; `;
    return { text: `${head}${sql}\n; ${footer}`, prefixLength: head.length, resultStart: header.length };
}

/** Picks the user's statement results out of what the batch returned. */
export function extractResults(raw: unknown, batch: RunBatch): PgResultLike[] {
    const all = (Array.isArray(raw) ? raw : [raw]) as PgResultLike[];
    const end = batch.resultCount !== undefined ? batch.resultStart + batch.resultCount : all.length - 1;
    return all.slice(batch.resultStart, end).filter((result) => result && (result.command || result.fields?.length));
}
