import { Router } from "express";
import { findConnection } from "./connection-lookup.js";
import { catalogCache } from "../services/catalog-cache.js";
import { withReadClient, type PoolTimings } from "../services/pg-pool.js";
import { loadAllRelations } from "../services/pg-relations.js";
import { withOracle, oracleConfigOf } from "../services/oracle-client.js";
import { loadOracleRelations } from "../services/oracle-data.js";

export const relationsRouter = Router();

// The table list the Data page shows. One round trip; also fills the catalog cache so the first page of
// any table afterwards needs no catalog lookup.
relationsRouter.get("/:id/relations", async (req, res) => {
    const row = await findConnection(req, req.params.id, { engine: "any" });
    if (!row) return res.status(404).json({ error: "Connection not found" });

    if (row.engine === "oracle") {
        try {
            const relations = await withOracle(oracleConfigOf(row), loadOracleRelations);
            return res.json({ relations: relations.map(({ schema, name, kind, estimatedRows }) => ({ schema, name, kind, estimatedRows })) });
        } catch (err) {
            return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
        }
    }

    const startedAt = performance.now();
    const timings: PoolTimings = {};
    try {
        const relations = await withReadClient(row, loadAllRelations, timings);
        catalogCache.setAll(row.id, relations);

        res.setHeader("Server-Timing", `connect;dur=${timings.connectMs ?? 0}, total;dur=${Math.round(performance.now() - startedAt)}`);
        // Columns and keys stay on the server (in the cache); the browser only needs what it lists.
        res.json({ relations: relations.map(({ schema, name, kind, estimatedRows }) => ({ schema, name, kind, estimatedRows })) });
    } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
});

// Opens (or keeps open) the pooled connection so the next click doesn't pay for the handshake.
relationsRouter.post("/:id/warm", async (req, res) => {
    const row = await findConnection(req, req.params.id, { engine: "any" });
    if (!row) return res.status(404).json({ ok: false, error: "Connection not found" });

    // An Oracle connection is opened per request (there is no pool to keep warm).
    if (row.engine === "oracle") return res.json({ ok: true, ms: 0 });

    const startedAt = performance.now();
    try {
        await withReadClient(row, (client) => client.query("SELECT 1"));
        res.json({ ok: true, ms: Math.round(performance.now() - startedAt) });
    } catch (err) {
        res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
});
