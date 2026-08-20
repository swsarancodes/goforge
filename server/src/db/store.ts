import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const SQLITE_PATH = process.env.SQLITE_PATH || "./data/connections.db";

fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });

export const db = new Database(SQLITE_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
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
    created_at: string;
    updated_at: string;
}

export function insertConnection(row: ConnectionRow): void {
    db.prepare(
        `INSERT INTO connections
      (id, name, host, port, username, database_name, ssl_mode, password_ciphertext, password_iv, password_auth_tag, created_at, updated_at)
      VALUES (@id, @name, @host, @port, @username, @database_name, @ssl_mode, @password_ciphertext, @password_iv, @password_auth_tag, @created_at, @updated_at)`
    ).run(row);
}

export function listConnections(): ConnectionRow[] {
    return db.prepare(`SELECT * FROM connections ORDER BY created_at DESC`).all() as ConnectionRow[];
}

export function getConnection(id: string): ConnectionRow | undefined {
    return db.prepare(`SELECT * FROM connections WHERE id = ?`).get(id) as ConnectionRow | undefined;
}

export function deleteConnection(id: string): void {
    db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
}
