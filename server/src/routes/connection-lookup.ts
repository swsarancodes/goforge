import type { Request } from "express";
import { ownerOf } from "../auth/context.js";
import { getConnectionStore, type ConnectionRow } from "../db/stores.js";

/** The saved connection named by `:id` (or `id`), if it exists and belongs to whoever is asking. Someone else's id is simply not found. */
export function findConnection(req: Request, id: string = req.params.id): Promise<ConnectionRow | undefined> {
    return getConnectionStore().get(ownerOf(req), id);
}
