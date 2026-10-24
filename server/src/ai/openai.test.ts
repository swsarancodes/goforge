import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AiNotConfiguredError, OpenAiError, friendlyOpenAiError, getOpenAi, installOpenAiBackend, openAiBaseUrl, reasoningEffortFor } from "./openai.js";

/**
 * The real client, sending its real HTTP requests, against a local stand-in for the OpenAI API. What is checked is what goes over the
 * wire and how answers and errors come back; nothing here says anything about what a real model answers.
 */

interface Seen {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}
let seen: Seen[] = [];
let reply: (request: Seen) => { status?: number; json: unknown; headers?: Record<string, string> } = () => ({ json: {} });
let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
    installOpenAiBackend();
    server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const entry: Seen = { method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
            seen.push(entry);
            const { status = 200, json, headers = {} } = reply(entry);
            response.writeHead(status, { "Content-Type": "application/json", ...headers });
            response.end(JSON.stringify(json));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
    seen = [];
    vi.stubEnv("OPENAI_BASE_URL", baseUrl);
    vi.stubEnv("OPENAI_API_KEY", "sk-test-only-not-real");
    vi.stubEnv("OPENAI_REASONING_EFFORT", "");
    // The SDK tries a failed request again after a pause; most tests want to see the failure at once.
    vi.stubEnv("OPENAI_MAX_RETRIES", "0");
});

const answer = (text: string, extra: Record<string, unknown> = {}) => ({
    id: "resp_1",
    status: "completed",
    output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    ...extra,
});
const request = { model: "gpt-5.6-luna", instructions: "Return JSON only.", input: '{"q":1}', maxOutputTokens: 321 };

describe("the Responses call", () => {
    it("sends the model, instructions, input and output limit with the key from the environment, and reads the answer and usage", async () => {
        reply = () => ({ json: answer('{"ok":true}') });
        const response = await getOpenAi().respond(request);

        expect(response).toEqual({ text: '{"ok":true}', inputTokens: 11, outputTokens: 7, stopReason: "end_turn" });
        expect(seen).toHaveLength(1);
        expect(seen[0].method).toBe("POST");
        expect(seen[0].url).toBe("/v1/responses");
        expect(seen[0].headers.authorization).toBe("Bearer sk-test-only-not-real");
        expect(JSON.parse(seen[0].body)).toEqual({
            model: "gpt-5.6-luna",
            instructions: "Return JSON only.",
            input: '{"q":1}',
            max_output_tokens: 321,
            store: false,
            reasoning: { effort: "low" },
            text: { format: { type: "json_object" } },
        });
        // the key travels in the header only
        expect(seen[0].body).not.toContain("sk-test-only-not-real");
    });

    it("asks for JSON mode only when the prompt mentions JSON, and sends no reasoning setting to a model that does not reason", async () => {
        reply = () => ({ json: answer("hello") });
        await getOpenAi().respond({ model: "gpt-4.1", instructions: "Say hello.", input: "hi", maxOutputTokens: 10 });
        const body = JSON.parse(seen[0].body);
        expect(body).not.toHaveProperty("text");
        expect(body).not.toHaveProperty("reasoning");
    });

    it("takes the reasoning effort from OPENAI_REASONING_EFFORT, for models that reason", () => {
        expect(reasoningEffortFor("gpt-5.6-luna")).toBe("low");
        expect(reasoningEffortFor("gpt-4.1")).toBeUndefined();
        vi.stubEnv("OPENAI_REASONING_EFFORT", "HIGH");
        expect(reasoningEffortFor("gpt-5.6-luna")).toBe("high");
        expect(reasoningEffortFor("gpt-4.1")).toBeUndefined();
        vi.stubEnv("OPENAI_REASONING_EFFORT", "bogus");
        expect(reasoningEffortFor("gpt-5.6-luna")).toBe("low");
    });

    it("joins several text parts and reports an answer cut off at the output limit", async () => {
        reply = () => ({
            json: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", content: [{ type: "output_text", text: '{"a":' }, { type: "output_text", text: "1" }] }], usage: { input_tokens: 1, output_tokens: 2 } },
        });
        await expect(getOpenAi().respond(request)).resolves.toMatchObject({ text: '{"a":1', stopReason: "max_tokens" });
    });

    it("says so when the model declines instead of answering", async () => {
        reply = () => ({ json: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }] } });
        await expect(getOpenAi().respond(request)).rejects.toThrow(/declined to answer: I can't help with that/);
    });

    it("turns what OpenAI refuses with into words that say what to do", async () => {
        const failure = async (status: number, message: string, code: string | null = null, type = "invalid_request_error") => {
            reply = () => ({ status, json: { error: { message, type, code, param: null } } });
            return getOpenAi().respond(request).then(
                () => "no error",
                (error) => friendlyOpenAiError(error),
            );
        };
        expect(await failure(401, "Incorrect API key provided: sk-test***.", "invalid_api_key")).toMatch(/rejected the API key in OPENAI_API_KEY/);
        expect(await failure(404, "The model `gpt-9` does not exist or you do not have access to it.", "model_not_found")).toMatch(/does not know this model.*gpt-5\.6-luna/);
        expect(await failure(429, "You exceeded your current quota.", "insufficient_quota", "insufficient_quota")).toMatch(/no credit or quota/);
        expect(await failure(429, "Rate limit reached for requests", "rate_limit_exceeded", "requests")).toMatch(/rate limiting/);
        expect(await failure(403, "Project does not have access to model")).toMatch(/lack access/);
        expect(await failure(500, "The server had an error")).toMatch(/could not serve the request/);
        expect(await failure(400, "Unsupported parameter: 'reasoning.effort'.")).toMatch(/OpenAI returned an error.*Unsupported parameter/);
    });

    it("asks for a structured answer when given a response schema, and says exactly what the schema is", async () => {
        const schema = { type: "object", properties: { sql: { type: "string" } }, required: ["sql"], additionalProperties: false };
        reply = () => ({ json: answer('{"sql":"select 1"}') });
        await expect(getOpenAi().respond({ ...request, format: { name: "modernize_query", schema } })).resolves.toMatchObject({ text: '{"sql":"select 1"}' });
        expect(JSON.parse(seen[0].body).text).toEqual({ format: { type: "json_schema", name: "modernize_query", strict: true, schema } });
    });

    it("answers in JSON mode again, once, when the model does not take a schema, and for no other kind of refusal", async () => {
        const format = { name: "x", schema: { type: "object", properties: {}, required: [], additionalProperties: false } };
        reply = (incoming) =>
            incoming.body.includes('"json_schema"')
                ? { status: 400, json: { error: { message: "Invalid parameter: 'text.format' of type 'json_schema' is not supported with this model.", type: "invalid_request_error", code: "unsupported_parameter" } } }
                : { json: answer("{}") };
        await expect(getOpenAi().respond({ ...request, format })).resolves.toMatchObject({ text: "{}" });
        expect(seen).toHaveLength(2);
        expect(JSON.parse(seen[0].body).text.format.type).toBe("json_schema");
        expect(JSON.parse(seen[1].body).text.format).toEqual({ type: "json_object" });

        // a schema OpenAI finds wrong is a bug to be seen, not hidden by answering without it
        seen = [];
        reply = () => ({ status: 400, json: { error: { message: "Invalid schema for response_format 'x': 'additionalProperties' is required to be supplied and to be false.", type: "invalid_request_error", code: "invalid_json_schema" } } });
        await expect(getOpenAi().respond({ ...request, format })).rejects.toBeInstanceOf(OpenAiError);
        expect(seen).toHaveLength(1);
    });

    it("tries a rate-limited request again, as the SDK does, unless retries are off", async () => {
        vi.stubEnv("OPENAI_MAX_RETRIES", "1");
        let attempts = 0;
        reply = () => (++attempts === 1 ? { status: 429, headers: { "retry-after-ms": "1" }, json: { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } } } : { json: answer('{"ok":true}') });
        await expect(getOpenAi().respond(request)).resolves.toMatchObject({ text: '{"ok":true}' });
        expect(seen).toHaveLength(2);

        seen = [];
        attempts = 0;
        vi.stubEnv("OPENAI_MAX_RETRIES", "0");
        await expect(getOpenAi().respond(request)).rejects.toMatchObject({ status: 429 });
        expect(seen).toHaveLength(1);
    });

    it("reads a bad retry setting as the default", async () => {
        const { maxRetries } = await import("./openai.js");
        for (const value of ["", "x", "-1", "9", "1.5"]) {
            vi.stubEnv("OPENAI_MAX_RETRIES", value);
            expect(maxRetries(), value).toBe(2);
        }
        vi.stubEnv("OPENAI_MAX_RETRIES", "3");
        expect(maxRetries()).toBe(3);
    });

    it("can be cancelled", async () => {
        reply = () => ({ json: answer("{}") });
        const controller = new AbortController();
        controller.abort();
        await expect(getOpenAi().respond(request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    });

    it("sends nothing without a key", async () => {
        vi.stubEnv("OPENAI_API_KEY", "");
        await expect(getOpenAi().respond(request)).rejects.toBeInstanceOf(AiNotConfiguredError);
        expect(seen).toHaveLength(0);
    });
});

describe("the key", () => {
    it("is found when the environment has one, and the answer never contains it", async () => {
        const state = await getOpenAi().credentials();
        expect(state).toEqual({ found: true, source: "OPENAI_API_KEY" });
        expect(JSON.stringify(state)).not.toContain("sk-test-only-not-real");
    });

    it("is reported missing, with what to do about it, when it is blank", async () => {
        vi.stubEnv("OPENAI_API_KEY", "   ");
        expect(await getOpenAi().credentials()).toMatchObject({ found: false, message: expect.stringMatching(/OPENAI_API_KEY=sk-.*server\/\.env/) });
    });
});

describe("OPENAI_BASE_URL", () => {
    it("defaults to OpenAI, drops a trailing slash, and refuses to send the key anywhere unencrypted", () => {
        vi.stubEnv("OPENAI_BASE_URL", "");
        expect(openAiBaseUrl()).toBe("https://api.openai.com/v1");
        vi.stubEnv("OPENAI_BASE_URL", "https://eu.api.openai.com/v1/");
        expect(openAiBaseUrl()).toBe("https://eu.api.openai.com/v1");
        vi.stubEnv("OPENAI_BASE_URL", "http://llm.example.com/v1");
        expect(() => openAiBaseUrl()).toThrow(/must start with https/);
        vi.stubEnv("OPENAI_BASE_URL", "not a url");
        expect(() => openAiBaseUrl()).toThrow(/not a URL/);
        vi.stubEnv("OPENAI_BASE_URL", "http://localhost:4010/v1");
        expect(openAiBaseUrl()).toBe("http://localhost:4010/v1");
    });
});

describe("the list of models", () => {
    it("offers the text models the key can see, without embeddings, speech or image models", async () => {
        reply = () => ({
            json: {
                object: "list",
                data: [
                    { id: "gpt-5.6-luna", object: "model", owned_by: "system" },
                    { id: "gpt-5.6-sol", object: "model", owned_by: "system" },
                    { id: "gpt-5.6-luna", object: "model", owned_by: "system" },
                    { id: "text-embedding-3-large", owned_by: "system" },
                    { id: "whisper-1", owned_by: "openai-internal" },
                    { id: "gpt-image-1", owned_by: "system" },
                    { id: "gpt-4o-realtime-preview", owned_by: "system" },
                    { id: "o4-mini", owned_by: "system" },
                    { id: "tts-1", owned_by: "openai-internal" },
                ],
            },
        });
        const models = await getOpenAi().listModels();
        expect(models.map((model) => model.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "o4-mini"]);
        expect(seen[0]).toMatchObject({ method: "GET", url: "/v1/models" });
        expect(seen[0].headers.authorization).toBe("Bearer sk-test-only-not-real");
    });

    it("reports a refused key as words, not a stack", async () => {
        reply = () => ({ status: 401, json: { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } } });
        const error = await getOpenAi().listModels().catch((caught) => caught);
        expect(error).toBeInstanceOf(OpenAiError);
        expect(friendlyOpenAiError(error)).toMatch(/rejected the API key/);
    });
});

describe("friendlyOpenAiError", () => {
    it("explains an unreachable network, and passes anything else through", () => {
        const unreachable = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
        expect(friendlyOpenAiError(unreachable)).toMatch(/Could not reach OpenAI at .*ENOTFOUND/);
        expect(friendlyOpenAiError(new Error("something else"))).toBe("something else");
    });
});
