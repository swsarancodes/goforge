import { randomBytes, randomUUID } from "node:crypto";
import { encryptSecret } from "../crypto/vault.js";
import type { ConnectionRow } from "../db/stores.js";
import { withPgClient, type ConnectionConfig } from "./pg-client.js";
import { DATABASE_NAME_PATTERN, type DatabaseOwner } from "./pg-create-database.js";

/**
 * Databases the app creates for people on its own server (the one DATABASE_URL points at). Each belongs to one account: the physical
 * name carries the account's id, the connection saved for it is that account's, and the app server's credentials never leave the API.
 */

/** The server's connection settings, taken from DATABASE_URL (the direct connection, not the pooled one). */
export function adminConfigFromUrl(url: string): ConnectionConfig {
    const parsed = new URL(url);
    const sslmode = parsed.searchParams.get("sslmode") ?? (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ? "disable" : "require");
    return {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 5432,
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "postgres",
        sslMode: ["disable", "allow", "require", "verify-full"].includes(sslmode) ? sslmode : "require",
    };
}

/** `gf_<first 8 hex of the account id>_<name>`: unique per account, a valid identifier, and recognisable as ours in a database list. */
export function cloudDatabaseName(ownerId: string, wanted: string): string {
    const owner = ownerId.replace(/-/g, "").slice(0, 8).toLowerCase();
    const slug = wanted
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "database";
    return `gf_${owner}_${slug}`;
}

const CLOUD_NAME = /^gf_[0-9a-f]{8}_[a-z0-9_]{1,40}$/;

/** Only a database this app created is ever dropped, whatever name a stored row claims. */
export const isCloudDatabaseName = (name: string): boolean => CLOUD_NAME.test(name) && DATABASE_NAME_PATTERN.test(name);

/**
 * The role that owns a cloud database and the password it signs in with. The role is named like the database, has no rights anywhere
 * else, and its password exists only here and, encrypted, in the saved connection: the account behind the database never gets the
 * server's own credentials, and what it runs cannot reach another account's database.
 */
export function newDatabaseOwner(database: string): DatabaseOwner {
    return { role: database, password: randomBytes(24).toString("base64url"), connectionLimit: 10 };
}

/** The saved connection to a cloud database: the app server, signing in as the database's own role. The password is encrypted for the row. */
export function cloudConnectionRow(admin: ConnectionConfig, database: string, name: string, owner: DatabaseOwner): ConnectionRow {
    const { ciphertext, iv, authTag } = encryptSecret(owner.password);
    const now = new Date().toISOString();
    return {
        id: randomUUID(),
        name,
        host: admin.host,
        port: admin.port,
        username: owner.role,
        database_name: database,
        ssl_mode: admin.sslMode,
        password_ciphertext: ciphertext,
        password_iv: iv,
        password_auth_tag: authTag,
        kind: "cloud",
        created_at: now,
        updated_at: now,
    };
}

/** Drops a database created by this app, and the role that owned it. Refuses any other name. Sessions still open on it are ended (PostgreSQL 13+ `WITH (FORCE)`). */
export async function dropCloudDatabase(admin: ConnectionConfig, database: string): Promise<void> {
    if (!isCloudDatabaseName(database)) throw new Error(`Refusing to drop "${database}": it is not a database this app created.`);
    await withPgClient(admin, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await client.query(`DROP ROLE IF EXISTS "${database}"`);
    });
}
