import { deleteConnection, getConnection, insertConnection, listConnections, renameConnection } from "./store.js";
import type { ConnectionStore } from "./stores.js";

/** The saved connections in the local SQLite file. There is one anonymous owner, so the owner argument is not used. */
export function createLocalConnectionStore(): ConnectionStore {
    return {
        async insert(_ownerId, row) {
            insertConnection(row);
        },
        async list() {
            return listConnections().map((row) => ({ ...row, kind: "external" as const }));
        },
        async get(_ownerId, id) {
            const row = getConnection(id);
            return row ? { ...row, kind: "external" as const } : undefined;
        },
        async rename(_ownerId, id, name) {
            const row = renameConnection(id, name);
            return row ? { ...row, kind: "external" as const } : undefined;
        },
        async delete(_ownerId, id) {
            deleteConnection(id);
        },
        async countCloud() {
            return 0;
        },
    };
}
