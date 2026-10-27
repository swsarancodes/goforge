import { Router } from "express";
import { z } from "zod";
import { findConnection } from "./connection-lookup.js";
import { oracleConfigOf, withOracle } from "../services/oracle-client.js";
import { isOracleReadQuery, previewOracleQuery, PREVIEW_TIMEOUT_MS, type OracleReader } from "../services/oracle-preview.js";
import { withReadClient } from "../services/pg-pool.js";
import { previewQuery, validateSql } from "../services/pg-validate.js";
import { isSingleReadQuery } from "../services/sql-tokens.js";

/** What the Query Modernizer asks of a live connection: does PostgreSQL accept this SQL, and what does it return. */
export const modernizerRouter = Router();

const bodySchema = z.object({ sql: z.string().trim().min(1).max(200_000) });

modernizerRouter.post("/:id/validate-sql", async (req, res) => {
    const row = await findConnection(req);
    if (!row) return res.status(404).json({ error: "Connection not found" });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

    try {
        res.json(await validateSql(parsed.data.sql, (fn) => withReadClient(row, fn)));
    } catch (error) {
        res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

/** The first rows of one SELECT, read-only, on a PostgreSQL connection or on an Oracle one (the original query, to compare with the conversion). */
modernizerRouter.post("/:id/query-preview", async (req, res) => {
    const row = await findConnection(req, req.params.id, { engine: "any" });
    if (!row) return res.status(404).json({ error: "Connection not found" });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    const oracle = row.engine === "oracle";
    if (!(oracle ? isOracleReadQuery(parsed.data.sql) : isSingleReadQuery(parsed.data.sql))) return res.status(400).json({ error: "The preview runs one SELECT at a time. Use the SQL Editor for anything else." });

    try {
        if (oracle) res.json(await previewOracleQuery(parsed.data.sql, (fn) => withOracle(oracleConfigOf(row), (connection) => fn(connection as unknown as OracleReader), { callTimeoutMs: PREVIEW_TIMEOUT_MS })));
        else res.json(await previewQuery(parsed.data.sql, (fn) => withReadClient(row, fn)));
    } catch (error) {
        res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
