import { Router } from "express";
import { z } from "zod";
import type { ConnectionRow } from "../db/stores.js";
import { findConnection } from "./connection-lookup.js";
import { oracleSql } from "../services/oracle-sql.js";
import { SqlSessionError, sqlSessions } from "../services/sql-sessions.js";

export const sqlRouter = Router();

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid session id");

const runSchema = z.object({
    sessionId: sessionIdSchema,
    sql: z.string().min(1).max(500_000),
    transactional: z.boolean().default(true),
    /** The browser believes a transaction with earlier changes is still open on the server. */
    expectOpenTransaction: z.boolean().default(false),
});

const NO_TRANSACTION = { open: false, hasChanges: false, startedAt: null };
const isOracle = (row: ConnectionRow) => row.engine === "oracle";

async function connectionOr404(req: import("express").Request, res: import("express").Response): Promise<ConnectionRow | undefined> {
    // the SQL editor works on both engines; an Oracle schema commits as it goes, so it has no transaction to keep open
    const row = await findConnection(req, req.params.id, { engine: "any" });
    if (!row) res.status(404).json({ error: "Connection not found" });
    return row;
}

function fail(res: import("express").Response, error: unknown) {
    if (error instanceof SqlSessionError) return res.status(error.status).json({ error: error.message, code: error.code });
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
}

sqlRouter.post("/:id/sql/run", async (req, res) => {
    const row = await connectionOr404(req, res);
    if (!row) return;

    const parsed = runSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

    try {
        const { sessionId, sql, transactional, expectOpenTransaction } = parsed.data;
        if (isOracle(row)) return res.json(await oracleSql.run(row, sessionId, sql));
        res.json(await sqlSessions.run(row, sessionId, sql, { transactional, expectOpenTransaction }));
    } catch (error) {
        fail(res, error);
    }
});

for (const action of ["commit", "rollback"] as const) {
    sqlRouter.post(`/:id/sql/sessions/:sessionId/${action}`, async (req, res) => {
        const row = await connectionOr404(req, res);
        if (!row) return;
        const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
        if (!sessionId.success) return res.status(400).json({ error: "Invalid session id" });

        if (isOracle(row)) return res.json({ ok: true, transaction: NO_TRANSACTION });
        try {
            res.json(await sqlSessions[action](row.id, sessionId.data));
        } catch (error) {
            fail(res, error);
        }
    });
}

sqlRouter.post("/:id/sql/sessions/:sessionId/cancel", async (req, res) => {
    const row = await connectionOr404(req, res);
    if (!row) return;
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) return res.status(400).json({ error: "Invalid session id" });

    if (isOracle(row)) return res.json({ cancelling: (await oracleSql.cancel(row.id, sessionId.data)).cancelled });
    try {
        res.json(await sqlSessions.cancel(row, sessionId.data));
    } catch (error) {
        fail(res, error);
    }
});

sqlRouter.get("/:id/sql/sessions/:sessionId", async (req, res) => {
    const row = await connectionOr404(req, res);
    if (!row) return;
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) return res.status(400).json({ error: "Invalid session id" });

    if (isOracle(row)) return res.json({ exists: false, transaction: NO_TRANSACTION });
    try {
        const transaction = sqlSessions.status(row.id, sessionId.data);
        res.json({ exists: transaction !== undefined, transaction: transaction ?? { open: false, hasChanges: false, startedAt: null } });
    } catch (error) {
        fail(res, error);
    }
});

// DELETE for fetch(); POST .../close for navigator.sendBeacon when the tab is closing (beacons can only POST).
const closeSession: import("express").RequestHandler = async (req, res) => {
    const row = await findConnection(req, req.params.id, { engine: "any" });
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!row || !sessionId.success || isOracle(row)) return res.status(204).end();

    try {
        await sqlSessions.close(row.id, sessionId.data);
        res.status(204).end();
    } catch (error) {
        fail(res, error);
    }
};
sqlRouter.delete("/:id/sql/sessions/:sessionId", closeSession);
sqlRouter.post("/:id/sql/sessions/:sessionId/close", closeSession);
