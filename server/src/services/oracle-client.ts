import oracledb from "oracledb";
import type { ConnectionRow } from "../db/stores.js";
import { toConnectionConfig, type ConnectionConfig } from "./pg-client.js";

/**
 * Oracle connections, in node-oracledb's Thin mode: pure JavaScript, no Oracle client libraries to install. `database` in a
 * ConnectionConfig is the service name (for example FREEPDB1), and `sslMode` is not used (the listener is reached over plain TCP).
 */

export const CONNECT_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 60_000;

export const oracleConnectString = (config: Pick<ConnectionConfig, "host" | "port" | "database">): string => `${config.host}:${config.port}/${config.database}`;

export function oracleConfigOf(row: ConnectionRow): ConnectionConfig {
    return toConnectionConfig(row);
}

/** Opens one connection, runs `fn`, and always closes it. */
export async function withOracle<T>(config: ConnectionConfig, fn: (connection: oracledb.Connection) => Promise<T>, options: { callTimeoutMs?: number } = {}): Promise<T> {
    const connection = await oracledb.getConnection({
        user: config.user,
        password: config.password,
        connectString: oracleConnectString(config),
        connectTimeout: CONNECT_TIMEOUT_MS / 1000,
    });
    connection.callTimeout = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
    try {
        return await fn(connection);
    } finally {
        await connection.close().catch(() => undefined);
    }
}

export { oracledb };
