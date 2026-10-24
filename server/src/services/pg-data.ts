import { runReadOnly, type Queryable } from "./pg-read.js";
import { loadRelationMeta, type RelationMeta, type RelKind } from "./pg-relations.js";
import { DataRequestError, quoteIdent } from "./pg-sql.js";

export { DataRequestError, quoteIdent, quoteLiteral } from "./pg-sql.js";
export type { RelKind } from "./pg-relations.js";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
export const CELL_MAX_CHARS = 4000;

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
    /** Self-contained SQL: LIMIT/OFFSET are validated integers, identifiers are quoted. No bound parameters. */
    text: string;
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
    /** Catalog entry from the cache. Without it the relation is looked up first (one extra round trip). */
    meta?: RelationMeta;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Builds the page query. Every column is selected as `left(col::text, N)` so values come back
 * losslessly as text regardless of type (and one huge value can't bloat the response), while
 * ORDER BY still uses the real column so numeric/date ordering is correct. Identifiers come from
 * the catalog and are quoted; LIMIT and OFFSET are clamped integers, so the whole statement can be sent
 * as plain text in a single round trip.
 */
export function buildRowsQuery(input: RowsQueryInput): RowsQuery {
    const { schema, table, columns, relkind, pkColumns, sort } = input;
    const dir: SortDirection = input.dir === "desc" ? "desc" : "asc";
    const limit = clampInt(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) throw new DataRequestError("Invalid limit or offset");

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
        `LIMIT ${limit} OFFSET ${offset}`,
    ]
        .filter(Boolean)
        .join(" ");

    return { text, limit, offset };
}

/** Cuts a cell to CELL_MAX_CHARS characters (code points, matching Postgres' left()). */
export function truncateCell(value: string): { value: string; truncated: boolean } {
    // Cheap exit: UTF-16 length never undercounts code points.
    if (value.length <= CELL_MAX_CHARS) return { value, truncated: false };
    const codePoints = Array.from(value);
    if (codePoints.length <= CELL_MAX_CHARS) return { value, truncated: false };
    return { value: codePoints.slice(0, CELL_MAX_CHARS).join(""), truncated: true };
}

/**
 * Reads one page of rows from a table/view/materialized view in a single READ ONLY round trip (plus one more to
 * look up the relation when it isn't in the catalog cache). Always rolls back, so it cannot change anything.
 * Returns the catalog entry it used so the caller can cache it.
 */
export async function fetchTableRows(client: Queryable, args: FetchTableRowsArgs): Promise<{ page: TableDataPage; meta: RelationMeta }> {
    const meta = args.meta ?? (await loadRelationMeta(client, args.schema, args.table));
    if (!meta) throw new DataRequestError(`Table or view "${args.schema}"."${args.table}" was not found`);

    const columns: RelationColumn[] = meta.columns.map((column) => ({ ...column, isPrimaryKey: meta.primaryKey.includes(column.name) }));

    const query = buildRowsQuery({
        schema: meta.schema,
        table: meta.name,
        columns,
        relkind: meta.relkind,
        pkColumns: meta.primaryKey,
        sort: args.sort,
        dir: args.dir,
        limit: args.limit,
        offset: args.offset,
    });

    const statements = [query.text];
    if (args.exactCount) statements.push(`SELECT count(*)::text AS total FROM ${quoteIdent(meta.schema)}.${quoteIdent(meta.name)}`);

    const [dataResult, countResult] = await runReadOnly(client, statements);

    const truncatedCells: [number, number][] = [];
    const rows = (dataResult.rows as Record<string, string | null>[]).map((row, rowIndex) =>
        columns.map((_, columnIndex) => {
            const cell = row[`c${columnIndex}`];
            if (cell === null || cell === undefined) return null;
            const { value, truncated } = truncateCell(cell);
            if (truncated) truncatedCells.push([rowIndex, columnIndex]);
            return value;
        }),
    );

    const exactTotal = countResult ? Number((countResult.rows[0] as { total: string }).total) : undefined;

    const page: TableDataPage = {
        columns,
        rows,
        truncatedCells,
        estimatedTotal: meta.estimatedRows,
        ...(exactTotal !== undefined ? { exactTotal } : {}),
        limit: query.limit,
        offset: query.offset,
        sort: args.sort ?? null,
        dir: args.sort !== undefined ? (args.dir === "desc" ? "desc" : "asc") : null,
    };

    return { page, meta };
}
