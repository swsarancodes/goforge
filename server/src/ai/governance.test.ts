import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditToCsv, withoutBodies } from "./audit.js";
import { AiNotConfiguredError, OpenAiError, installOpenAiBackend, type ModelRequest, type ModelResponse, type OpenAiBackend } from "./openai.js";
import { z } from "zod";
import { DEFAULT_MODEL, DEFAULT_SETTINGS, checkModelPolicy, settingsFromStored, type AiSettings } from "./policy.js";
import { ModelPolicyError, callModelJson, getAiStatus, getAuditStore, getSettingsStore, installAiStores, resolveTarget, type AuditEntry } from "./provider.js";

const policy = (extra: Partial<AiSettings> = {}) => ({ ...DEFAULT_SETTINGS, ...extra });

describe("model policy", () => {
    it("applies an allow-list of exact ids and prefixes", () => {
        const list = policy({ allowedModels: ["gpt-5.6-luna", "o4-*"] });
        expect(checkModelPolicy("gpt-5.6-luna", list).allowed).toBe(true);
        expect(checkModelPolicy("o4-mini", list).allowed).toBe(true);
        expect(checkModelPolicy("gpt-5.6-sol", list)).toMatchObject({ allowed: false, reason: expect.stringMatching(/not on this workspace's list/) });
        expect(checkModelPolicy("gpt-5.6-sol", policy()).allowed).toBe(true);
        expect(checkModelPolicy("", policy())).toMatchObject({ allowed: false, reason: "No model is chosen." });
    });

    it("keeps what still means something from settings saved for another kind of endpoint, and drops the rest", () => {
        const custom = settingsFromStored({ provider: "custom", baseUrl: "https://llm.example/v1", model: "house-gpt", apiStyle: "chat", allowedModels: ["house-*"], blockTrainingTiers: true, trainingPatterns: ["free"], redactNames: true, timeoutMs: 60_000 });
        expect(custom).toMatchObject({ model: "", allowedModels: [], redactNames: true });
        expect(custom.timeoutMs).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.timeoutMs);
        expect(custom).not.toHaveProperty("baseUrl");
        expect(custom).not.toHaveProperty("trainingPatterns");

        // saved while Amazon Bedrock was the endpoint: a Bedrock model id or allow-list means nothing to OpenAI
        const bedrock = settingsFromStored({ region: "us-east-1", model: "deepseek.v3.2", allowedModels: ["global.anthropic.*"], timeoutMs: 90_000, redactNames: true });
        expect(bedrock).toMatchObject({ model: "", allowedModels: [], redactNames: true });
        expect(bedrock).not.toHaveProperty("region");

        expect(settingsFromStored({ model: "gpt-5.6-terra", allowedModels: ["gpt-5.6-*"], timeoutMs: 5_000, redactNames: false })).toMatchObject({ model: "gpt-5.6-terra", allowedModels: ["gpt-5.6-*"], timeoutMs: 5_000 });
        expect(settingsFromStored({})).toEqual(DEFAULT_SETTINGS);
    });
});

function freshStores() {
    const settings = { current: { settings: { ...DEFAULT_SETTINGS } } };
    const entries: AuditEntry[] = [];
    installAiStores({
        settings: {
            read: () => settings.current,
            write: (next) => {
                settings.current = { settings: next };
            },
        },
        audit: {
            record: (entry) => {
                entries.unshift({ ...entry, id: entries.length + 1, at: "2026-01-01T00:00:00.000Z" });
                return entries.length;
            },
            list: () => entries,
            get: (id) => entries.find((entry) => entry.id === id),
        },
    });
    return { entries };
}

/** An OpenAI stand-in: records what it is asked and answers with what the test says. */
function fakeBackend(overrides: Partial<OpenAiBackend> = {}) {
    const seen = { respond: [] as ModelRequest[], credentials: 0 };
    const backend: OpenAiBackend = {
        credentials: async () => {
            seen.credentials++;
            return { found: true, source: "OPENAI_API_KEY" };
        },
        respond: async (request) => {
            seen.respond.push(request);
            return answer({ ok: true });
        },
        listModels: async () => [],
        ...overrides,
    };
    installOpenAiBackend(backend);
    return seen;
}

const answer = (value: unknown, extra: Partial<ModelResponse> = {}): ModelResponse => ({ text: JSON.stringify(value), inputTokens: 120, outputTokens: 30, stopReason: "end_turn", ...extra });
const configured = (extra: Partial<AiSettings> = {}) => getSettingsStore().write({ ...DEFAULT_SETTINGS, model: "gpt-test-1", ...extra });

beforeEach(() => {
    vi.stubEnv("OPENAI_MODEL", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    installOpenAiBackend();
});

describe("calling a model through OpenAI", () => {
    it("sends the request to the saved model, reads the usage, and writes everything that was sent to the audit log", async () => {
        const { entries } = freshStores();
        const seen = fakeBackend();
        configured();

        const result = await callModelJson({ instructions: "be brief", input: { a: 1 }, maxOutputTokens: 500, purpose: "schema-plan", context: { connectionId: "c1", connectionName: "main", redacted: true } });

        expect(result).toMatchObject({ output: { ok: true }, model: "gpt-test-1", usage: { inputTokens: 120, outputTokens: 30 }, auditId: 1 });
        expect(seen.respond).toEqual([{ model: "gpt-test-1", instructions: "be brief", input: '{"a":1}', maxOutputTokens: 500 }]);

        expect(entries[0]).toMatchObject({ kind: "model-call", purpose: "schema-plan", status: "ok", connectionName: "main", provider: "openai", model: "gpt-test-1", endpointHost: "api.openai.com", redacted: true, usageInputTokens: 120, usageOutputTokens: 30 });
        expect(JSON.parse(entries[0].payload ?? "{}")).toEqual({ instructions: "be brief", input: '{"a":1}' });
        expect(entries[0].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(entries[0].requestTokensEstimate).toBe(Math.ceil(("be brief".length + '{"a":1}'.length) / 4));
    });

    it("asks for a structured answer when given a schema, and logs the schema with what was sent", async () => {
        const { entries } = freshStores();
        const seen = fakeBackend();
        configured();
        const validator = z.object({ sql: z.string().trim().min(1).max(100), note: z.string().optional() });

        await callModelJson({ instructions: "be brief", input: { a: 1 }, format: { name: "demo", schema: validator } });

        // the model is shown the strict form: every key required, optional ones may be null, limits left to the validator
        const sent = seen.respond[0].format!;
        expect(sent.name).toBe("demo");
        expect(sent.schema).toMatchObject({ type: "object", required: ["sql", "note"], additionalProperties: false });
        expect(JSON.stringify(sent.schema)).not.toMatch(/minLength|maxLength/);

        // and the audit log holds exactly that, hashed with the rest
        const payload = JSON.parse(entries[0].payload ?? "{}");
        expect(payload).toEqual({ instructions: "be brief", input: '{"a":1}', responseFormat: sent });
        expect(entries[0].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(entries[0].requestChars).toBeGreaterThan("be brief".length + '{"a":1}'.length);

        // without one, the payload is as it always was
        await callModelJson({ instructions: "be brief", input: { a: 1 } });
        expect(JSON.parse(entries[0].payload ?? "{}")).toEqual({ instructions: "be brief", input: '{"a":1}' });
        expect(seen.respond[1]).not.toHaveProperty("format");
    });

    it("refuses a schema the API could not take before anything is sent or logged", async () => {
        const { entries } = freshStores();
        const seen = fakeBackend();
        configured();
        await expect(callModelJson({ instructions: "i", input: "x", format: { name: "bad", schema: z.object({ lookup: z.map(z.string(), z.string()) }) } })).rejects.toThrow(/ZodMap/);
        expect(seen.respond).toHaveLength(0);
        expect(entries).toHaveLength(0);
    });

    it("records the host from OPENAI_BASE_URL", async () => {
        const { entries } = freshStores();
        fakeBackend();
        configured();
        vi.stubEnv("OPENAI_BASE_URL", "https://eu.api.openai.com/v1");
        await callModelJson({ instructions: "i", input: "x" });
        expect(entries[0]).toMatchObject({ endpointHost: "eu.api.openai.com" });
    });

    it("takes the model from the workspace, else OPENAI_MODEL, else gpt-5.6-luna", async () => {
        freshStores();
        const seen = fakeBackend();
        await callModelJson({ instructions: "i", input: "x" });
        expect(seen.respond[0].model).toBe(DEFAULT_MODEL);
        expect(DEFAULT_MODEL).toBe("gpt-5.6-luna");
        expect(resolveTarget().target).toMatchObject({ modelFrom: "default" });

        vi.stubEnv("OPENAI_MODEL", "gpt-5.6-terra");
        await callModelJson({ instructions: "i", input: "x" });
        expect(seen.respond[1].model).toBe("gpt-5.6-terra");
        expect(resolveTarget().target).toMatchObject({ modelFrom: "env" });

        // what is saved in the workspace wins over the environment
        configured({ model: "saved-model" });
        await callModelJson({ instructions: "i", input: "x" });
        expect(seen.respond[2].model).toBe("saved-model");
        expect(resolveTarget().target).toMatchObject({ modelFrom: "settings" });
    });

    it("accepts an answer wrapped in a code fence or in a sentence", async () => {
        freshStores();
        configured();
        fakeBackend({ respond: async () => answer("", { text: '```json\n{"ok": true}\n```' }) });
        await expect(callModelJson({ instructions: "x", input: "y" })).resolves.toMatchObject({ output: { ok: true } });
        fakeBackend({ respond: async () => answer("", { text: 'Sure! {"ok": 1} hope that helps' }) });
        await expect(callModelJson({ instructions: "x", input: "y" })).resolves.toMatchObject({ output: { ok: 1 } });
    });

    it("refuses a model the allow-list does not name, before anything is sent, and records that it did", async () => {
        const { entries } = freshStores();
        const seen = fakeBackend();
        configured({ allowedModels: ["o4-*"] });
        await expect(callModelJson({ instructions: "i", input: "secret schema" })).rejects.toBeInstanceOf(ModelPolicyError);
        expect(seen.respond).toHaveLength(0);
        expect(entries[0]).toMatchObject({ status: "blocked", model: "gpt-test-1" });
        expect(entries[0].payload).toBeNull();
        expect(JSON.stringify(entries)).not.toContain("secret schema");
    });

    it("says what to configure when there is no API key, and sends nothing", async () => {
        freshStores();
        const seen = fakeBackend({ credentials: async () => ({ found: false, message: "No OpenAI API key is set. Put OPENAI_API_KEY=sk-... in server/.env and restart the API." }) });
        const error = await callModelJson({ instructions: "i", input: "x" }).catch((caught) => caught);
        expect(error).toBeInstanceOf(AiNotConfiguredError);
        expect(error.message).toMatch(/OPENAI_API_KEY/);
        expect(seen.respond).toHaveLength(0);
    });

    it("records a failure with the reason, and turns a timeout into one", async () => {
        const { entries } = freshStores();
        configured({ timeoutMs: 1000 });
        fakeBackend({ respond: async () => { throw new OpenAiError("Incorrect API key provided", 401, "invalid_api_key", "invalid_request_error"); } });
        await expect(callModelJson({ instructions: "i", input: "x" })).rejects.toThrow(/rejected the API key in OPENAI_API_KEY/);
        expect(entries[0]).toMatchObject({ status: "error", error: expect.stringContaining("invalid_api_key") });

        fakeBackend({ respond: (_request, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
        vi.useFakeTimers();
        const pending = callModelJson({ instructions: "i", input: "x" });
        const assertion = expect(pending).rejects.toThrow("The OpenAI request timed out after 1 s");
        await vi.advanceTimersByTimeAsync(1100);
        await assertion;
    });

    it("reports an answer cut off at the output limit as that, not as invalid JSON", async () => {
        freshStores();
        configured();
        fakeBackend({ respond: async () => answer("", { text: '{"summary": "half of', stopReason: "max_tokens" }) });
        await expect(callModelJson({ instructions: "i", input: "x", maxOutputTokens: 300 })).rejects.toThrow(/output limit \(300 tokens, thinking included\)/);
        fakeBackend({ respond: async () => answer("", { text: "   " }) });
        await expect(callModelJson({ instructions: "i", input: "x" })).rejects.toThrow(/no text output/);
    });
});

describe("what the UI is told", () => {
    it("is ready when a model and a key are there, and carries no secret", async () => {
        freshStores();
        fakeBackend();
        configured();
        const status = await getAiStatus();
        expect(status).toEqual({ configured: true, provider: "openai", model: "gpt-test-1", modelFrom: "settings", endpointHost: "api.openai.com", credentials: "found", credentialsSource: "OPENAI_API_KEY", allowed: true, problem: null, redactNames: false });
    });

    it("is ready out of the box once a key is set, using gpt-5.6-luna", async () => {
        freshStores();
        fakeBackend();
        expect(await getAiStatus()).toMatchObject({ configured: true, model: "gpt-5.6-luna", modelFrom: "default" });
    });

    it("names the first thing that is missing", async () => {
        freshStores();
        fakeBackend({ credentials: async () => ({ found: false, message: "No OpenAI API key is set." }) });
        expect(await getAiStatus()).toMatchObject({ configured: false, model: "gpt-5.6-luna", credentials: "missing", problem: expect.stringMatching(/No OpenAI API key is set/) });

        configured({ allowedModels: ["o4-*"] });
        expect(await getAiStatus()).toMatchObject({ configured: false, allowed: false, problem: expect.stringMatching(/not on this workspace's list/) });
    });
});

describe("audit export", () => {
    const entry = (extra: Partial<AuditEntry> = {}): AuditEntry => ({ id: 1, at: "2026-01-01T00:00:00.000Z", kind: "model-call", purpose: "schema-plan", status: "ok", model: "m", payload: '{"instructions":"x"}', response: "{}", ...extra });

    it("writes one row per entry, quoting what needs it and neutralising spreadsheet formulas", () => {
        const csv = auditToCsv([entry({ id: 2, error: '=HYPERLINK("http://x")', connectionName: "main, prod", detail: { tables: ["a", "b"] } }), entry()]).split("\r\n");
        expect(csv[0]).toMatch(/^id,at,kind,purpose,status,connection,provider,model,/);
        expect(csv[1]).toContain('"main, prod"');
        expect(csv[1]).toContain(`"'=HYPERLINK(""http://x"")"`);
        expect(csv[1]).toContain('"{""tables"":[""a"",""b""]}"');
        expect(csv).toHaveLength(4);
        expect(csv.join("")).not.toContain("instructions");
    });

    it("lists entries without their bodies", () => {
        expect(withoutBodies(entry())).toMatchObject({ id: 1, hasPayload: true });
        expect(withoutBodies(entry())).not.toHaveProperty("payload");
        expect(getAuditStore()).toBeDefined();
    });
});
