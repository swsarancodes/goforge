export interface SqlHistoryEntry {
    id: string;
    sql: string;
    connectionId: string;
    at: number;
    ok: boolean;
    ms: number;
}

export interface StringStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const KEY = "goforge.sql.history.v1";
export const MAX_HISTORY = 50;

function defaultStorage(): StringStorage | undefined {
    try {
        return typeof localStorage === "undefined" ? undefined : localStorage;
    } catch {
        return undefined; // storage blocked
    }
}

const isEntry = (value: unknown): value is SqlHistoryEntry => {
    const entry = value as Partial<SqlHistoryEntry> | null;
    return !!entry && typeof entry.id === "string" && typeof entry.sql === "string" && typeof entry.connectionId === "string" && typeof entry.at === "number" && typeof entry.ok === "boolean" && typeof entry.ms === "number";
};

/** What was run, newest first. Only the SQL text and outcome are kept - never results. */
export function loadSqlHistory(storage: StringStorage | undefined = defaultStorage()): SqlHistoryEntry[] {
    try {
        const raw = storage?.getItem(KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, MAX_HISTORY) : [];
    } catch {
        return [];
    }
}

/** Adds a run to the front; running the same SQL again on the same connection updates that entry instead of repeating it. */
export function addSqlHistory(entry: SqlHistoryEntry, storage: StringStorage | undefined = defaultStorage()): SqlHistoryEntry[] {
    const current = loadSqlHistory(storage);
    const rest = current.filter((existing) => !(existing.connectionId === entry.connectionId && existing.sql.trim() === entry.sql.trim()));
    const next = [entry, ...rest].slice(0, MAX_HISTORY);
    try {
        storage?.setItem(KEY, JSON.stringify(next));
    } catch {
        // quota / blocked: history just isn't remembered
    }
    return next;
}

export function clearSqlHistory(storage: StringStorage | undefined = defaultStorage()): void {
    try {
        storage?.setItem(KEY, "[]");
    } catch {
        // ignore
    }
}
