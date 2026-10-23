import { countManagedConnections, deleteConnection, getConnection, insertConnection, listConnections, renameConnection, type ConnectionRow } from "./store.js";
import type { ConnectionStore } from "./stores.js";

/** The saved connections in the local SQLite file. There is one anonymous owner, so the owner argument is not used. */
const withDefaults = (row: ConnectionRow): ConnectionRow => ({ ...row, kind: row.kind ?? "external", engine: row.engine ?? "postgres" });

export function createLocalConnectionStore(): ConnectionStore {
    return {
        async insert(_ownerId, row) {
            insertConnection(row);
        },
        async list() {
            return listConnections().map(withDefaults);
        },
        async get(_ownerId, id) {
            const row = getConnection(id);
            return row ? withDefaults(row) : undefined;
        },
        async rename(_ownerId, id, name) {
            const row = renameConnection(id, name);
            return row ? withDefaults(row) : undefined;
        },
        async delete(_ownerId, id) {
            deleteConnection(id);
        },
        async countCloud() {
            return countManagedConnections("postgres");
        },
        async countManaged(_ownerId, engine) {
            return countManagedConnections(engine);
        },
    };
}
