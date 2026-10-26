import type oracledb from "oracledb";
import { oracledb as driver } from "./oracle-client.js";
import { CELL_MAX_CHARS, DEFAULT_LIMIT, MAX_LIMIT, truncateCell, type RelationColumn, type SortDirection, type TableDataPage } from "./pg-data.js";
import { DataRequestError } from "./pg-sql.js";
import type { RelationKind } from "./pg-relations.js";

/**
 * The Data page for an Oracle database: the tables and views of the schema the connection logs in as, and a page of rows of one of them.
 * Nothing here writes: the only statements are SELECTs built here, identifiers come from the catalog and are quoted, and the page size and
 * offset are validated integers, so the statement carries no bound values. (A READ ONLY transaction would also refuse a table created a
 * moment ago with ORA-01466, which is exactly when someone opens the page.)
 */

export interface OracleRelation {
    schema: string;
    name: string;
    kind: RelationKind;
    /** NUM_ROWS from the optimizer statistics, or an exact count for a small table that has none; null when unknown. */
    estimatedRows: number | null;
}

export interface OracleRelationMeta extends OracleRelation {
    columns: { name: string; dataType: string; type: string }[];
    primaryKey: string[];
}

/** A table with no statistics is counted, up to this many rows; past that the size is left unknown rather than guessed. */
const COUNT_CAP = 100_000;
/** Counting is a read of the table, so a schema with many unanalyzed tables is not counted table by table. */
const COUNT_MAX_TABLES = 200;

export const quoteOracleIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

type Row = Record<string, unknown>;

const rowsOf = async (connection: oracledb.Connection, sql: string, binds: oracledb.BindParameters = []): Promise<Row[]> => {
    const result = await connection.execute(sql, binds, { outFormat: driver.OUT_FORMAT_OBJECT, maxRows: 100_000 });
    return (result.rows ?? []) as Row[];
};

/** How a column's type reads in the grid header: `NUMBER(10)`, `VARCHAR2(100)`, `DATE`. */
export function describeOracleType(column: { type: string; length: number | null; charLength: number | null; precision: number | null; scale: number | null }): string {
    const type = column.type;
    if (type === "NUMBER") {
        if (column.precision === null) return column.scale === null ? "NUMBER" : `NUMBER(*,${column.scale})`;
        return column.scale ? `NUMBER(${column.precision},${column.scale})` : `NUMBER(${column.precision})`;
    }
    if (/^(VARCHAR2|NVARCHAR2|CHAR|NCHAR)$/.test(type)) return `${type}(${column.charLength || column.length})`;
    if (type === "RAW") return `RAW(${column.length})`;
    return type;
}

/** The SQL that returns this column's value as text (TM9 writes 0.5 as ".5", so a missing leading zero is put back), cut to CELL_MAX_CHARS + 1 characters so a huge value cannot bloat the page. */
export function textExpression(column: { name: string; type: string }): string {
    const id = quoteOracleIdent(column.name);
    const type = column.type.toUpperCase();
    const cap = CELL_MAX_CHARS + 1;
    if (type === "NUMBER" || type === "FLOAT" || type === "BINARY_FLOAT" || type === "BINARY_DOUBLE") return `REGEXP_REPLACE(TO_CHAR(${id}, 'TM9'), '^(-?)\\.', '\\10.')`;
    if (type === "DATE") return `TO_CHAR(${id}, 'YYYY-MM-DD HH24:MI:SS')`;
    if (type.startsWith("TIMESTAMP")) return `TO_CHAR(${id}, '${/WITH TIME ZONE/.test(type) ? "YYYY-MM-DD HH24:MI:SS.FF TZR" : "YYYY-MM-DD HH24:MI:SS.FF"}')`;
    if (/^(VARCHAR2|NVARCHAR2|CHAR|NCHAR)$/.test(type)) return `SUBSTR(${id}, 1, ${cap})`;
    if (type === "CLOB" || type === "NCLOB") return `DBMS_LOB.SUBSTR(${id}, ${cap}, 1)`;
    if (type === "RAW") return `RAWTOHEX(${id})`;
    if (type === "BLOB") return `CASE WHEN ${id} IS NULL THEN NULL ELSE 'BLOB, ' || DBMS_LOB.GETLENGTH(${id}) || ' bytes' END`;
    if (type === "ROWID" || type === "UROWID" || type.startsWith("INTERVAL")) return `SUBSTR(TO_CHAR(${id}), 1, ${cap})`;
    return `CASE WHEN ${id} IS NULL THEN NULL ELSE '(${type.replace(/'/g, "")} not shown)' END`;
}

export function buildOracleRowsQuery(input: { schema: string; table: string; columns: { name: string; type: string }[]; pkColumns: string[]; kind: RelationKind; sort?: string; dir?: SortDirection; limit?: number; offset?: number }): { text: string; limit: number; offset: number } {
    const clamp = (value: number | undefined, fallback: number, min: number, max: number) => (value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value))));
    const limit = clamp(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clamp(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    if (input.columns.length === 0) throw new DataRequestError(`"${input.schema}"."${input.table}" has no columns to display`);
    if (input.sort !== undefined && !input.columns.some((column) => column.name === input.sort)) throw new DataRequestError(`Unknown sort column "${input.sort}"`);

    const select = input.columns.map((column, index) => `${textExpression(column)} AS "C${index}"`);
    const order: string[] = [];
    if (input.sort !== undefined) order.push(`${quoteOracleIdent(input.sort)} ${input.dir === "desc" ? "DESC" : "ASC"} NULLS LAST`);
    // Paging needs a stable order: the primary key, else the physical row id (a table has one, a view does not).
    const tieBreakers = input.pkColumns.length > 0 ? input.pkColumns.map(quoteOracleIdent) : input.kind === "table" ? ["ROWID"] : [];
    for (const tieBreaker of tieBreakers) if (input.sort === undefined || tieBreaker !== quoteOracleIdent(input.sort)) order.push(tieBreaker);

    const text = [`SELECT ${select.join(", ")}`, `FROM ${quoteOracleIdent(input.schema)}.${quoteOracleIdent(input.table)}`, order.length > 0 ? `ORDER BY ${order.join(", ")}` : "", `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`].filter(Boolean).join(" ");
    return { text, limit, offset };
}

/** Every table and view of the connection's own schema, with columns and primary key. */
export async function loadOracleRelations(connection: oracledb.Connection): Promise<OracleRelationMeta[]> {
    const schema = String((await rowsOf(connection, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS S FROM DUAL"))[0].S);
    const tables = await rowsOf(connection, "SELECT table_name AS N, num_rows AS R FROM user_tables WHERE table_name NOT LIKE 'BIN$%' AND secondary = 'N' AND temporary = 'N' ORDER BY table_name");
    const views = await rowsOf(connection, "SELECT view_name AS N FROM user_views ORDER BY view_name");
    const columns = await rowsOf(
        connection,
        "SELECT table_name AS T, column_name AS C, data_type AS D, data_length AS L, char_length AS CL, data_precision AS P, data_scale AS S FROM user_tab_cols WHERE hidden_column = 'NO' ORDER BY table_name, column_id",
    );
    const keys = await rowsOf(
        connection,
        "SELECT cc.table_name AS T, cc.column_name AS C FROM user_constraints c JOIN user_cons_columns cc ON cc.constraint_name = c.constraint_name WHERE c.constraint_type = 'P' ORDER BY cc.table_name, cc.position",
    );

    const byTable = new Map<string, OracleRelationMeta["columns"]>();
    for (const column of columns) {
        const list = byTable.get(String(column.T)) ?? [];
        const type = String(column.D);
        list.push({
            name: String(column.C),
            type,
            dataType: describeOracleType({ type, length: column.L as number | null, charLength: column.CL as number | null, precision: column.P as number | null, scale: column.S as number | null }),
        });
        byTable.set(String(column.T), list);
    }
    const keyOf = new Map<string, string[]>();
    for (const key of keys) keyOf.set(String(key.T), [...(keyOf.get(String(key.T)) ?? []), String(key.C)]);

    const out: OracleRelationMeta[] = [
        ...tables.map((table): OracleRelationMeta => ({ schema, name: String(table.N), kind: "table", estimatedRows: table.R === null ? null : Number(table.R), columns: byTable.get(String(table.N)) ?? [], primaryKey: keyOf.get(String(table.N)) ?? [] })),
        ...views.map((view): OracleRelationMeta => ({ schema, name: String(view.N), kind: "view", estimatedRows: null, columns: byTable.get(String(view.N)) ?? [], primaryKey: [] })),
    ];

    // A table nobody analyzed has no row estimate; for a small one the exact count is cheap and is what the list should say.
    const unknown = out.filter((relation) => relation.kind === "table" && relation.estimatedRows === null);
    if (unknown.length <= COUNT_MAX_TABLES) {
        for (const relation of unknown) {
            const counted = await rowsOf(connection, `SELECT COUNT(*) AS N FROM (SELECT 1 FROM ${quoteOracleIdent(relation.schema)}.${quoteOracleIdent(relation.name)} FETCH FIRST ${COUNT_CAP + 1} ROWS ONLY)`);
            const n = Number(counted[0].N);
            relation.estimatedRows = n > COUNT_CAP ? null : n;
        }
    }
    return out;
}

/** One page of rows of one table or view, every cell as text. */
export async function fetchOracleRows(
    connection: oracledb.Connection,
    args: { schema: string; table: string; sort?: string; dir?: SortDirection; limit?: number; offset?: number; exactCount?: boolean },
): Promise<TableDataPage> {
    const relations = await loadOracleRelations(connection);
    const meta = relations.find((relation) => relation.schema === args.schema && relation.name === args.table);
    if (!meta) throw new DataRequestError(`Table or view "${args.schema}"."${args.table}" was not found`);

    const columns: RelationColumn[] = meta.columns.map((column) => ({ name: column.name, dataType: column.dataType, isPrimaryKey: meta.primaryKey.includes(column.name) }));
    const query = buildOracleRowsQuery({ schema: meta.schema, table: meta.name, columns: meta.columns, pkColumns: meta.primaryKey, kind: meta.kind, sort: args.sort, dir: args.dir, limit: args.limit, offset: args.offset });

    const result = await connection.execute(query.text, [], { outFormat: driver.OUT_FORMAT_ARRAY, maxRows: query.limit });
    const truncatedCells: [number, number][] = [];
    const rows = ((result.rows ?? []) as (string | null)[][]).map((row, rowIndex) =>
        row.map((cell, columnIndex) => {
            if (cell === null || cell === undefined) return null;
            const { value, truncated } = truncateCell(String(cell));
            if (truncated) truncatedCells.push([rowIndex, columnIndex]);
            return value;
        }),
    );

    let exactTotal: number | undefined;
    if (args.exactCount) exactTotal = Number((await rowsOf(connection, `SELECT COUNT(*) AS N FROM ${quoteOracleIdent(meta.schema)}.${quoteOracleIdent(meta.name)}`))[0].N);

    return {
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
}
