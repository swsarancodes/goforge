export interface SavedConnection {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    database: string;
    sslMode: "disable" | "allow" | "require" | "verify-full";
    createdAt: string;
    updatedAt: string;
}

export interface CreateConnectionInput {
    name: string;
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    sslMode: SavedConnection["sslMode"];
}

export interface IntrospectedColumn {
    name: string;
    ordinalPosition: number;
    udtName: string;
    maxLength: number | null;
    numericPrecision: number | null;
    numericScale: number | null;
    nullable: boolean;
    defaultValue: string | null;
    isIdentity: boolean;
    isSerial: boolean;
}

export interface IntrospectedTable {
    name: string;
    namespace?: string | null;
    columns: IntrospectedColumn[];
    primaryKeyColumns: string[];
    uniqueConstraints: { name: string; columns: string[] }[];
    // Optional: servers from before CHECK support do not send it.
    checkConstraints?: { name: string; expression: string }[];
}

export interface IntrospectedForeignKey {
    constraintName: string;
    sourceTable: string;
    sourceColumn: string;
    targetTable: string;
    targetColumn: string;
    onUpdate: string;
    onDelete: string;
}

export interface IntrospectedIndex {
    tableName: string;
    indexName: string;
    isUnique: boolean;
    isPrimary: boolean;
    columns: string[];
}

export interface IntrospectedView {
    name: string;
    namespace?: string | null;
    materialized: boolean;
    definition: string;
}

export interface IntrospectedSequence {
    name: string;
    namespace?: string | null;
    definition: string;
}

export interface IntrospectedEnum {
    name: string;
    values: string[];
}

export interface IntrospectionResult {
    tables: IntrospectedTable[];
    foreignKeys: IntrospectedForeignKey[];
    indexes: IntrospectedIndex[];
    enums: IntrospectedEnum[];
    views?: IntrospectedView[];
    sequences?: IntrospectedSequence[];
}

class LiveConnectionApiError extends Error {
    constructor(message: string, public status: number) {
        super(message);
        this.name = "LiveConnectionApiError";
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`/api/connections${path}`, {
        headers: { "Content-Type": "application/json" },
        ...init,
    });

    if (!res.ok) {
        let message = res.statusText;
        try {
            const body = await res.json();
            if (body?.error) message = typeof body.error === "string" ? body.error : JSON.stringify(body.error);
        } catch {
            // response body wasn't JSON - fall back to statusText
        }
        throw new LiveConnectionApiError(message, res.status);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
}

export function listSavedConnections(): Promise<SavedConnection[]> {
    return request("/");
}

export function createSavedConnection(input: CreateConnectionInput): Promise<SavedConnection> {
    return request("/", { method: "POST", body: JSON.stringify(input) });
}

export function deleteSavedConnection(id: string): Promise<void> {
    return request(`/${id}`, { method: "DELETE" });
}

export function testSavedConnection(id: string): Promise<{ ok: boolean; error?: string }> {
    return request(`/${id}/test`, { method: "POST" });
}

export function introspectSavedConnection(id: string): Promise<IntrospectionResult> {
    return request(`/${id}/introspect`);
}

export function previewSql(id: string, sql: string): Promise<{ valid: boolean; error?: string }> {
    return request(`/${id}/preview`, { method: "POST", body: JSON.stringify({ sql }) });
}

export function executeSql(id: string, sql: string): Promise<{ success: boolean; statementsRun: number }> {
    return request(`/${id}/execute`, { method: "POST", body: JSON.stringify({ sql }) });
}

export interface TableDataColumn {
    name: string;
    /** Postgres format_type() output, e.g. "numeric(30,10)", "jsonb", "integer[]". */
    dataType: string;
    isPrimaryKey: boolean;
}

export interface TableDataPage {
    columns: TableDataColumn[];
    /** Every cell is the column's `::text` form; SQL NULL is null. */
    rows: (string | null)[][];
    /** [rowIndex, columnIndex] of cells cut short by the server. */
    truncatedCells: [number, number][];
    estimatedTotal: number | null;
    exactTotal?: number;
    limit: number;
    offset: number;
    sort: string | null;
    dir: "asc" | "desc" | null;
}

export interface FetchTableRowsParams {
    schema: string;
    table: string;
    limit?: number;
    offset?: number;
    sort?: string;
    dir?: "asc" | "desc";
    exactCount?: boolean;
    /** Ask the server to re-read the table's columns instead of using its cached catalog entry. */
    refresh?: boolean;
}

export function fetchTableRows(id: string, params: FetchTableRowsParams): Promise<TableDataPage> {
    const query = new URLSearchParams({ schema: params.schema, table: params.table });
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));
    if (params.sort) {
        query.set("sort", params.sort);
        query.set("dir", params.dir ?? "asc");
    }
    if (params.exactCount) query.set("count", "exact");
    if (params.refresh) query.set("refresh", "1");
    return request(`/${id}/data?${query.toString()}`);
}

export type RelationKind = "table" | "view" | "materialized view" | "foreign table";

/** One browsable table, view or materialized view. Columns stay on the server; the page only lists names. */
export interface RelationInfo {
    schema: string;
    name: string;
    kind: RelationKind;
    /** Planner's row estimate; null when unknown (views, tables that were never analyzed). */
    estimatedRows: number | null;
}

/** Every table and view of a saved connection, in one round trip (much lighter than a full introspection). */
export async function fetchRelations(id: string): Promise<RelationInfo[]> {
    const result = await request<{ relations: RelationInfo[] }>(`/${id}/relations`);
    return result.relations;
}

/** Opens (or keeps open) the API's pooled connection so the next table click doesn't wait for the handshake. */
export function warmConnection(id: string): Promise<{ ok: boolean; ms?: number }> {
    return request(`/${id}/warm`, { method: "POST" });
}
