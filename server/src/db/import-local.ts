import type { ConnectionRow, ConnectionStore } from "./stores.js";

/**
 * Moves saved connections from the local SQLite file to an account in the Postgres application database. The passwords stay encrypted
 * exactly as they were, so the same MASTER_KEY has to be in use; nothing is decrypted here. A connection the account already has (same
 * id) is left alone, so running this twice is safe.
 */
export async function importLocalConnections(rows: ConnectionRow[], store: ConnectionStore, ownerId: string): Promise<{ imported: string[]; skipped: string[] }> {
    const imported: string[] = [];
    const skipped: string[] = [];
    for (const row of rows) {
        if (await store.get(ownerId, row.id)) {
            skipped.push(row.name);
            continue;
        }
        try {
            await store.insert(ownerId, { ...row, kind: "external" });
            imported.push(row.name);
        } catch (error) {
            // The id belongs to another account's connection: not ours to take, and not a reason to stop.
            if ((error as { code?: string }).code === "23505") skipped.push(row.name);
            else throw error;
        }
    }
    return { imported, skipped };
}
