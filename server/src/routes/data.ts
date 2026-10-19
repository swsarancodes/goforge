import { Router } from "express";
import { z } from "zod";
import { getConnection } from "../db/store.js";
import { toConnectionConfig, withPgClient } from "../services/pg-client.js";
import { DataRequestError, fetchTableRows } from "../services/pg-data.js";

export const dataRouter = Router();

const dataQuerySchema = z.object({
    schema: z.string().min(1),
    table: z.string().min(1),
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().min(0).optional(),
    sort: z.string().min(1).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
    count: z.literal("exact").optional(),
});

dataRouter.get("/:id/data", async (req, res) => {
    const row = getConnection(req.params.id);
    if (!row) return res.status(404).json({ error: "Connection not found" });

    const parsed = dataQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { schema, table, limit, offset, sort, dir, count } = parsed.data;

    try {
        const config = toConnectionConfig(row);
        const page = await withPgClient(config, (client) =>
            fetchTableRows(client, { schema, table, limit, offset, sort, dir, exactCount: count === "exact" }),
        );
        res.json(page);
    } catch (err) {
        if (err instanceof DataRequestError) return res.status(err.status).json({ error: err.message });
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
