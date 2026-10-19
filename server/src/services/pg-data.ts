import type { Client } from "pg";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
export const CELL_MAX_CHARS = 4000;
export const STATEMENT_TIMEOUT_MS = 15_000;

// r = table, p = partitioned table, v = view, m = materialized view, f = foreign table
export type RelKind = "r" | "p" | "v" | "m" | "f";

export interface RelationColumn {
    name: string;
    dataType: string;
    isPrimaryKey: boolean;
}

export type SortDirection = "asc" | "desc";

export interface RowsQueryInput {
    schema: string;
    table: string;
    columns: RelationColumn[];
    relkind: RelKind;
    pkColumns: string[];
    sort?: string;
    dir?: SortDirection;
    limit?: number;
    offset?: number;
}

export interface RowsQuery {
    text: string;
    values: [number, number];
    limit: number;
    offset: number;
}

export interface TableDataPage {
    columns: RelationColumn[];
    /** Every cell is the column's `::text` form (lossless for every Postgres type); SQL NULL stays null. */
    rows: (string | null)[][];
    /** [rowIndex, columnIndex] of cells whose value was cut to CELL_MAX_CHARS. */
    truncatedCells: [number, number][];
    estimatedTotal: number | null;
    exactTotal?: number;
    limit: number;
    offset: number;
    sort: string | null;
    dir: SortDirection | null;
}

export interface FetchTableRowsArgs {
    schema: string;
    table: string;
    sort?: string;
    dir?: SortDirection;
    limit?: number;
    offset?: number;
    exactCount?: boolean;
}

/** A problem with what the caller asked for (unknown relation/column), as opposed to a connection or SQL failure. */
export class DataRequestError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
        this.name = "DataRequestError";
    }
}

/** Quotes a Postgres identifier. Equivalent to pg's Client#escapeIdentifier, but usable without a client. */
export function quoteIdent(name: string): string {
    if (name.includes("\0")) throw new DataRequestError("Identifier contains a null byte");
    return `"${name.replace(/"/g, '""')}"`;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Builds the page query. Every column is selected as `left(col::text, N)` so values come back
 * losslessly as text regardless of type (and one huge value can't bloat the response), while
 * ORDER BY still uses the real column so numeric/date ordering is correct. Identifiers come from
 * the catalog and are quoted; the only bound values are LIMIT/OFFSET.
 */
export function buildRowsQuery(input: RowsQueryInput): RowsQuery {
    const { schema, table, columns, relkind, pkColumns, sort } = input;
    const dir: SortDirection = input.dir === "desc" ? "desc" : "asc";
    const limit = clampInt(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    if (columns.length === 0) throw new DataRequestError(`"${schema}"."${table}" has no columns to display`);

    if (sort !== undefined && !columns.some((column) => column.name === sort)) {
        throw new DataRequestError(`Unknown sort column "${sort}"`);
    }

    const selectList = columns.map((column, index) => `left(${quoteIdent(column.name)}::text, ${CELL_MAX_CHARS + 1}) AS c${index}`);

    const orderBy: string[] = [];
    if (sort !== undefined) orderBy.push(`${quoteIdent(sort)} ${dir.toUpperCase()} NULLS LAST`);

    // Tie-breaker so paging is stable: primary key, else the physical row id for relations that have one.
    const tieBreakers = pkColumns.length > 0 ? pkColumns.map(quoteIdent) : relkind === "r" || relkind === "p" || relkind === "m" ? ["ctid"] : [];
    for (const tieBreaker of tieBreakers) {
        if (sort !== undefined && tieBreaker === quoteIdent(sort)) continue;
        orderBy.push(tieBreaker);
    }

    const text = [
        `SELECT ${selectList.join(", ")}`,
        `FROM ${quoteIdent(schema)}.${quoteIdent(table)}`,
        orderBy.length > 0 ? `ORDER BY ${orderBy.join(", ")}` : "",
        "LIMIT $1 OFFSET $2",
    ]
        .filter(Boolean)
        .join(" ");

    return { text, values: [limit, offset], limit, offset };
}

/** Cuts a cell to CELL_MAX_CHARS characters (code points, matching Postgres' left()). */
export function truncateCell(value: string): { value: string; truncated: boolean } {
    // Cheap exit: UTF-16 length never undercounts code points.
    if (value.length <= CELL_MAX_CHARS) return { value, truncated: false };
    const codePoints = Array.from(value);
    if (codePoints.length <= CELL_MAX_CHARS) return { value, truncated: false };
    return { value: codePoints.slice(0, CELL_MAX_CHARS).join(""), truncated: true };
}

const RELATION_QUERY = `
  SELECT c.oid::int8 AS oid, c.relkind, c.reltuples::int8 AS reltuples
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f');
`;

const COLUMNS_QUERY = `
  SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS data_type
  FROM pg_attribute a
  WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum;
`;

const PRIMARY_KEY_QUERY = `
  SELECT a.attname AS name
  FROM pg_index ix
  JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY(ix.indkey)
  WHERE ix.indrelid = $1 AND ix.indisprimary
  ORDER BY array_position(ix.indkey, a.attnum);
`;

/**
 * Reads one page of rows from a table/view/materialized view. Runs entirely inside a READ ONLY
 * transaction with a statement timeout and always rolls back, so it cannot change anything.
 */
export async function fetchTableRows(client: Client, args: FetchTableRowsArgs): Promise<TableDataPage> {
    await client.query("BEGIN READ ONLY");
    try {
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);

        const relation = await client.query(RELATION_QUERY, [args.schema, args.table]);
        if (relation.rowCount === 0) {
            throw new DataRequestError(`Table or view "${args.schema}"."${args.table}" was not found`);
        }
        const { oid, relkind, reltuples } = relation.rows[0] as { oid: string; relkind: RelKind; reltuples: string };

        const [columnsRes, pkRes] = await Promise.all([client.query(COLUMNS_QUERY, [oid]), client.query(PRIMARY_KEY_QUERY, [oid])]);
        const pkColumns: string[] = pkRes.rows.map((row) => row.name);
        const columns: RelationColumn[] = columnsRes.rows.map((row) => ({
            name: row.name,
            dataType: row.data_type,
            isPrimaryKey: pkColumns.includes(row.name),
        }));

        const query = buildRowsQuery({
            schema: args.schema,
            table: args.table,
            columns,
            relkind,
            pkColumns,
            sort: args.sort,
            dir: args.dir,
            limit: args.limit,
            offset: args.offset,
        });

        const dataRes = await client.query({ text: query.text, values: query.values, rowMode: "array" });

        const truncatedCells: [number, number][] = [];
        const rows = (dataRes.rows as (string | null)[][]).map((row, rowIndex) =>
            row.map((cell, columnIndex) => {
                if (cell === null) return null;
                const { value, truncated } = truncateCell(cell);
                if (truncated) truncatedCells.push([rowIndex, columnIndex]);
                return value;
            }),
        );

        // reltuples is -1 (never analyzed) or 0 for views, neither of which is a usable estimate.
        const estimate = Number(reltuples);
        const estimatedTotal = relkind !== "v" && relkind !== "f" && estimate > 0 ? estimate : null;

        let exactTotal: number | undefined;
        if (args.exactCount) {
            const countRes = await client.query(`SELECT count(*)::text AS total FROM ${quoteIdent(args.schema)}.${quoteIdent(args.table)}`);
            exactTotal = Number(countRes.rows[0].total);
        }

        return {
            columns,
            rows,
            truncatedCells,
            estimatedTotal,
            ...(exactTotal !== undefined ? { exactTotal } : {}),
            limit: query.limit,
            offset: query.offset,
            sort: args.sort ?? null,
            dir: args.sort !== undefined ? (args.dir === "desc" ? "desc" : "asc") : null,
        };
    } finally {
        // Always roll back - this endpoint only reads, and must never leave a transaction open.
        await client.query("ROLLBACK");
    }
}
