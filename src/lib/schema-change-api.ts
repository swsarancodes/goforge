/** What the Schema Change page asks of the API (see server/src/routes/schema-change.ts and ai-governance.ts). */

export class ApiError extends Error {
    constructor(message: string, public status: number, public code?: string) {
        super(message);
        this.name = "ApiError";
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
    if (!response.ok) {
        let message = response.statusText;
        let code: string | undefined;
        try {
            const body = await response.json();
            if (typeof body?.error === "string") message = body.error;
            if (typeof body?.code === "string") code = body.code;
            const fields = body?.details?.fieldErrors;
            if (fields && typeof fields === "object") {
                const details = Object.entries(fields).flatMap(([name, value]) => (Array.isArray(value) ? value.map((text) => `${name}: ${text}`) : [])).slice(0, 3);
                if (details.length > 0) message = `${message} (${details.join("; ")})`;
            }
        } catch {
            // keep the status text
        }
        throw new ApiError(message || "The request failed", response.status, code);
    }
    return response.json() as Promise<T>;
}

// ---- tables and scope -------------------------------------------------------------------------------------------------------

export interface CatalogTable {
    qualified: string;
    schema: string;
    name: string;
    partitioned: boolean;
    partitionCount: number;
    estimatedRows: number | null;
    totalBytes: number;
    columns: number;
    foreignKeys: number;
}

export interface CatalogResponse {
    serverVersion: string;
    loadedAt: string;
    tables: CatalogTable[];
}

export type ScopeReason =
    | { kind: "name"; words: string[] }
    | { kind: "column"; columns: string[] }
    | { kind: "referenced-by"; from: string }
    | { kind: "references"; from: string };

export interface ScopedTable {
    qualified: string;
    origin: "match" | "neighbour";
    reasons: ScopeReason[];
}

export interface ScopeResponse {
    tables: ScopedTable[];
    totalTables: number;
    matched: number;
    truncated: boolean;
    searchMs: number;
}

export const fetchCatalog = (connectionId: string, refresh = false, signal?: AbortSignal) =>
    request<CatalogResponse>(`/api/connections/${connectionId}/schema-change/catalog${refresh ? "?refresh=1" : ""}`, { signal });

export const fetchScope = (connectionId: string, prompt: string, signal?: AbortSignal) =>
    request<ScopeResponse>(`/api/connections/${connectionId}/schema-change/scope`, { method: "POST", body: JSON.stringify({ prompt }), signal });

// ---- the plan -----------------------------------------------------------------------------------------------------------------

export type Risk = "low" | "medium" | "high";
export type Work = "none" | "metadata" | "scan" | "index-build" | "rewrite" | "backfill";

export interface RunbookStep {
    id: number;
    operation: number | null;
    title: string;
    sql: string;
    lock: string;
    alsoLocks: string[];
    work: Work;
    risk: Risk;
    reason: string;
    table: string | null;
    sizeClass: "new" | "small" | "medium" | "large";
    tableBytes: number | null;
    tableRows: number | null;
    notes: string[];
    destructive: boolean;
    breaksClients: boolean;
    optional: boolean;
    undo?: string;
}

export interface Finding {
    severity: "error" | "warning" | "info";
    code: string;
    message: string;
    operation?: number;
    table?: string;
}

export interface Runbook {
    steps: RunbookStep[];
    findings: Finding[];
    script: string;
    uncompiled: number[];
    server: { version: string; collectedAt: string };
    settings: { lockTimeoutSeconds: number; lockAttempts: number; backfillBatchRows: number; backfillPauseMs: number; defaultSchema: string };
}

export interface LintViolation {
    rule: string;
    step: number;
    message: string;
    statement: string;
}

export interface PlanOperation {
    type: string;
    [key: string]: unknown;
}

export interface PlanResponse {
    plan: { summary: string; assumptions: string[]; warnings: string[]; clarifyingQuestions: string[]; operations: PlanOperation[] };
    runbook: Runbook | null;
    lint: { violations: LintViolation[]; statements: number } | null;
    findings: Finding[];
    model: string;
    attempts: number;
    usage: { inputTokens: number | null; outputTokens: number | null };
    auditIds: number[];
    auditId: number;
    redacted: boolean;
    /** The existing tables that were read for this plan: the ones chosen or found, then any the plan turned out to refer to. */
    scope: string[];
    /** The part of `scope` that was not chosen but that the plan refers to; read to check the plan. */
    expandedTables: string[];
    omittedTables: number;
    requestChars: number;
    modelLatencyMs: number;
    summary: { steps: number; byRisk: Record<Risk, number>; rewrites: number; destructive: number; optional: number } | null;
}

export const requestPlan = (connectionId: string, body: { prompt: string; tables?: string[]; redact?: boolean }, signal?: AbortSignal) =>
    request<PlanResponse>(`/api/connections/${connectionId}/schema-change/plan`, { method: "POST", body: JSON.stringify(body), signal });

// ---- health ---------------------------------------------------------------------------------------------------------------------

export type Detail = Record<string, string | number | boolean | null | string[]>;

export interface HealthFinding {
    id: string;
    category: string;
    table: string | null;
    object: string | null;
    summary: string;
    detail: Detail;
    bytes: number | null;
}

export interface HealthReport {
    generatedAt: string;
    serverVersion: string;
    statsResetAt: string | null;
    tables: number;
    categories: { category: string; label: string; why: string; count: number; shown: number }[];
    findings: HealthFinding[];
    largest: { table: string; bytes: number; rows: number | null }[];
    thresholds: Record<string, number>;
    limits: string[];
}

export interface HealthSummary {
    headline: string;
    priorities: { findingIds: string[]; why: string }[];
    droppedIds: number;
    model: string;
    auditId: number;
    redacted: boolean;
}

export const fetchHealth = (connectionId: string, signal?: AbortSignal) => request<HealthReport>(`/api/connections/${connectionId}/schema-change/health`, { signal });

export const fetchHealthSummary = (connectionId: string, redact?: boolean, signal?: AbortSignal) =>
    request<{ summary: HealthSummary; generatedAt: string }>(`/api/connections/${connectionId}/schema-change/health/summary`, { method: "POST", body: JSON.stringify(redact === undefined ? {} : { redact }), signal });

// ---- governance ---------------------------------------------------------------------------------------------------------------

export interface AiSettings {
    /** An OpenAI model id; empty means OPENAI_MODEL from server/.env, else gpt-5.6-luna. */
    model: string;
    timeoutMs: number;
    allowedModels: string[];
    redactNames: boolean;
    updatedAt: string | null;
}

export interface AiStatus {
    configured: boolean;
    provider: "openai";
    model: string;
    modelFrom: "settings" | "env" | "default";
    /** The host requests go to. */
    endpointHost: string;
    credentials: "found" | "missing";
    credentialsSource: string | null;
    allowed: boolean;
    /** The first thing that stops a request, in words; null when one can be made. */
    problem: string | null;
    redactNames: boolean;
}

export type AiSettingsPatch = Partial<Omit<AiSettings, "updatedAt">>;

export interface OpenAiModel {
    id: string;
    owner: string;
}

export const fetchAiStatus = (signal?: AbortSignal) => request<AiStatus>("/api/ai/status", { signal });
export const fetchAiSettings = (signal?: AbortSignal) => request<{ settings: AiSettings; status: AiStatus }>("/api/ai/settings", { signal });
export const saveAiSettings = (patch: AiSettingsPatch) => request<{ settings: AiSettings; status: AiStatus }>("/api/ai/settings", { method: "PUT", body: JSON.stringify(patch) });
export const testAiSettings = () => request<{ ok: boolean; model?: string; endpointHost?: string; latencyMs?: number; error?: string }>("/api/ai/settings/test", { method: "POST" });
export const fetchOpenAiModels = (signal?: AbortSignal) => request<{ models: OpenAiModel[]; error?: string }>("/api/ai/openai/models", { signal });

export interface AuditEntry {
    id: number;
    at: string;
    kind: "model-call" | "plan" | "runbook-opened" | "settings-changed";
    purpose: string;
    status: "ok" | "error" | "blocked";
    connectionId?: string | null;
    connectionName?: string | null;
    provider?: string;
    model?: string;
    endpointHost?: string;
    redacted?: boolean;
    requestChars?: number;
    requestTokensEstimate?: number;
    responseChars?: number;
    usageInputTokens?: number | null;
    usageOutputTokens?: number | null;
    latencyMs?: number;
    error?: string | null;
    parentId?: number | null;
    sha256?: string | null;
    detail?: Record<string, unknown> | null;
    hasPayload?: boolean;
    payload?: string | null;
    response?: string | null;
}

export const fetchAudit = (limit = 200, signal?: AbortSignal) => request<{ entries: AuditEntry[] }>(`/api/ai/audit?limit=${limit}`, { signal });
export const fetchAuditEntry = (id: number, signal?: AbortSignal) => request<AuditEntry>(`/api/ai/audit/${id}`, { signal });
export const auditExportUrl = (format: "json" | "csv") => `/api/ai/audit?limit=5000&format=${format}${format === "json" ? "&payload=1&download=1" : ""}`;
export const recordHandoff = (body: { parentId: number | null; connectionId: string; connectionName: string; steps: number; tables: string[] }) =>
    request<{ id: number }>("/api/ai/audit/handoff", { method: "POST", body: JSON.stringify(body) });
