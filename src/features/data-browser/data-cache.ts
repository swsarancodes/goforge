import type { RelationInfo, TableDataPage } from "@/lib/live-connection-api";

export interface PageKeyParts {
    connectionId: string;
    schema: string;
    table: string;
    sort?: string;
    dir?: "asc" | "desc";
    offset: number;
    pageSize: number;
}

const SEP = "\u001f";

/** Identifies one page of one table under one sort. Starts with the connection id so a connection can be cleared by prefix. */
export function pageKey(parts: PageKeyParts): string {
    return [parts.connectionId, parts.schema, parts.table, parts.sort ?? "", parts.sort ? (parts.dir ?? "asc") : "", parts.offset, parts.pageSize].join(SEP);
}

export const connectionPrefix = (connectionId: string) => `${connectionId}${SEP}`;

/**
 * Small in-memory stale-while-revalidate cache: `get` says whether the entry is still fresh. Callers show a
 * stale entry immediately and refresh it in the background. Least recently used entries are evicted first.
 */
export class SwrCache<T> {
    private readonly entries = new Map<string, { value: T; storedAt: number }>();

    constructor(
        private readonly maxEntries = 40,
        private readonly freshMs = 30_000,
        private readonly now: () => number = Date.now,
    ) {}

    get(key: string): { value: T; fresh: boolean } | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        // Re-insert to mark it as most recently used.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return { value: entry.value, fresh: this.now() - entry.storedAt <= this.freshMs };
    }

    set(key: string, value: T): void {
        this.entries.delete(key);
        this.entries.set(key, { value, storedAt: this.now() });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    deleteWithPrefix(prefix: string): void {
        for (const key of Array.from(this.entries.keys())) {
            if (key.startsWith(prefix)) this.entries.delete(key);
        }
    }

    get size(): number {
        return this.entries.size;
    }
}

/** Pages of rows already read in this tab. Never written to disk: row data stays in memory only. */
export const pageCache = new SwrCache<TableDataPage>();

// ---- table lists -----------------------------------------------------------------------------------------------

const RELATIONS_STORAGE_PREFIX = "goforge.relations.v1.";

export interface StringStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function defaultStorage(): StringStorage | undefined {
    try {
        return typeof localStorage === "undefined" ? undefined : localStorage;
    } catch {
        return undefined; // storage blocked (private window, site data disabled)
    }
}

const isRelationInfo = (value: unknown): value is RelationInfo => {
    const info = value as Partial<RelationInfo> | null;
    return !!info && typeof info.schema === "string" && typeof info.name === "string" && typeof info.kind === "string" && (info.estimatedRows === null || typeof info.estimatedRows === "number");
};

/** The table list last seen for a connection (names, kinds and row estimates only), so a reload can paint it instantly. */
export function loadStoredRelations(connectionId: string, storage: StringStorage | undefined = defaultStorage()): RelationInfo[] | undefined {
    try {
        const raw = storage?.getItem(RELATIONS_STORAGE_PREFIX + connectionId);
        if (!raw) return undefined;
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.every(isRelationInfo) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

export function storeRelations(connectionId: string, relations: RelationInfo[], storage: StringStorage | undefined = defaultStorage()): void {
    try {
        storage?.setItem(RELATIONS_STORAGE_PREFIX + connectionId, JSON.stringify(relations));
    } catch {
        // Quota or blocked storage: the list just won't be remembered.
    }
}
