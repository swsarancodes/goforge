import type { AuditEntry } from "./provider.js";

/** The audit log as a file someone can hand to a reviewer. Entries never contain the API key; the payload column is the exact request that left the server. */

const COLUMNS = [
    "id", "at", "kind", "purpose", "status", "connection", "provider", "model", "endpoint_host", "names_redacted", "request_chars", "request_tokens_estimate",
    "usage_input_tokens", "usage_output_tokens", "latency_ms", "error", "follows_entry", "payload_sha256", "detail",
] as const;

/** A cell that starts with = + - @ is read as a formula by spreadsheet programs; a leading quote makes it text. */
const guard = (value: string): string => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

const cell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = guard(typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value));
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function auditToCsv(entries: AuditEntry[]): string {
    const rows = entries.map((entry) => [
        entry.id, entry.at, entry.kind, entry.purpose, entry.status, entry.connectionName ?? entry.connectionId, entry.provider, entry.model, entry.endpointHost, entry.redacted ? "yes" : "no",
        entry.requestChars, entry.requestTokensEstimate, entry.usageInputTokens, entry.usageOutputTokens, entry.latencyMs, entry.error, entry.parentId, entry.sha256, entry.detail,
    ]);
    return [COLUMNS.join(","), ...rows.map((row) => row.map(cell).join(","))].join("\r\n") + "\r\n";
}

/** The entry without the (large) payload and response, for lists. */
export const withoutBodies = (entry: AuditEntry): Omit<AuditEntry, "payload" | "response"> & { hasPayload: boolean } => {
    const { payload, response, ...rest } = entry;
    return { ...rest, hasPayload: Boolean(payload || response) };
};
