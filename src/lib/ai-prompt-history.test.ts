import { describe, expect, it } from "vitest";
import {
    addAiPromptHistory,
    clearAiPromptHistory,
    loadAiPromptHistory,
    updateAiPromptHistoryStatus,
} from "./ai-prompt-history";

const memoryStorage = () => {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    };
};

describe("AI prompt history", () => {
    it("stores history per database and updates its lifecycle status", () => {
        const storage = memoryStorage();
        const saved = addAiPromptHistory({
            databaseId: "db-1",
            prompt: "Add audit logs",
            scope: "database",
            selectedTables: [],
            status: "generated",
            summary: "Add audit logging",
        }, storage);
        addAiPromptHistory({
            databaseId: "db-2",
            prompt: "Add tenants",
            scope: "database",
            selectedTables: [],
            status: "generated",
        }, storage);

        updateAiPromptHistoryStatus(saved.id, "applied", storage);
        expect(loadAiPromptHistory("db-1", storage)).toMatchObject([
            { prompt: "Add audit logs", status: "applied" },
        ]);
        expect(loadAiPromptHistory("db-2", storage)).toHaveLength(1);

        clearAiPromptHistory("db-1", storage);
        expect(loadAiPromptHistory("db-1", storage)).toEqual([]);
        expect(loadAiPromptHistory("db-2", storage)).toHaveLength(1);
    });
});
