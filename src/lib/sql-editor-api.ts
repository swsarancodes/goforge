export interface SqlColumn {
    name: string;
    dataType: string;
}

export interface SqlStatementResult {
    /** Command tag verb: SELECT, INSERT, CREATE, ... */
    command: string;
    rowCount: number | null;
    columns: SqlColumn[];
    /** Every cell is the value's text form; SQL NULL is null. */
    rows: (string | null)[][];
    /** More rows existed than were returned. */
    truncated: boolean;
    truncatedCells: [number, number][];
}

export interface SqlRunError {
    message: string;
    code?: string;
    /** 1-based offset into the SQL that was run. */
    position?: number;
    detail?: string;
    hint?: string;
}

export interface SqlTransaction {
    open: boolean;
    hasChanges: boolean;
    startedAt: number | null;
}

export type SqlRunResponse =
    | { ok: true; sessionId: string; results: SqlStatementResult[]; elapsedMs: number; transaction: SqlTransaction }
    | { ok: false; sessionId: string; error: SqlRunError; results: SqlStatementResult[]; elapsedMs: number; transaction: SqlTransaction; transactionLost?: boolean };

export interface SqlFinishResponse {
    ok: boolean;
    error?: SqlRunError;
    transaction: SqlTransaction;
}

/** The request itself failed (bad input, expired session, API down) - as opposed to the SQL failing, which is a normal response. */
export class SqlApiError extends Error {
    constructor(
        message: string,
        public status: number,
        public code?: string,
    ) {
        super(message);
        this.name = "SqlApiError";
    }
}

async function request<T>(connectionId: string, path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/connections/${connectionId}/sql${path}`, { headers: { "Content-Type": "application/json" }, ...init });

    if (!response.ok) {
        let message = response.statusText;
        let code: string | undefined;
        try {
            const body = await response.json();
            if (typeof body?.error === "string") message = body.error;
            if (typeof body?.code === "string") code = body.code;
        } catch {
            // keep the status text
        }
        throw new SqlApiError(message || "Request failed", response.status, code);
    }

    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export function runSql(connectionId: string, body: { sessionId: string; sql: string; transactional: boolean; expectOpenTransaction: boolean }): Promise<SqlRunResponse> {
    return request(connectionId, "/run", { method: "POST", body: JSON.stringify(body) });
}

export const commitSql = (connectionId: string, sessionId: string): Promise<SqlFinishResponse> => request(connectionId, `/sessions/${sessionId}/commit`, { method: "POST" });

export const rollbackSql = (connectionId: string, sessionId: string): Promise<SqlFinishResponse> => request(connectionId, `/sessions/${sessionId}/rollback`, { method: "POST" });

export const cancelSql = (connectionId: string, sessionId: string): Promise<{ cancelling: boolean }> => request(connectionId, `/sessions/${sessionId}/cancel`, { method: "POST" });

export const getSqlSession = (connectionId: string, sessionId: string): Promise<{ exists: boolean; transaction: SqlTransaction }> => request(connectionId, `/sessions/${sessionId}`);

export const closeSqlSession = (connectionId: string, sessionId: string): Promise<void> => request(connectionId, `/sessions/${sessionId}`, { method: "DELETE" });
