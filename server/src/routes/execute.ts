import { Router } from "express";
import { z } from "zod";
import { getConnection } from "../db/store.js";
import { toConnectionConfig, withPgClient } from "../services/pg-client.js";
import { splitStatements } from "../services/sql-utils.js";

export const executeRouter = Router();

const executeSchema = z.object({ sql: z.string().min(1) });

executeRouter.post("/:id/execute", async (req, res) => {
    const row = getConnection(req.params.id);
    if (!row) return res.status(404).json({ error: "Connection not found" });

    const parsed = executeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const statements = splitStatements(parsed.data.sql);

    try {
        const config = toConnectionConfig(row);
        const statementsRun = await withPgClient(config, async (client) => {
            await client.query("BEGIN");
            try {
                for (const statement of statements) {
                    await client.query(statement);
                }
                await client.query("COMMIT");
                return statements.length;
            } catch (err) {
                await client.query("ROLLBACK");
                throw err;
            }
        });
        res.json({ success: true, statementsRun });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
