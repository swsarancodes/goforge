import { settingsFromStored, type AiSettings } from "../ai/policy.js";
import type { AuditEntry, AuditStore, NewAuditEntry, SettingsStore } from "../ai/provider.js";
import { getDb } from "./store.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL,
    key_ciphertext BLOB,
    key_iv BLOB,
    key_auth_tag BLOB,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    purpose TEXT NOT NULL,
    status TEXT NOT NULL,
    connection_id TEXT,
    connection_name TEXT,
    provider TEXT,
    model TEXT,
    endpoint_host TEXT,
    redacted INTEGER NOT NULL DEFAULT 0,
    request_chars INTEGER,
    request_tokens_estimate INTEGER,
    response_chars INTEGER,
    usage_input_tokens INTEGER,
    usage_output_tokens INTEGER,
    latency_ms INTEGER,
    error TEXT,
    parent_id INTEGER,
    payload TEXT,
    sha256 TEXT,
    response TEXT,
    detail TEXT
  );
`;

let schemaReady = false;
/** The SQLite file with the AI tables in place; opened and created the first time it is needed. */
const db = () => {
    const database = getDb();
    if (!schemaReady) {
        database.exec(SCHEMA);
        schemaReady = true;
    }
    return database;
};

/** Newest entries kept; older ones are deleted as new ones arrive. */
export const AUDIT_RETENTION = 5000;

class SqliteSettings implements SettingsStore {
    read() {
        const row = db().prepare("SELECT json FROM ai_settings WHERE id = 1").get() as { json: string } | undefined;
        return { settings: settingsFromStored(row ? (JSON.parse(row.json) as Record<string, unknown>) : {}) };
    }

    /** Models are called with the OpenAI key from the environment, so no key is stored; one saved by an earlier version is erased here. */
    write(settings: AiSettings) {
        db().prepare(
            `INSERT INTO ai_settings (id, json, key_ciphertext, key_iv, key_auth_tag, updated_at) VALUES (1, @json, NULL, NULL, NULL, @updatedAt)
             ON CONFLICT(id) DO UPDATE SET json = @json, key_ciphertext = NULL, key_iv = NULL, key_auth_tag = NULL, updated_at = @updatedAt`,
        ).run({ json: JSON.stringify({ ...settings, updatedAt: undefined }), updatedAt: new Date().toISOString() });
    }
}

interface AuditRow {
    id: number;
    at: string;
    kind: AuditEntry["kind"];
    purpose: string;
    status: AuditEntry["status"];
    connection_id: string | null;
    connection_name: string | null;
    provider: string | null;
    model: string | null;
    endpoint_host: string | null;
    redacted: number;
    request_chars: number | null;
    request_tokens_estimate: number | null;
    response_chars: number | null;
    usage_input_tokens: number | null;
    usage_output_tokens: number | null;
    latency_ms: number | null;
    error: string | null;
    parent_id: number | null;
    payload: string | null;
    sha256: string | null;
    response: string | null;
    detail: string | null;
}

const toEntry = (row: AuditRow): AuditEntry => ({
    id: row.id,
    at: row.at,
    kind: row.kind,
    purpose: row.purpose,
    status: row.status,
    connectionId: row.connection_id,
    connectionName: row.connection_name,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    endpointHost: row.endpoint_host ?? undefined,
    redacted: row.redacted === 1,
    requestChars: row.request_chars ?? undefined,
    requestTokensEstimate: row.request_tokens_estimate ?? undefined,
    responseChars: row.response_chars ?? undefined,
    usageInputTokens: row.usage_input_tokens,
    usageOutputTokens: row.usage_output_tokens,
    latencyMs: row.latency_ms ?? undefined,
    error: row.error,
    parentId: row.parent_id,
    payload: row.payload,
    sha256: row.sha256,
    response: row.response,
    detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : null,
});

class SqliteAudit implements AuditStore {
    record(entry: NewAuditEntry): number {
        const result = db()
            .prepare(
                `INSERT INTO ai_audit (at, kind, purpose, status, connection_id, connection_name, provider, model, endpoint_host, redacted, request_chars, request_tokens_estimate, response_chars,
                                       usage_input_tokens, usage_output_tokens, latency_ms, error, parent_id, payload, sha256, response, detail)
                 VALUES (@at, @kind, @purpose, @status, @connectionId, @connectionName, @provider, @model, @endpointHost, @redacted, @requestChars, @requestTokensEstimate, @responseChars,
                         @usageInputTokens, @usageOutputTokens, @latencyMs, @error, @parentId, @payload, @sha256, @response, @detail)`,
            )
            .run({
                at: new Date().toISOString(),
                kind: entry.kind,
                purpose: entry.purpose,
                status: entry.status,
                connectionId: entry.connectionId ?? null,
                connectionName: entry.connectionName ?? null,
                provider: entry.provider ?? null,
                model: entry.model ?? null,
                endpointHost: entry.endpointHost ?? null,
                redacted: entry.redacted ? 1 : 0,
                requestChars: entry.requestChars ?? null,
                requestTokensEstimate: entry.requestTokensEstimate ?? null,
                responseChars: entry.responseChars ?? null,
                usageInputTokens: entry.usageInputTokens ?? null,
                usageOutputTokens: entry.usageOutputTokens ?? null,
                latencyMs: entry.latencyMs ?? null,
                error: entry.error ?? null,
                parentId: entry.parentId ?? null,
                payload: entry.payload ?? null,
                sha256: entry.sha256 ?? null,
                response: entry.response ?? null,
                detail: entry.detail ? JSON.stringify(entry.detail) : null,
            });
        const id = Number(result.lastInsertRowid);
        db().prepare("DELETE FROM ai_audit WHERE id <= ?").run(id - AUDIT_RETENTION);
        return id;
    }

    list(options: { limit?: number; sinceId?: number } = {}): AuditEntry[] {
        const rows = db().prepare("SELECT * FROM ai_audit WHERE id > ? ORDER BY id DESC LIMIT ?").all(options.sinceId ?? 0, Math.min(options.limit ?? 200, AUDIT_RETENTION)) as AuditRow[];
        return rows.map(toEntry);
    }

    get(id: number): AuditEntry | undefined {
        const row = db().prepare("SELECT * FROM ai_audit WHERE id = ?").get(id) as AuditRow | undefined;
        return row ? toEntry(row) : undefined;
    }
}

export const createSqliteAiStores = () => ({ settings: new SqliteSettings(), audit: new SqliteAudit() });
