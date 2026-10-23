import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";
import { LOCAL_OWNER } from "../db/stores.js";

/** Who a request is for. Set by the auth middleware; absent in local mode, where there is one anonymous owner. */
export interface AuthContext {
    userId: string;
    email: string;
    displayName: string;
    isAdmin: boolean;
}

declare module "express-serve-static-core" {
    interface Request {
        auth?: AuthContext;
    }
}

/** The owner every stored thing is scoped to: the signed-in account, or the single local owner. */
export const ownerOf = (req: Request): string => req.auth?.userId ?? LOCAL_OWNER;

// The account behind a request, for code far from the route (the model call that writes the audit log) that would otherwise need the owner
// passed through every function in between.
const running = new AsyncLocalStorage<{ ownerId: string }>();
export const runAs = <T>(ownerId: string, fn: () => T): T => running.run({ ownerId }, fn);
export const currentOwnerId = (): string | undefined => running.getStore()?.ownerId;
