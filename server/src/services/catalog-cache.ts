import type { RelationMeta } from "./pg-relations.js";

export const CATALOG_TTL_MS = 5 * 60_000;

const key = (schema: string, name: string) => `${schema}\u001f${name}`;

/**
 * Remembers each table's columns, primary key and kind per saved connection, so reading a page of rows doesn't
 * have to ask the catalog first (one round trip instead of two). Filled in one go by the table-list endpoint;
 * entries expire after CATALOG_TTL_MS and are dropped when a query shows they went stale.
 */
export class CatalogCache {
    private readonly byConnection = new Map<string, Map<string, { meta: RelationMeta; storedAt: number }>>();

    constructor(
        private readonly now: () => number = Date.now,
        private readonly ttlMs: number = CATALOG_TTL_MS,
    ) {}

    /** Replaces everything known about a connection (the table list just re-read the whole catalog). */
    setAll(connectionId: string, relations: RelationMeta[]): void {
        const storedAt = this.now();
        this.byConnection.set(connectionId, new Map(relations.map((meta) => [key(meta.schema, meta.name), { meta, storedAt }])));
    }

    set(connectionId: string, meta: RelationMeta): void {
        let relations = this.byConnection.get(connectionId);
        if (!relations) {
            relations = new Map();
            this.byConnection.set(connectionId, relations);
        }
        relations.set(key(meta.schema, meta.name), { meta, storedAt: this.now() });
    }

    get(connectionId: string, schema: string, name: string): RelationMeta | undefined {
        const relations = this.byConnection.get(connectionId);
        const entry = relations?.get(key(schema, name));
        if (!entry) return undefined;
        if (this.now() - entry.storedAt > this.ttlMs) {
            relations?.delete(key(schema, name));
            return undefined;
        }
        return entry.meta;
    }

    delete(connectionId: string, schema: string, name: string): void {
        this.byConnection.get(connectionId)?.delete(key(schema, name));
    }

    clear(connectionId: string): void {
        this.byConnection.delete(connectionId);
    }
}

export const catalogCache = new CatalogCache();
