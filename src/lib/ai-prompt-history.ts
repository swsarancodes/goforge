import { v4 } from "uuid";

export type AiPromptHistoryStatus = "generated" | "clarification" | "applied" | "rejected";

export interface AiPromptHistoryEntry {
    id: string;
    databaseId: string;
    prompt: string;
    scope: "database" | "selected_tables";
    selectedTables: string[];
    createdAt: string;
    status: AiPromptHistoryStatus;
    summary?: string;
}

interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

const HISTORY_KEY = "goforge.ai-schema.prompt-history.v1";
const MAX_HISTORY_ITEMS = 30;

const browserStorage = (): StorageLike | undefined =>
    typeof window === "undefined" ? undefined : window.localStorage;

const readAll = (storage: StorageLike | undefined): AiPromptHistoryEntry[] => {
    if (!storage) return [];
    try {
        const parsed = JSON.parse(storage.getItem(HISTORY_KEY) ?? "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

export const loadAiPromptHistory = (
    databaseId: string,
    storage: StorageLike | undefined = browserStorage(),
) => readAll(storage).filter((entry) => entry.databaseId === databaseId);

export const addAiPromptHistory = (
    entry: Omit<AiPromptHistoryEntry, "id" | "createdAt">,
    storage: StorageLike | undefined = browserStorage(),
): AiPromptHistoryEntry => {
    const saved: AiPromptHistoryEntry = {
        ...entry,
        id: v4(),
        createdAt: new Date().toISOString(),
    };
    if (!storage) return saved;

    const history = [saved, ...readAll(storage)].slice(0, MAX_HISTORY_ITEMS);
    storage.setItem(HISTORY_KEY, JSON.stringify(history));
    return saved;
};

export const updateAiPromptHistoryStatus = (
    id: string,
    status: AiPromptHistoryStatus,
    storage: StorageLike | undefined = browserStorage(),
) => {
    if (!storage) return;
    const history = readAll(storage).map((entry) => entry.id === id ? { ...entry, status } : entry);
    storage.setItem(HISTORY_KEY, JSON.stringify(history));
};

export const clearAiPromptHistory = (
    databaseId: string,
    storage: StorageLike | undefined = browserStorage(),
) => {
    if (!storage) return;
    const remaining = readAll(storage).filter((entry) => entry.databaseId !== databaseId);
    if (remaining.length === 0) storage.removeItem(HISTORY_KEY);
    else storage.setItem(HISTORY_KEY, JSON.stringify(remaining));
};
