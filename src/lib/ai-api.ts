import { AiSchemaContext, AiSchemaPlanResponse } from "@/lib/ai-schema";
import type { AiConversion, LegacyDialect, SchemaContext } from "@/features/query-modernizer/types";

class AiApiError extends Error {
    constructor(message: string, public status: number) {
        super(message);
        this.name = "AiApiError";
    }
}

async function errorFromResponse(response: Response, fallback: string): Promise<AiApiError> {
    let message = response.statusText;
    try {
        const body = await response.json();
        message = typeof body?.error === "string" ? body.error : message;
        const fieldErrors = body?.details?.fieldErrors;
        if (fieldErrors && typeof fieldErrors === "object") {
            const details = Object.values(fieldErrors)
                .flatMap((value) => (Array.isArray(value) ? value : []))
                .filter((value): value is string => typeof value === "string")
                .slice(0, 3);
            if (details.length > 0) message = `${message}: ${details.join("; ")}`;
        }
    } catch {
        // Keep the HTTP status text when the response body is not JSON.
    }
    return new AiApiError(message || fallback, response.status);
}

export async function requestAiSchemaPlan(
    context: AiSchemaContext,
    signal?: AbortSignal,
): Promise<AiSchemaPlanResponse> {
    const response = await fetch("/api/ai/schema-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context),
        signal,
    });

    if (!response.ok) throw await errorFromResponse(response, "AI schema planning failed");

    return response.json() as Promise<AiSchemaPlanResponse>;
}

export interface AiStatus {
    configured: boolean;
    model: string;
}

/** Whether the API has a model key configured (never the key itself). */
export async function fetchAiStatus(signal?: AbortSignal): Promise<AiStatus> {
    const response = await fetch("/api/ai/status", { signal });
    if (!response.ok) throw await errorFromResponse(response, "Could not read the AI status");
    return response.json() as Promise<AiStatus>;
}

export interface QueryModernizationRequest {
    legacySql: string;
    sourceDialect: LegacyDialect;
    /** Table and column names only. */
    schema?: SchemaContext;
    /** What the rules produced, what they could not do, and what PostgreSQL said about the last answer. */
    draft?: { sql: string; changes: string[]; notConverted: { construct: string; reason: string }[]; postgresError?: string };
}

export async function requestQueryModernization(request: QueryModernizationRequest, signal?: AbortSignal): Promise<{ result: AiConversion; model: string }> {
    const response = await fetch("/api/ai/modernize-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, schema: request.schema && { databaseName: request.schema.databaseName, dialect: request.schema.dialect, tables: request.schema.tables.map((table) => ({ name: table.name, columns: table.columns.map((c) => ({ name: c.name, type: c.type, isPrimary: c.isPrimary, isUnique: c.isUnique })) })) } }),
        signal,
    });
    if (!response.ok) throw await errorFromResponse(response, "AI conversion failed");
    return response.json() as Promise<{ result: AiConversion; model: string }>;
}
