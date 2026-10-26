import type { Request } from "express";
import { ownerOf } from "../auth/context.js";
import { getConnectionStore, type ConnectionRow } from "../db/stores.js";

/**
 * The saved connection named by `:id` (or `id`), if it exists and belongs to whoever is asking. Someone else's id is simply not found.
 * Most pages work on PostgreSQL only, so an Oracle connection is "not found" to them unless the caller says `engine: "any"`
 * (the SQL editor, the Data page's table list and rows, deleting a connection, testing one, migrating one).
 */
export async function findConnection(req: Request, id: string = req.params.id, options: { engine?: "postgres" | "any" } = {}): Promise<ConnectionRow | undefined> {
    const row = await getConnectionStore().get(ownerOf(req), id);
    if (row && (row.engine ?? "postgres") === "oracle" && options.engine !== "any") return undefined;
    return row;
}
