import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Express 4 does not catch a rejected promise from an async handler; this passes it to the error handler instead of crashing the process. */
export const handle =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
    (req, res, next) => {
        fn(req, res, next).catch(next);
    };

/** Last in the chain: an unexpected error becomes a JSON 500 (logged here, never sent in detail), and body-parsing errors say what they are. */
export const errorHandler = (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) return next(error);
    const type = (error as { type?: string } | undefined)?.type;
    if (type === "entity.too.large") {
        res.status(413).json({ error: "That request is too large." });
        return;
    }
    if (type === "entity.parse.failed") {
        res.status(400).json({ error: "The request body is not valid JSON." });
        return;
    }
    console.error("unexpected error:", error instanceof Error ? error.stack ?? error.message : error);
    res.status(500).json({ error: "Something went wrong on the server." });
};
