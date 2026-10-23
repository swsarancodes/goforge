import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { encryptSecret } from "../crypto/vault.js";
import { getCloud, getConnectionStore, type ConnectionRow } from "../db/stores.js";
import { ownerOf } from "../auth/context.js";
import { findConnection } from "./connection-lookup.js";
import { handle } from "./async-handler.js";
import { dropCloudDatabase } from "../services/cloud-databases.js";
import { toConnectionConfig, withPgClient } from "../services/pg-client.js";
import { catalogCache } from "../services/catalog-cache.js";
import { closeReadPool } from "../services/pg-pool.js";
import { sqlSessions } from "../services/sql-sessions.js";
import { CreateDatabaseError, DATABASE_NAME_PATTERN, DatabaseExistsError, createDatabaseFromSql } from "../services/pg-create-database.js";

export const connectionsRouter = Router();

const createConnectionSchema = z.object({
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive(),
    username: z.string().min(1),
    password: z.string(),
    database: z.string().min(1),
    sslMode: z.enum(["disable", "allow", "require", "verify-full"]).default("disable"),
});

const renameConnectionSchema = z.object({
    name: z.string().trim().min(1).max(100),
});

export function toPublicConnection(row: ConnectionRow) {
    return {
        id: row.id,
        name: row.name,
        host: row.host,
        port: row.port,
        username: row.username,
        database: row.database_name,
        sslMode: row.ssl_mode,
        /** `cloud` for a database this app created for the account; deleting it deletes the database. */
        kind: row.kind ?? "external",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

connectionsRouter.post("/", handle(async (req, res) => {
    const parsed = createConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { name, host, port, username, password, database, sslMode } = parsed.data;
    const { ciphertext, iv, authTag } = encryptSecret(password);
    const now = new Date().toISOString();

    const row: ConnectionRow = {
        id: randomUUID(),
        name,
        host,
        port,
        username,
        database_name: database,
        ssl_mode: sslMode,
        password_ciphertext: ciphertext,
        password_iv: iv,
        password_auth_tag: authTag,
        created_at: now,
        updated_at: now,
    };

    await getConnectionStore().insert(ownerOf(req), row);
    res.status(201).json(toPublicConnection(row));
}));

connectionsRouter.get("/", handle(async (req, res) => {
    res.json((await getConnectionStore().list(ownerOf(req))).map(toPublicConnection));
}));

connectionsRouter.patch("/:id", handle(async (req, res) => {
    const parsed = renameConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const row = await getConnectionStore().rename(ownerOf(req), req.params.id, parsed.data.name);
    if (!row) return res.status(404).json({ error: "Connection not found" });
    res.json(toPublicConnection(row));
}));

connectionsRouter.delete("/:id", handle(async (req, res) => {
    const row = await findConnection(req);
    if (!row) return res.status(404).json({ error: "Connection not found" });

    // A database this app created exists only through this connection, so removing the connection removes the database. That cannot be
    // undone, so it has to be asked for.
    if (row.kind === "cloud" && req.query.dropDatabase !== "true") {
        return res.status(409).json({ error: `"${row.name}" is a database GoForge created for you. Deleting it permanently deletes the database and everything in it.`, code: "cloud-database" });
    }

    // Drop any open browsing connections (and the password they hold) first, so nothing is still using a database that is about to go.
    catalogCache.clear(row.id);
    await closeReadPool(row.id);
    await sqlSessions.closeForConnection(row.id);

    if (row.kind === "cloud") {
        const cloud = getCloud();
        if (!cloud) return res.status(409).json({ error: "This database lives on the application server, which is not configured here." });
        try {
            await dropCloudDatabase(cloud.admin, row.database_name);
        } catch (error) {
            return res.status(502).json({ error: `Could not delete the database: ${error instanceof Error ? error.message : String(error)}` });
        }
    }
    await getConnectionStore().delete(ownerOf(req), row.id);
    res.status(204).end();
}));

connectionsRouter.post("/:id/test", async (req, res) => {
    const row = await findConnection(req);
    if (!row) return res.status(404).json({ ok: false, error: "Connection not found" });

    try {
        const config = toConnectionConfig(row);
        await withPgClient(config, (client) => client.query("SELECT 1"));
        res.json({ ok: true });
    } catch (err) {
        res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
});

const createDatabaseSchema = z.object({
    database: z.string().regex(DATABASE_NAME_PATTERN, "A database name uses letters, digits and underscores, starts with a letter or underscore, and is at most 63 characters."),
    /** What the new saved connection is called; the database name when left out. */
    name: z.string().trim().min(1).max(100).optional(),
    /** The schema script to run in the new database. */
    sql: z.string().min(1),
});

/**
 * Creates a new database on the server this saved connection points at, builds the given schema in it as one transaction, and saves a
 * connection to it (same host, role and password) so it shows up everywhere connections are listed. A failed schema removes the new
 * database again. The password is re-encrypted for the new row and never returned.
 */
connectionsRouter.post("/:id/create-database", async (req, res) => {
    const row = await findConnection(req);
    if (!row) return res.status(404).json({ error: "Connection not found" });
    // A cloud database's connection is an ordinary role limited to that one database; and it must never be used to make more databases
    // that are not counted against the account's limit.
    if (row.kind === "cloud") return res.status(400).json({ error: "Create it with the GoForge cloud option instead." });

    const parsed = createDatabaseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
    const { database, name, sql } = parsed.data;

    try {
        const config = toConnectionConfig(row);
        const { statementsRun } = await createDatabaseFromSql(config, database, sql);

        const { ciphertext, iv, authTag } = encryptSecret(config.password);
        const now = new Date().toISOString();
        const created: ConnectionRow = {
            id: randomUUID(),
            name: name ?? database,
            host: row.host,
            port: row.port,
            username: row.username,
            database_name: database,
            ssl_mode: row.ssl_mode,
            password_ciphertext: ciphertext,
            password_iv: iv,
            password_auth_tag: authTag,
            created_at: now,
            updated_at: now,
        };
        await getConnectionStore().insert(ownerOf(req), created);
        res.status(201).json({ connection: toPublicConnection(created), statementsRun });
    } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (err instanceof DatabaseExistsError) return res.status(409).json({ error: text });
        if (err instanceof CreateDatabaseError) return res.status(err.kind === "permission" ? 403 : err.kind === "schema" ? 422 : 502).json({ error: text });
        res.status(502).json({ error: text });
    }
});
