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
    columns: IntrospectedColumn[];
    primaryKeyColumns: string[];
    uniqueConstraints: { name: string; columns: string[] }[];
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

export interface IntrospectedEnum {
    name: string;
    values: string[];
}

export interface IntrospectionResult {
    tables: IntrospectedTable[];
    foreignKeys: IntrospectedForeignKey[];
    indexes: IntrospectedIndex[];
    enums: IntrospectedEnum[];
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
            message = body?.error ? JSON.stringify(body.error) : message;
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
