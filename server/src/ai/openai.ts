import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";

/**
 * The only way a model is reached: OpenAI's official SDK, calling the Responses API with the OPENAI_API_KEY in the environment of the API
 * process. GoForge stores no key of its own, and the key is only ever sent to OPENAI_BASE_URL (default https://api.openai.com/v1), which
 * is set in server/.env and can never be changed from the browser. The SDK is used here and nowhere else, so tests can replace this one
 * seam and nothing else in the app knows which library talks to OpenAI.
 */

/** What the model is asked to answer with: a JSON schema, built from one of our zod validators (see `structured.ts`). */
export interface ResponseSchema {
    name: string;
    schema: Record<string, unknown>;
}

export interface ModelRequest {
    model: string;
    instructions: string;
    input: string;
    /** Counts the model's reasoning as well as its visible answer. */
    maxOutputTokens: number;
    /** When given the answer must match it (structured outputs); otherwise JSON mode is used for a prompt that asks for JSON. */
    format?: ResponseSchema;
}

export interface ModelResponse {
    text: string;
    inputTokens: number | null;
    outputTokens: number | null;
    /** Why the model stopped: `end_turn`, `max_tokens` (the output limit, reasoning included) or `content_filter`. */
    stopReason: string | null;
}

export type CredentialState = { found: true; source: string } | { found: false; message: string };

export interface OpenAiModelEntry {
    id: string;
    owner: string;
}

export interface OpenAiBackend {
    credentials(): Promise<CredentialState>;
    respond(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
    listModels(signal?: AbortSignal): Promise<OpenAiModelEntry[]>;
}

/** Thrown for anything the person can fix by configuration; the routes answer 503 for it. */
export class AiNotConfiguredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AiNotConfiguredError";
    }
}

/** What OpenAI answered with when it refused a request. The SDK's own error types stop here; the rest of the app sees this one. */
export class OpenAiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code: string | null,
        readonly type: string | null,
    ) {
        super(message);
        this.name = "OpenAiError";
    }
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** OPENAI_BASE_URL, or OpenAI's own. Must be https (http only for a stand-in on this machine), because the API key is sent there. */
export function openAiBaseUrl(): string {
    const raw = process.env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new AiNotConfiguredError(`OPENAI_BASE_URL in server/.env is not a URL: ${raw}`);
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
        throw new AiNotConfiguredError("OPENAI_BASE_URL in server/.env must start with https:// (http:// is only accepted for localhost), because the API key is sent there.");
    }
    return raw.replace(/\/+$/, "");
}

/** The host requests go to, for the audit log. Empty when OPENAI_BASE_URL is invalid (the request itself then says why). */
export function openAiHost(): string {
    try {
        return new URL(openAiBaseUrl()).host;
    } catch {
        return "";
    }
}

const apiKey = (): string => process.env.OPENAI_API_KEY?.trim() ?? "";

export const NO_KEY_MESSAGE = "No OpenAI API key is set. Put OPENAI_API_KEY=sk-... in server/.env and restart the API. The key stays on the server and is never sent to the browser.";

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * How hard GPT-5 and o-series models think before they answer. They reason by default (medium), and that thinking is counted against
 * the output limit, so the short structured answers here would often be cut off. They get `low` unless OPENAI_REASONING_EFFORT says
 * otherwise; other models are sent no reasoning setting, which they would reject.
 */
export function reasoningEffortFor(model: string): string | undefined {
    const configured = process.env.OPENAI_REASONING_EFFORT?.trim().toLowerCase();
    const reasons = /^(gpt-5|gpt-6|o\d)/i.test(model);
    if (configured && REASONING_EFFORTS.has(configured)) return reasons ? configured : undefined;
    return reasons ? "low" : undefined;
}

/** How many times the SDK tries again after a rate limit, a server error or a dropped connection (OPENAI_MAX_RETRIES, default 2). */
export function maxRetries(): number {
    const text = process.env.OPENAI_MAX_RETRIES?.trim() ?? "";
    // A blank value (a line left empty in server/.env) is "not set", not zero.
    const configured = text === "" ? Number.NaN : Number(text);
    return Number.isInteger(configured) && configured >= 0 && configured <= 5 ? configured : 2;
}

/**
 * The JSON schema OpenAI is given for a structured answer, written by the SDK's own zod helper from an already strict-compatible
 * validator (`forModel` in structured.ts). Throws if the helper finds something strict mode cannot take, which is a bug in the schema.
 */
export function buildResponseSchema(name: string, strictValidator: z.ZodTypeAny): ResponseSchema {
    const { schema } = zodTextFormat(strictValidator as never, name);
    const { $schema: _draft, ...rest } = schema as Record<string, unknown>;
    return { name, schema: rest };
}

let cached: { key: string; client: OpenAI } | undefined;
function client(): OpenAI {
    const key = apiKey();
    if (!key) throw new AiNotConfiguredError(NO_KEY_MESSAGE);
    const baseURL = openAiBaseUrl();
    const retries = maxRetries();
    const id = `${key}\u0000${baseURL}\u0000${retries}`;
    // Our own timeout is the abort signal of each request; the SDK's is only a backstop for a request that has none.
    if (cached?.key !== id) cached = { key: id, client: new OpenAI({ apiKey: key, baseURL, maxRetries: retries, timeout: 15 * 60_000 }) };
    return cached.client;
}

const abortError = (): Error => Object.assign(new Error("The request was aborted"), { name: "AbortError" });

/** SDK errors in this app's terms: a refusal from OpenAI is an `OpenAiError`, a cancelled request an `AbortError`, anything else passes. */
function translate(error: unknown): unknown {
    if (error instanceof OpenAI.APIUserAbortError) return abortError();
    if (error instanceof OpenAI.APIConnectionTimeoutError) return Object.assign(new Error("The request to OpenAI timed out"), { name: "TimeoutError" });
    if (error instanceof OpenAI.APIError && typeof error.status === "number") {
        const body = (error.error ?? {}) as { message?: string; code?: string | null; type?: string | null };
        return new OpenAiError(body.message ?? error.message, error.status, body.code ?? error.code ?? null, body.type ?? error.type ?? null);
    }
    return error;
}

/** The model does not take a JSON schema for its answer (older models): this one request is made again as plain JSON mode. */
const rejectsSchema = (error: unknown): boolean => error instanceof OpenAiError && error.status === 400 && /json_schema|structured output|response_format|text\.format/i.test(error.message) && /not supported|unsupported|does not support|not available/i.test(error.message);

const openAiBackend: OpenAiBackend = {
    async credentials() {
        return apiKey() ? { found: true, source: "OPENAI_API_KEY" } : { found: false, message: NO_KEY_MESSAGE };
    },

    async respond(request, signal) {
        const wantsJson = /json/i.test(request.instructions) || /json/i.test(request.input);
        const effort = reasoningEffortFor(request.model);
        const build = (format: Record<string, unknown> | undefined) =>
            ({
                model: request.model,
                instructions: request.instructions,
                input: request.input,
                max_output_tokens: request.maxOutputTokens,
                // Nothing is kept on OpenAI's side for later retrieval.
                store: false,
                ...(effort ? { reasoning: { effort } } : {}),
                ...(format ? { text: { format } } : {}),
            }) as OpenAI.Responses.ResponseCreateParamsNonStreaming;

        // A prompt that asks for JSON can use JSON mode; JSON mode refuses to run if the prompt never says "JSON", so a stray one gets plain text.
        const jsonMode = wantsJson ? { type: "json_object" } : undefined;
        const strict = request.format ? { type: "json_schema", name: request.format.name, strict: true, schema: request.format.schema } : undefined;

        let response: OpenAI.Responses.Response;
        try {
            try {
                response = await client().responses.create(build(strict ?? jsonMode), { signal });
            } catch (error) {
                const translated = translate(error);
                if (!strict || !rejectsSchema(translated)) throw error;
                console.warn(`OpenAI does not take a JSON schema for ${request.model}; answering in JSON mode instead.`);
                response = await client().responses.create(build(jsonMode), { signal });
            }
        } catch (error) {
            throw translate(error);
        }

        if (response.status === "failed" || response.error) throw new OpenAiError(response.error?.message ?? "OpenAI could not finish the response", 502, response.error?.code ?? null, null);

        const parts = (response.output ?? []).filter((item) => item.type === "message").flatMap((item) => (item as OpenAI.Responses.ResponseOutputMessage).content ?? []);
        const text = parts.map((part) => (part.type === "output_text" ? part.text : "")).join("");
        const refusal = parts.find((part) => part.type === "refusal") as { refusal?: string } | undefined;
        if (!text.trim() && refusal?.refusal) throw new Error(`The model declined to answer: ${refusal.refusal}`);

        const reason = response.incomplete_details?.reason as string | undefined;
        return {
            text,
            inputTokens: response.usage?.input_tokens ?? null,
            outputTokens: response.usage?.output_tokens ?? null,
            stopReason: response.status === "incomplete" ? (reason === "max_output_tokens" ? "max_tokens" : (reason ?? "incomplete")) : "end_turn",
        };
    },

    async listModels(signal) {
        // The account lists every model it can see, embeddings and speech included; only ones that can answer in text are offered.
        const textModel = /^(gpt-|chatgpt-|o\d)/i;
        const notText = /(embedding|moderation|whisper|tts|transcribe|dall-e|image|audio|realtime|search|computer-use)/i;
        const seen = new Set<string>();
        const entries: OpenAiModelEntry[] = [];
        try {
            for await (const model of client().models.list({ signal })) {
                if (!model.id || seen.has(model.id) || !textModel.test(model.id) || notText.test(model.id)) continue;
                seen.add(model.id);
                entries.push({ id: model.id, owner: model.owned_by ?? "" });
            }
        } catch (error) {
            throw translate(error);
        }
        return entries.sort((a, b) => a.id.localeCompare(b.id));
    },
};

let backend: OpenAiBackend = openAiBackend;

export const getOpenAi = (): OpenAiBackend => backend;
/** Tests install a fake backend; passing nothing puts the real one back. */
export function installOpenAiBackend(replacement?: OpenAiBackend): void {
    backend = replacement ?? openAiBackend;
}

/** What went wrong with a call to OpenAI, in words that say what to do. OpenAI's own message is kept at the end. */
export function friendlyOpenAiError(error: unknown): string {
    if (error instanceof AiNotConfiguredError) return error.message;
    if (error instanceof OpenAiError) {
        const detail = ` (${error.status}${error.code ? ` ${error.code}` : ""}: ${error.message})`;
        if (error.status === 401 || error.code === "invalid_api_key") return `OpenAI rejected the API key in OPENAI_API_KEY. Check that it is correct, belongs to the right project and has not been revoked.${detail}`;
        if (error.code === "insufficient_quota") return `The OpenAI account has no credit or quota left. Add billing or raise the project's limit, then retry.${detail}`;
        if (error.status === 429) return `OpenAI is rate limiting requests. Wait a moment and try again.${detail}`;
        if (error.status === 404 || error.code === "model_not_found") return `OpenAI does not know this model, or this key's project cannot use it. Check the model id (for example gpt-5.6-luna).${detail}`;
        if (error.status === 403) return `OpenAI refused the request: the project may lack access to this model, or the organization may need verification.${detail}`;
        if (error.status >= 500) return `OpenAI could not serve the request right now. Try again shortly.${detail}`;
        return `OpenAI returned an error.${detail}`;
    }
    const raw = error instanceof Error ? error.message : String(error);
    if (error instanceof OpenAI.APIConnectionError || raw === "fetch failed" || /connection error/i.test(raw)) {
        const code = (error as { cause?: { code?: string } } | undefined)?.cause?.code;
        return `Could not reach OpenAI at ${openAiHost() || "the configured address"}${code ? ` (${code})` : ""}. Check the network connection and OPENAI_BASE_URL.`;
    }
    return raw || "Unknown error";
}
