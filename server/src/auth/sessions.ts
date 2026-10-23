import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { SessionStore, UserRecord } from "../db/stores.js";

export const SESSION_COOKIE = "goforge_session";
export const SESSION_DAYS = 30;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Starts a session for the account and sets its cookie. Only a hash of the token is stored, so a copy of the database cannot be used to sign in. */
export async function startSession(store: SessionStore, user: UserRecord, req: Request, res: Response, secure: boolean): Promise<void> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    await store.create({ tokenHash: sha256(token), userId: user.id, expiresAt, userAgent: req.headers["user-agent"] });
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", expires: expiresAt });
}

export async function endSession(store: SessionStore, req: Request, res: Response, secure: boolean): Promise<void> {
    const token = readSessionToken(req);
    if (token) await store.delete(sha256(token));
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure, path: "/" });
}

export function readSessionToken(req: Request): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index > 0 && part.slice(0, index).trim() === SESSION_COOKIE) {
            const value = part.slice(index + 1).trim();
            return value.length > 0 && value.length <= 200 ? value : undefined;
        }
    }
    return undefined;
}

export const tokenHash = sha256;
