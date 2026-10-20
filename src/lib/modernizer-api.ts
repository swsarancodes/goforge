/** What the Query Modernizer asks of a live connection (see server/src/routes/modernizer.ts). */

export interface CheckedError {
    message: string;
    code?: string;
    /** 1-based offset into the SQL that was checked. */
    position?: number;
    detail?: string;
    hint?: string;
}

export interface StatementCheck {
    index: number;
    /** The start of the statement. */
    sql: string;
    status: "accepted" | "rejected" | "skipped";
    error?: CheckedError;
    /** The words of the statement around the error. */
    excerpt?: string;
    reason?: string;
}

export interface ValidationResponse {
    status: "accepted" | "rejected" | "skipped";
    statements: StatementCheck[];
    elapsedMs: number;
}

export interface PreviewResult {
    command: string;
    rowCount: number | null;
    columns: { name: string; dataType: string }[];
    rows: (string | null)[][];
    /** There were more rows than were returned. */
    truncated: boolean;
    truncatedCells: [number, number][];
}

export type PreviewResponse = { ok: true; result: PreviewResult; elapsedMs: number } | { ok: false; error: CheckedError; elapsedMs: number };

async function post<T>(connectionId: string, path: string, sql: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`/api/connections/${connectionId}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }), signal });
    if (!response.ok) {
        let message = response.statusText;
        try {
            const body = await response.json();
            if (typeof body?.error === "string") message = body.error;
        } catch {
            // keep the status text
        }
        throw new Error(message || "The request failed");
    }
    return response.json() as Promise<T>;
}

/** Does PostgreSQL accept this SQL against this connection's tables and functions? Nothing is run. */
export const validateSqlOnConnection = (connectionId: string, sql: string, signal?: AbortSignal): Promise<ValidationResponse> => post(connectionId, "validate-sql", sql, signal);

/** The first 100 rows of a single SELECT, read-only. */
export const previewQueryOnConnection = (connectionId: string, sql: string, signal?: AbortSignal): Promise<PreviewResponse> => post(connectionId, "query-preview", sql, signal);
