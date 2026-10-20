import { Router } from "express";
import { z } from "zod";
import { getConnection, type ConnectionRow } from "../db/store.js";
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

function connectionOr404(id: string, res: import("express").Response): ConnectionRow | undefined {
    const row = getConnection(id);
    if (!row) res.status(404).json({ error: "Connection not found" });
    return row;
}

function fail(res: import("express").Response, error: unknown) {
    if (error instanceof SqlSessionError) return res.status(error.status).json({ error: error.message, code: error.code });
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
}

sqlRouter.post("/:id/sql/run", async (req, res) => {
    const row = connectionOr404(req.params.id, res);
    if (!row) return;

    const parsed = runSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

    try {
        const { sessionId, sql, transactional, expectOpenTransaction } = parsed.data;
        res.json(await sqlSessions.run(row, sessionId, sql, { transactional, expectOpenTransaction }));
    } catch (error) {
        fail(res, error);
    }
});

for (const action of ["commit", "rollback"] as const) {
    sqlRouter.post(`/:id/sql/sessions/:sessionId/${action}`, async (req, res) => {
        const row = connectionOr404(req.params.id, res);
        if (!row) return;
        const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
        if (!sessionId.success) return res.status(400).json({ error: "Invalid session id" });

        try {
            res.json(await sqlSessions[action](row.id, sessionId.data));
        } catch (error) {
            fail(res, error);
        }
    });
}

sqlRouter.post("/:id/sql/sessions/:sessionId/cancel", async (req, res) => {
    const row = connectionOr404(req.params.id, res);
    if (!row) return;
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) return res.status(400).json({ error: "Invalid session id" });

    try {
        res.json(await sqlSessions.cancel(row, sessionId.data));
    } catch (error) {
        fail(res, error);
    }
});

sqlRouter.get("/:id/sql/sessions/:sessionId", (req, res) => {
    const row = connectionOr404(req.params.id, res);
    if (!row) return;
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) return res.status(400).json({ error: "Invalid session id" });

    try {
        const transaction = sqlSessions.status(row.id, sessionId.data);
        res.json({ exists: transaction !== undefined, transaction: transaction ?? { open: false, hasChanges: false, startedAt: null } });
    } catch (error) {
        fail(res, error);
    }
});

// DELETE for fetch(); POST .../close for navigator.sendBeacon when the tab is closing (beacons can only POST).
const closeSession: import("express").RequestHandler = async (req, res) => {
    const row = getConnection(req.params.id);
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!row || !sessionId.success) return res.status(204).end();

    try {
        await sqlSessions.close(row.id, sessionId.data);
        res.status(204).end();
    } catch (error) {
        fail(res, error);
    }
};
sqlRouter.delete("/:id/sql/sessions/:sessionId", closeSession);
sqlRouter.post("/:id/sql/sessions/:sessionId/close", closeSession);
