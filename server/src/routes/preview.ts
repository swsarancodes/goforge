import { Router } from "express";
import { z } from "zod";
import { getConnection } from "../db/store.js";
import { toConnectionConfig, withPgClient } from "../services/pg-client.js";
import { splitStatements } from "../services/sql-utils.js";

export const previewRouter = Router();

const previewSchema = z.object({ sql: z.string().min(1) });

previewRouter.post("/:id/preview", async (req, res) => {
    const row = getConnection(req.params.id);
    if (!row) return res.status(404).json({ valid: false, error: "Connection not found" });

    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ valid: false, error: parsed.error.flatten() });

    const statements = splitStatements(parsed.data.sql);

    try {
        const config = toConnectionConfig(row);
        await withPgClient(config, async (client) => {
            await client.query("BEGIN");
            try {
                for (const statement of statements) {
                    await client.query(statement);
                }
            } finally {
                // Always roll back - this endpoint only validates the SQL runs
                // cleanly against the real schema, it must never persist changes.
                await client.query("ROLLBACK");
            }
        });
        res.json({ valid: true });
    } catch (err) {
        res.json({ valid: false, error: err instanceof Error ? err.message : String(err) });
    }
});
