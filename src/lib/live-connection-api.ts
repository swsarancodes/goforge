export interface SavedConnection {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    database: string;
    sslMode: "disable" | "allow" | "require" | "verify-full";
    /** `cloud` for a database GoForge created for the account on its own server; deleting that connection deletes the database. */
    kind?: "external" | "cloud";
    createdAt: string;
    updatedAt: string;
}

/**
 * What a connection is called in a picker: its name, nothing else. Only when two saved connections have the same name is the
 * database added, so two lines never read the same. The full address is for a tooltip (`connectionAddress`).
 */
export function connectionLabel(connection: Pick<SavedConnection, "id" | "name" | "database">, all: Pick<SavedConnection, "id" | "name">[]): string {
    const clash = all.some((other) => other.id !== connection.id && other.name.trim().toLowerCase() === connection.name.trim().toLowerCase());
    return clash ? `${connection.name} · ${connection.database}` : connection.name;
}

export const connectionAddress = (connection: Pick<SavedConnection, "username" | "host" | "port" | "database">): string =>
    `${connection.username}@${connection.host}:${connection.port}/${connection.database}`;

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

export function renameSavedConnection(id: string, name: string): Promise<SavedConnection> {
    return request(`/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export function deleteSavedConnection(id: string, options: { dropDatabase?: boolean } = {}): Promise<void> {
    return request(`/${id}${options.dropDatabase ? "?dropDatabase=true" : ""}`, { method: "DELETE" });
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

export interface CreateLiveDatabaseInput {
    /** The new database's name. */
    database: string;
    /** What the saved connection to it is called; the database name when left out. */
    name?: string;
    /** The schema script to build in it. */
    sql: string;
}

/**
 * Creates a new database on the server a saved connection points at, builds `sql` in it as one transaction, and saves a connection to
 * it. The returned connection is listed everywhere connections are.
 */
export function createLiveDatabase(serverConnectionId: string, input: CreateLiveDatabaseInput): Promise<{ connection: SavedConnection; statementsRun: number }> {
    return request(`/${serverConnectionId}/create-database`, { method: "POST", body: JSON.stringify(input) });
}

/**
 * Creates a database for the signed-in account on the GoForge server (no server to choose, no credentials to know), builds `sql` in it,
 * and saves a connection to it. Only with accounts on.
 */
export async function createCloudDatabase(input: { name: string; sql: string }): Promise<{ connection: SavedConnection; statementsRun: number }> {
    const response = await fetch("/api/cloud-databases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    if (!response.ok) {
        let message = response.statusText || `HTTP ${response.status}`;
        try {
            const body = await response.json();
            if (typeof body?.error === "string") message = body.error;
        } catch {
            // not JSON
        }
        throw new LiveConnectionApiError(message, response.status);
    }
    return response.json();
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
