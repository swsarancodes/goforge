import { Router } from "express";
import { z } from "zod";
import { getConnection } from "../db/store.js";
import { catalogCache } from "../services/catalog-cache.js";
import { DataRequestError, fetchTableRows } from "../services/pg-data.js";
import { withReadClient, type PoolTimings } from "../services/pg-pool.js";
import type { RelationMeta } from "../services/pg-relations.js";

export const dataRouter = Router();

const dataQuerySchema = z.object({
    schema: z.string().min(1),
    table: z.string().min(1),
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().min(0).optional(),
    sort: z.string().min(1).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
    count: z.literal("exact").optional(),
    refresh: z.literal("1").optional(),
});

// undefined_column / undefined_table: the cached catalog entry no longer matches the database.
const STALE_CATALOG_CODES = new Set(["42703", "42P01"]);

dataRouter.get("/:id/data", async (req, res) => {
    const row = getConnection(req.params.id);
    if (!row) return res.status(404).json({ error: "Connection not found" });

    const parsed = dataQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { schema, table, limit, offset, sort, dir, count, refresh } = parsed.data;
    const startedAt = performance.now();
    const timings: PoolTimings = {};

    const read = (meta: RelationMeta | undefined) =>
        withReadClient(row, (client) => fetchTableRows(client, { schema, table, limit, offset, sort, dir, exactCount: count === "exact", meta }), timings);

    try {
        const cached = refresh ? undefined : catalogCache.get(row.id, schema, table);
        let result;
        try {
            result = await read(cached);
        } catch (err) {
            const code = (err as { code?: unknown } | undefined)?.code;
            if (!cached || typeof code !== "string" || !STALE_CATALOG_CODES.has(code)) throw err;
            // The table changed since we cached it: forget it and read again with a fresh catalog entry.
            catalogCache.delete(row.id, schema, table);
            result = await read(undefined);
        }
        catalogCache.set(row.id, result.meta);

        res.setHeader("Server-Timing", `connect;dur=${timings.connectMs ?? 0}, total;dur=${Math.round(performance.now() - startedAt)}`);
        res.json(result.page);
    } catch (err) {
        if (err instanceof DataRequestError) return res.status(err.status).json({ error: err.message });
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
