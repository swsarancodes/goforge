import { Router } from "express";
import { getConnection } from "../db/store.js";
import { toConnectionConfig, withPgClient } from "../services/pg-client.js";
import { introspectPostgres } from "../services/pg-introspect.js";

export const introspectRouter = Router();

introspectRouter.get("/:id/introspect", async (req, res) => {
    const row = getConnection(req.params.id);
    if (!row) return res.status(404).json({ error: "Connection not found" });

    try {
        const config = toConnectionConfig(row);
        const result = await withPgClient(config, (client) => introspectPostgres(client));
        res.json(result);
    } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
