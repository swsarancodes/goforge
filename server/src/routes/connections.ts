import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { encryptSecret } from "../crypto/vault.js";
import { insertConnection, listConnections, getConnection, deleteConnection, type ConnectionRow } from "../db/store.js";
import { toConnectionConfig, withPgClient } from "../services/pg-client.js";
import { catalogCache } from "../services/catalog-cache.js";
import { closeReadPool } from "../services/pg-pool.js";
import { sqlSessions } from "../services/sql-sessions.js";

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

function toPublicConnection(row: ConnectionRow) {
    return {
        id: row.id,
        name: row.name,
        host: row.host,
        port: row.port,
        username: row.username,
        database: row.database_name,
        sslMode: row.ssl_mode,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

connectionsRouter.post("/", (req, res) => {
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

    insertConnection(row);
    res.status(201).json(toPublicConnection(row));
});

connectionsRouter.get("/", (_req, res) => {
    res.json(listConnections().map(toPublicConnection));
});

connectionsRouter.delete("/:id", async (req, res) => {
    const row = getConnection(req.params.id);
    if (!row) return res.status(404).json({ error: "Connection not found" });
    deleteConnection(req.params.id);
    // Drop any open browsing connections (and the password they hold) along with the saved connection.
    catalogCache.clear(req.params.id);
    await closeReadPool(req.params.id);
    await sqlSessions.closeForConnection(req.params.id);
    res.status(204).end();
});

connectionsRouter.post("/:id/test", async (req, res) => {
    const row = getConnection(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: "Connection not found" });

    try {
        const config = toConnectionConfig(row);
        await withPgClient(config, (client) => client.query("SELECT 1"));
        res.json({ ok: true });
    } catch (err) {
        res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
});
