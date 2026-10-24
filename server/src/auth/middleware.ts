import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getCloud } from "../db/stores.js";
import { runAs } from "./context.js";
import { readSessionToken, tokenHash } from "./sessions.js";

/** With accounts on, turns the session cookie into `req.auth`, and runs the rest of the request as that account. Does not reject anyone. */
export const attachAuth: RequestHandler = async (req, _res, next) => {
    const cloud = getCloud();
    if (!cloud) return next();
    const token = readSessionToken(req);
    if (!token) return next();
    try {
        const user = await cloud.sessions.findUser(tokenHash(token));
        if (!user) return next();
        req.auth = { userId: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin };
        runAs(user.id, () => next());
    } catch (error) {
        next(error);
    }
};

/** With accounts on, everything behind this needs a signed-in account. Local mode has no accounts and lets everything through. */
export const requireAuth: RequestHandler = (req, res, next) => {
    if (!getCloud() || req.auth) return next();
    res.status(401).json({ error: "Sign in to continue.", code: "unauthenticated" });
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A page on another site must not be able to make the browser send a signed-in request here. The cookie is SameSite=Lax, which already
 * keeps it off cross-site POSTs; this also refuses any changing request whose Origin is not this site (or one named in CORS_ORIGIN).
 */
export function originGuard(allowedOrigins: string[] = (process.env.CORS_ORIGIN ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        if (SAFE_METHODS.has(req.method) || !getCloud()) return next();
        const origin = req.headers.origin;
        if (!origin) return next(); // not a browser cross-origin request (curl, server to server); it has no cookie to abuse
        let host: string;
        try {
            host = new URL(origin).host;
        } catch {
            return res.status(403).json({ error: "Request refused: unreadable Origin." });
        }
        const own = [req.headers.host, req.headers["x-forwarded-host"]].flat().filter(Boolean);
        if (own.includes(host) || allowedOrigins.includes(origin)) return next();
        res.status(403).json({ error: "Request refused: it came from another site." });
    };
}
