import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

let opened: Database.Database | undefined;

/**
 * The local SQLite file (saved connections, and AI settings and the audit log through ai-store.ts). It is opened the first time it is
 * used, not when this file is imported, so a server running on a Postgres application database never creates it.
 */
export function getDb(): Database.Database {
    if (opened) return opened;
    const sqlitePath = process.env.SQLITE_PATH || "./data/connections.db";
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const database = new Database(sqlitePath);
    database.pragma("journal_mode = WAL");
    database.exec(`
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    database_name TEXT NOT NULL,
    ssl_mode TEXT NOT NULL DEFAULT 'disable',
    password_ciphertext BLOB NOT NULL,
    password_iv BLOB NOT NULL,
    password_auth_tag BLOB NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
    opened = database;
    return database;
}

export interface ConnectionRow {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    database_name: string;
    ssl_mode: string;
    password_ciphertext: Buffer;
    password_iv: Buffer;
    password_auth_tag: Buffer;
    /** `cloud` for a database this app created on its own server; anything saved by hand is `external`. */
    kind?: "external" | "cloud";
    created_at: string;
    updated_at: string;
}

export function insertConnection(row: ConnectionRow): void {
    getDb().prepare(
        `INSERT INTO connections
      (id, name, host, port, username, database_name, ssl_mode, password_ciphertext, password_iv, password_auth_tag, created_at, updated_at)
      VALUES (@id, @name, @host, @port, @username, @database_name, @ssl_mode, @password_ciphertext, @password_iv, @password_auth_tag, @created_at, @updated_at)`
    ).run(withoutKind(row));
}

function withoutKind(row: ConnectionRow) {
    const { kind: _kind, ...rest } = row;
    return rest;
}

export function listConnections(): ConnectionRow[] {
    return getDb().prepare(`SELECT * FROM connections ORDER BY created_at DESC`).all() as ConnectionRow[];
}

export function getConnection(id: string): ConnectionRow | undefined {
    return getDb().prepare(`SELECT * FROM connections WHERE id = ?`).get(id) as ConnectionRow | undefined;
}

export function renameConnection(id: string, name: string): ConnectionRow | undefined {
    const result = getDb().prepare(`UPDATE connections SET name = ?, updated_at = ? WHERE id = ?`).run(name, new Date().toISOString(), id);
    return result.changes === 0 ? undefined : getConnection(id);
}

export function deleteConnection(id: string): void {
    getDb().prepare(`DELETE FROM connections WHERE id = ?`).run(id);
}
