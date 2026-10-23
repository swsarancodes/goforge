import { settingsFromStored, type AiSettings } from "../ai/policy.js";
import type { AuditEntry, AuditStore, NewAuditEntry, SettingsStore } from "../ai/provider.js";
import type { AppDb, Queryable } from "./app-db.js";
import { AUDIT_RETENTION } from "./ai-store.js";
import {
    EmailTakenError,
    LOCAL_OWNER,
    type ConnectionRow,
    type ConnectionStore,
    type ProjectRecord,
    type ProjectStore,
    type ProjectSummary,
    type SessionStore,
    type UserRecord,
    type UserStore,
} from "./stores.js";

// pg and the in-process Postgres used by the tests return the same values in different shapes (Date or string, Buffer or Uint8Array,
// bigint as string or number); these read them one way.
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const num = (value: unknown): number => Number(value);
const bytes = (value: unknown): Buffer => Buffer.from(value as Uint8Array);

/** The account an owner id stands for; `local` (no account) is stored as no owner. */
const ownerOrNull = (ownerId: string | null | undefined): string | null => (!ownerId || ownerId === LOCAL_OWNER ? null : ownerId);

// ---- connections --------------------------------------------------------------------------------------------------------------------

interface ConnectionDbRow {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    database_name: string;
    ssl_mode: string;
    password_ciphertext: Uint8Array;
    password_iv: Uint8Array;
    password_auth_tag: Uint8Array;
    kind: "external" | "cloud";
    created_at: unknown;
    updated_at: unknown;
}

const toConnection = (row: ConnectionDbRow): ConnectionRow => ({
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    database_name: row.database_name,
    ssl_mode: row.ssl_mode,
    password_ciphertext: bytes(row.password_ciphertext),
    password_iv: bytes(row.password_iv),
    password_auth_tag: bytes(row.password_auth_tag),
    kind: row.kind,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
});

export function createPgConnectionStore(db: Queryable): ConnectionStore {
    return {
        async insert(ownerId, row) {
            await db.query(
                `INSERT INTO connections (id, owner_id, name, host, port, username, database_name, ssl_mode, password_ciphertext, password_iv, password_auth_tag, kind, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
                [row.id, ownerId, row.name, row.host, row.port, row.username, row.database_name, row.ssl_mode, row.password_ciphertext, row.password_iv, row.password_auth_tag, row.kind ?? "external", row.created_at, row.updated_at],
            );
        },
        async list(ownerId) {
            const result = await db.query<ConnectionDbRow>("SELECT * FROM connections WHERE owner_id = $1 ORDER BY created_at DESC", [ownerId]);
            return result.rows.map(toConnection);
        },
        async get(ownerId, id) {
            const result = await db.query<ConnectionDbRow>("SELECT * FROM connections WHERE owner_id = $1 AND id = $2", [ownerId, id]);
            return result.rows[0] ? toConnection(result.rows[0]) : undefined;
        },
        async rename(ownerId, id, name) {
            const result = await db.query<ConnectionDbRow>("UPDATE connections SET name = $3, updated_at = now() WHERE owner_id = $1 AND id = $2 RETURNING *", [ownerId, id, name]);
            return result.rows[0] ? toConnection(result.rows[0]) : undefined;
        },
        async delete(ownerId, id) {
            await db.query("DELETE FROM connections WHERE owner_id = $1 AND id = $2", [ownerId, id]);
        },
        async countCloud(ownerId) {
            const result = await db.query<{ n: unknown }>("SELECT count(*) AS n FROM connections WHERE owner_id = $1 AND kind = 'cloud'", [ownerId]);
            return num(result.rows[0]?.n ?? 0);
        },
    };
}

// ---- accounts -----------------------------------------------------------------------------------------------------------------------

interface UserDbRow {
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
    is_admin: boolean;
    created_at: unknown;
}

const toUser = (row: UserDbRow): UserRecord => ({ id: row.id, email: row.email, displayName: row.display_name, isAdmin: row.is_admin, passwordHash: row.password_hash, createdAt: iso(row.created_at) });

export function createPgUserStore(db: Queryable): UserStore {
    return {
        async count() {
            const result = await db.query<{ n: unknown }>("SELECT count(*) AS n FROM users");
            return num(result.rows[0]?.n ?? 0);
        },
        async create(input) {
            try {
                const result = await db.query<UserDbRow>("INSERT INTO users (email, display_name, password_hash, is_admin) VALUES ($1, $2, $3, $4) RETURNING *", [input.email, input.displayName, input.passwordHash, input.isAdmin]);
                return toUser(result.rows[0]);
            } catch (error) {
                if ((error as { code?: string }).code === "23505") throw new EmailTakenError();
                throw error;
            }
        },
        async findByEmail(email) {
            const result = await db.query<UserDbRow>("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
            return result.rows[0] ? toUser(result.rows[0]) : undefined;
        },
        async findById(id) {
            const result = await db.query<UserDbRow>("SELECT * FROM users WHERE id = $1", [id]);
            return result.rows[0] ? toUser(result.rows[0]) : undefined;
        },
    };
}

export function createPgSessionStore(db: Queryable): SessionStore {
    return {
        async create(input) {
            await db.query("INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)", [input.tokenHash, input.userId, input.expiresAt.toISOString(), input.userAgent?.slice(0, 300) ?? null]);
        },
        async findUser(tokenHash) {
            const result = await db.query<UserDbRow>(
                `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
                [tokenHash],
            );
            return result.rows[0] ? toUser(result.rows[0]) : undefined;
        },
        async delete(tokenHash) {
            await db.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
        },
        async deleteForUser(userId) {
            await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
        },
        async deleteExpired() {
            return (await db.query("DELETE FROM sessions WHERE expires_at <= now()")).rowCount;
        },
    };
}

// ---- diagrams -----------------------------------------------------------------------------------------------------------------------

interface ProjectDbRow {
    id: string;
    name: string;
    dialect: string;
    tables_count: number;
    version: number;
    created_at: unknown;
    updated_at: unknown;
    document?: unknown;
}

const toSummary = (row: ProjectDbRow): ProjectSummary => ({ id: row.id, name: row.name, dialect: row.dialect, tables: row.tables_count, version: row.version, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

export function createPgProjectStore(db: Queryable): ProjectStore {
    return {
        async list(ownerId) {
            const result = await db.query<ProjectDbRow>("SELECT id, name, dialect, tables_count, version, created_at, updated_at FROM projects WHERE owner_id = $1 ORDER BY updated_at DESC", [ownerId]);
            return result.rows.map(toSummary);
        },
        async get(ownerId, id) {
            const result = await db.query<ProjectDbRow>("SELECT * FROM projects WHERE owner_id = $1 AND id = $2", [ownerId, id]);
            const row = result.rows[0];
            return row ? ({ ...toSummary(row), document: row.document } satisfies ProjectRecord) : undefined;
        },
        async upsert(ownerId, input) {
            // The WHERE keeps someone else's project with the same id from being replaced: the row is simply not returned.
            const result = await db.query<ProjectDbRow>(
                `INSERT INTO projects (id, owner_id, name, dialect, document, tables_count)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6)
                 ON CONFLICT (id) DO UPDATE
                   SET name = EXCLUDED.name, dialect = EXCLUDED.dialect, document = EXCLUDED.document, tables_count = EXCLUDED.tables_count,
                       version = projects.version + 1, updated_at = now()
                   WHERE projects.owner_id = EXCLUDED.owner_id
                 RETURNING id, name, dialect, tables_count, version, created_at, updated_at`,
                [input.id, ownerId, input.name, input.dialect, JSON.stringify(input.document), input.tables],
            );
            return result.rows[0] ? toSummary(result.rows[0]) : undefined;
        },
        async delete(ownerId, id) {
            return (await db.query("DELETE FROM projects WHERE owner_id = $1 AND id = $2", [ownerId, id])).rowCount > 0;
        },
    };
}

// ---- AI settings and the audit log ----------------------------------------------------------------------------------------------------

/**
 * AI settings are one set for the whole workspace. They are read on every request, so they are kept in memory and written through to
 * the database when changed.
 */
export async function createPgSettingsStore(db: Queryable): Promise<SettingsStore> {
    const load = async () => {
        const result = await db.query<{ json: unknown }>("SELECT json FROM ai_settings WHERE id = 1");
        const stored = result.rows[0]?.json;
        return settingsFromStored(typeof stored === "string" ? JSON.parse(stored) : ((stored as Record<string, unknown> | undefined) ?? {}));
    };
    let current = await load();
    return {
        read: () => ({ settings: current }),
        async write(settings: AiSettings) {
            await db.query(
                `INSERT INTO ai_settings (id, json) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json, updated_at = now()`,
                [JSON.stringify({ ...settings, updatedAt: undefined })],
            );
            current = settings;
        },
    };
}

interface AuditDbRow {
    id: unknown;
    at: unknown;
    kind: AuditEntry["kind"];
    purpose: string;
    status: AuditEntry["status"];
    connection_id: string | null;
    connection_name: string | null;
    provider: string | null;
    model: string | null;
    endpoint_host: string | null;
    redacted: boolean;
    request_chars: number | null;
    request_tokens_estimate: number | null;
    response_chars: number | null;
    usage_input_tokens: number | null;
    usage_output_tokens: number | null;
    latency_ms: number | null;
    error: string | null;
    parent_id: unknown;
    payload: string | null;
    sha256: string | null;
    response: string | null;
    detail: unknown;
}

const toAuditEntry = (row: AuditDbRow): AuditEntry => ({
    id: num(row.id),
    at: iso(row.at),
    kind: row.kind,
    purpose: row.purpose,
    status: row.status,
    connectionId: row.connection_id,
    connectionName: row.connection_name,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    endpointHost: row.endpoint_host ?? undefined,
    redacted: row.redacted,
    requestChars: row.request_chars ?? undefined,
    requestTokensEstimate: row.request_tokens_estimate ?? undefined,
    responseChars: row.response_chars ?? undefined,
    usageInputTokens: row.usage_input_tokens,
    usageOutputTokens: row.usage_output_tokens,
    latencyMs: row.latency_ms ?? undefined,
    error: row.error,
    parentId: row.parent_id === null || row.parent_id === undefined ? null : num(row.parent_id),
    payload: row.payload,
    sha256: row.sha256,
    response: row.response,
    detail: row.detail ? (typeof row.detail === "string" ? JSON.parse(row.detail) : (row.detail as Record<string, unknown>)) : null,
});

/** Each account sees its own entries; entries made with no account (local mode) have no owner. */
export function createPgAuditStore(db: Queryable): AuditStore {
    return {
        async record(entry: NewAuditEntry) {
            const owner = ownerOrNull(entry.ownerId);
            const result = await db.query<{ id: unknown }>(
                `INSERT INTO ai_audit (owner_id, kind, purpose, status, connection_id, connection_name, provider, model, endpoint_host, redacted, request_chars, request_tokens_estimate,
                                       response_chars, usage_input_tokens, usage_output_tokens, latency_ms, error, parent_id, payload, sha256, response, detail)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb)
                 RETURNING id`,
                [
                    owner, entry.kind, entry.purpose, entry.status, entry.connectionId ?? null, entry.connectionName ?? null, entry.provider ?? null, entry.model ?? null, entry.endpointHost ?? null,
                    entry.redacted ?? false, entry.requestChars ?? null, entry.requestTokensEstimate ?? null, entry.responseChars ?? null, entry.usageInputTokens ?? null, entry.usageOutputTokens ?? null,
                    entry.latencyMs ?? null, entry.error ?? null, entry.parentId ?? null, entry.payload ?? null, entry.sha256 ?? null, entry.response ?? null, entry.detail ? JSON.stringify(entry.detail) : null,
                ],
            );
            const id = num(result.rows[0].id);
            // Keep each owner's newest entries only.
            await db.query(
                `DELETE FROM ai_audit WHERE id IN (SELECT id FROM ai_audit WHERE owner_id IS NOT DISTINCT FROM $1 ORDER BY id DESC OFFSET $2)`,
                [owner, AUDIT_RETENTION],
            );
            return id;
        },
        async list(options = {}) {
            const owner = ownerOrNull(options.ownerId);
            const result = await db.query<AuditDbRow>(
                "SELECT * FROM ai_audit WHERE owner_id IS NOT DISTINCT FROM $1 AND id > $2 ORDER BY id DESC LIMIT $3",
                [owner, options.sinceId ?? 0, Math.min(options.limit ?? 200, AUDIT_RETENTION)],
            );
            return result.rows.map(toAuditEntry);
        },
        async get(id, ownerId) {
            const result = await db.query<AuditDbRow>("SELECT * FROM ai_audit WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2", [id, ownerOrNull(ownerId)]);
            return result.rows[0] ? toAuditEntry(result.rows[0]) : undefined;
        },
    };
}

/** Everything the application database holds, over one connection pool. */
export async function createPgStores(db: AppDb) {
    return {
        connections: createPgConnectionStore(db),
        users: createPgUserStore(db),
        sessions: createPgSessionStore(db),
        projects: createPgProjectStore(db),
        settings: await createPgSettingsStore(db),
        audit: createPgAuditStore(db),
    };
}
