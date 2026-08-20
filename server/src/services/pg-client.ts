import { Client } from "pg";
import { decryptSecret } from "../crypto/vault.js";
import type { ConnectionRow } from "../db/store.js";

export interface ConnectionConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    sslMode: string;
}

export function toConnectionConfig(row: ConnectionRow): ConnectionConfig {
    const password = decryptSecret({
        ciphertext: row.password_ciphertext,
        iv: row.password_iv,
        authTag: row.password_auth_tag,
    });

    return {
        host: row.host,
        port: row.port,
        user: row.username,
        password,
        database: row.database_name,
        sslMode: row.ssl_mode,
    };
}

/**
 * Opens a short-lived pg.Client for a single unit of work and always closes it,
 * even if `fn` throws. Never cache/pool clients across requests — credentials
 * are decrypted fresh per call and must not linger in memory longer than needed.
 */
export async function withPgClient<T>(config: ConnectionConfig, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        ssl: config.sslMode === "disable" ? false : { rejectUnauthorized: config.sslMode !== "allow" },
        connectionTimeoutMillis: 10_000,
        query_timeout: 30_000,
    });

    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.end();
    }
}
