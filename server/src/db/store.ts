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
    // Columns added after the first release: older files get them with their default.
    const columns = new Set((database.prepare("PRAGMA table_info(connections)").all() as { name: string }[]).map((column) => column.name));
    if (!columns.has("engine")) database.exec("ALTER TABLE connections ADD COLUMN engine TEXT NOT NULL DEFAULT 'postgres'");
    if (!columns.has("kind")) database.exec("ALTER TABLE connections ADD COLUMN kind TEXT NOT NULL DEFAULT 'external'");
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
    /** The database engine behind the connection. Absent means PostgreSQL, which is all there was before Oracle. */
    engine?: "postgres" | "oracle";
    created_at: string;
    updated_at: string;
}

export function insertConnection(row: ConnectionRow): void {
    getDb().prepare(
        `INSERT INTO connections
      (id, name, host, port, username, database_name, ssl_mode, password_ciphertext, password_iv, password_auth_tag, kind, engine, created_at, updated_at)
      VALUES (@id, @name, @host, @port, @username, @database_name, @ssl_mode, @password_ciphertext, @password_iv, @password_auth_tag, @kind, @engine, @created_at, @updated_at)`
    ).run({ ...row, kind: row.kind ?? "external", engine: row.engine ?? "postgres" });
}

/** How many connections of this engine the app created on its own servers (kind `cloud`). */
export function countManagedConnections(engine: "postgres" | "oracle"): number {
    return (getDb().prepare(`SELECT count(*) AS n FROM connections WHERE kind = 'cloud' AND engine = ?`).get(engine) as { n: number }).n;
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
