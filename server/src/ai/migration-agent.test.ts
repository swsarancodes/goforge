import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMigrationAgentInstructions, createMigrationAgentReply, migrationAgentRequestSchema, migrationAgentResultSchema, type AgentState } from "./migration-agent.js";
import { installOpenAiBackend, type ModelRequest } from "./openai.js";
import { DEFAULT_SETTINGS } from "./policy.js";
import { installAiStores } from "./provider.js";

const state: AgentState = {
    tables: [{ oracleName: "CLM", pgName: "clm", rows: 160, renamed: false, columns: [{ oracleName: "CLM_DT", pgName: "clm_dt", oracleType: "DATE", pgType: "timestamp(0)", status: "changed", note: "n", edited: [], oracleDefault: null, allowedPgTypes: ["timestamp(n)", "date", "text"] }] }],
    problems: [],
    editProblems: [],
    notCarried: [],
};

const seen: ModelRequest[] = [];
const stub = (output: unknown) => {
    seen.length = 0;
    installOpenAiBackend({
        credentials: async () => ({ found: true, source: "OPENAI_API_KEY" }),
        respond: async (modelRequest) => {
            seen.push(modelRequest);
            return { text: typeof output === "string" ? output : JSON.stringify(output), inputTokens: 10, outputTokens: 5, stopReason: "end_turn" };
        },
        listModels: async () => [],
    });
};
beforeEach(() => {
    installAiStores({ settings: { read: () => ({ settings: { ...DEFAULT_SETTINGS, model: "test-model" } }), write: () => undefined }, audit: { record: () => 1, list: () => [], get: () => undefined } });
});
afterEach(() => installOpenAiBackend());

describe("what the assistant may answer with", () => {
    it("accepts each operation and refuses one it does not have", () => {
        const ok = migrationAgentResultSchema.safeParse({
            reply: "Done.",
            operations: [
                { op: "rename_table", table: "CLM", newName: "claim" },
                { op: "rename_column", table: "CLM", column: "CLM_DT", newName: "claim_date" },
                { op: "set_column_type", table: "CLM", column: "CLM_DT", pgType: "date" },
                { op: "drop_default", table: "CLM", column: "CLM_DT" },
                { op: "reset_column", table: "CLM", column: "CLM_DT" },
                { op: "reset_table", table: "CLM" },
            ],
        });
        expect(ok.success).toBe(true);
        expect(migrationAgentResultSchema.safeParse({ reply: "x", operations: [{ op: "drop_table", table: "CLM" }] }).success).toBe(false);
        expect(migrationAgentResultSchema.safeParse({ reply: "x", operations: [{ op: "set_column_type", table: "CLM", column: "A" }] }).success).toBe(false);
    });

    it("limits what a request may carry", () => {
        expect(migrationAgentRequestSchema.safeParse({ sourceConnectionId: "a", message: "" }).success).toBe(false);
        expect(migrationAgentRequestSchema.safeParse({ sourceConnectionId: "a", message: "hi", messages: Array.from({ length: 31 }, () => ({ role: "user", text: "x" })) }).success).toBe(false);
        expect(migrationAgentRequestSchema.parse({ sourceConnectionId: "a", message: "hi" })).toMatchObject({ messages: [], edits: { tables: {}, columns: {} } });
    });

    it("tells the model the rules that keep it inside the plan", () => {
        const text = buildMigrationAgentInstructions();
        for (const phrase of ["allowedPgTypes", "Never invent", "only that", "reset_column", "no access to the data", "You are CosmicQuery"]) expect(text).toContain(phrase);
    });
});

describe("asking the assistant", () => {
    it("sends the plan, the changes so far, the conversation and the message, and a strict schema, and returns the answer", async () => {
        stub({ reply: "Made it a date.", operations: [{ op: "set_column_type", table: "CLM", column: "CLM_DT", pgType: "date" }] });
        const { result, model } = await createMigrationAgentReply({ state, messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }], message: "make the dates real dates", currentEdits: { tables: {}, columns: {} } });
        expect(model).toBe("test-model");
        expect(result.operations).toEqual([{ op: "set_column_type", table: "CLM", column: "CLM_DT", pgType: "date" }]);
        const sent = JSON.parse(seen[0].input as string);
        expect(sent.personSays).toBe("make the dates real dates");
        expect(sent.plan.tables[0].columns[0].allowedPgTypes).toEqual(["timestamp(n)", "date", "text"]);
        expect(sent.conversation).toHaveLength(2);
        expect(seen[0].format?.name).toBe("migration_agent_reply");
    });

    it("keeps only the last twelve messages of the conversation", async () => {
        stub({ reply: "ok", operations: [] });
        const messages = Array.from({ length: 30 }, (_, index) => ({ role: "user" as const, text: `m${index}` }));
        await createMigrationAgentReply({ state, messages, message: "again", currentEdits: {} });
        const sent = JSON.parse(seen[0].input as string);
        expect(sent.conversation.map((entry: { text: string }) => entry.text)).toEqual(messages.slice(-12).map((entry) => entry.text));
    });

    it("says so when the answer is not in the shape it asked for", async () => {
        stub({ reply: "x", operations: [{ op: "drop_everything" }] });
        await expect(createMigrationAgentReply({ state, messages: [], message: "go", currentEdits: {} })).rejects.toThrow(/invalid answer/);
        stub("not json at all");
        await expect(createMigrationAgentReply({ state, messages: [], message: "go", currentEdits: {} })).rejects.toThrow();
    });
});
