import { currentOwnerId } from "../auth/context.js";
import { AiNotConfiguredError, NO_KEY_MESSAGE, buildResponseSchema, friendlyOpenAiError, getOpenAi, openAiHost, type CredentialState, type ResponseSchema } from "./openai.js";
import { forModel, type ResponseFormat } from "./structured.js";
import { DEFAULT_MODEL, DEFAULT_SETTINGS, checkModelPolicy, type AiSettings } from "./policy.js";

/**
 * Every request to a model goes through here: the model is called through the OpenAI API with the key in the API's environment, the
 * model is checked against the workspace's policy before anything is sent, and each request is written to the audit log with
 * exactly what was sent. A model is never reached by any other path.
 */

export interface SettingsStore {
    read(): { settings: AiSettings };
    write(settings: AiSettings): void | Promise<void>;
}

export type AuditKind = "model-call" | "plan" | "runbook-opened" | "settings-changed";
export type AuditStatus = "ok" | "error" | "blocked";

export interface NewAuditEntry {
    kind: AuditKind;
    /** What the request was for: `schema-plan`, `health-summary`, `modernize-query`, ... */
    purpose: string;
    status: AuditStatus;
    connectionId?: string | null;
    connectionName?: string | null;
    /** The account the request was made for. Entries are listed to their owner only. Absent in local mode. */
    ownerId?: string | null;
    provider?: string;
    model?: string;
    endpointHost?: string;
    redacted?: boolean;
    requestChars?: number;
    /** characters / 4, a rough estimate, not a count from a tokenizer. */
    requestTokensEstimate?: number;
    responseChars?: number;
    /** From the provider's own usage report, when it gave one. */
    usageInputTokens?: number | null;
    usageOutputTokens?: number | null;
    latencyMs?: number;
    error?: string | null;
    /** The earlier entry this one follows from (a runbook opened after the plan that made it). */
    parentId?: number | null;
    /** Exactly what was sent: `{ instructions, input }` as JSON text. */
    payload?: string | null;
    sha256?: string | null;
    /** What came back, as JSON text. */
    response?: string | null;
    detail?: Record<string, unknown> | null;
}

export interface AuditEntry extends NewAuditEntry {
    id: number;
    at: string;
}

export interface AuditStore {
    record(entry: NewAuditEntry): number | Promise<number>;
    list(options?: { limit?: number; sinceId?: number; ownerId?: string | null }): AuditEntry[] | Promise<AuditEntry[]>;
    get(id: number, ownerId?: string | null): AuditEntry | undefined | Promise<AuditEntry | undefined>;
}

class MemorySettings implements SettingsStore {
    private settings: AiSettings = { ...DEFAULT_SETTINGS };
    read() {
        return { settings: this.settings };
    }
    write(settings: AiSettings) {
        this.settings = settings;
    }
}

class MemoryAudit implements AuditStore {
    private readonly entries: AuditEntry[] = [];
    private next = 1;
    record(entry: NewAuditEntry): number {
        const id = this.next++;
        this.entries.push({ ...entry, id, at: new Date().toISOString() });
        if (this.entries.length > 500) this.entries.shift();
        return id;
    }
    list(options: { limit?: number; sinceId?: number } = {}) {
        return this.entries.filter((entry) => entry.id > (options.sinceId ?? 0)).slice(-(options.limit ?? 200)).reverse();
    }
    get(id: number) {
        return this.entries.find((entry) => entry.id === id);
    }
}

let settingsStore: SettingsStore = new MemorySettings();
let auditStore: AuditStore = new MemoryAudit();

/** Called once at boot with the SQLite-backed stores. Tests leave the in-memory ones in place. */
export function installAiStores(stores: { settings: SettingsStore; audit: AuditStore }): void {
    settingsStore = stores.settings;
    auditStore = stores.audit;
}

export const getSettingsStore = (): SettingsStore => settingsStore;
export const getAuditStore = (): AuditStore => auditStore;

// ---- which model ------------------------------------------------------------------------------------------------------------

export interface ModelTarget {
    model: string;
    timeoutMs: number;
    /** Where the model id came from: saved in the AI settings, OPENAI_MODEL in server/.env, or the built-in default. */
    modelFrom: "settings" | "env" | "default";
}

/** The model to use: what the workspace saved, else OPENAI_MODEL from server/.env, else gpt-5.6-luna. */
export function resolveTarget(): { target: ModelTarget; settings: AiSettings } {
    const { settings } = settingsStore.read();
    const saved = settings.model.trim();
    const fromEnv = process.env.OPENAI_MODEL?.trim() ?? "";
    const model = saved || fromEnv || DEFAULT_MODEL;
    return { settings, target: { model, timeoutMs: settings.timeoutMs, modelFrom: saved ? "settings" : fromEnv ? "env" : "default" } };
}

export interface AiStatus {
    configured: boolean;
    provider: "openai";
    model: string;
    modelFrom: ModelTarget["modelFrom"];
    /** The host requests go to (api.openai.com unless OPENAI_BASE_URL says otherwise). */
    endpointHost: string;
    credentials: "found" | "missing";
    credentialsSource: string | null;
    /** The policy allows sending to this model. */
    allowed: boolean;
    /** The first thing that stops a request, in words; null when one can be made. */
    problem: string | null;
    redactNames: boolean;
}

/** What the UI needs to know before it offers an AI feature. Contains no key of any kind. */
export async function getAiStatus(): Promise<AiStatus> {
    const { target, settings } = resolveTarget();
    const verdict = checkModelPolicy(target.model, settings);
    const credentials: CredentialState = await getOpenAi().credentials();

    let problem: string | null = null;
    if (!verdict.allowed) problem = verdict.reason ?? "This model is not allowed by the workspace policy.";
    else if (!credentials.found) problem = credentials.message;

    return {
        configured: problem === null,
        provider: "openai",
        model: target.model,
        modelFrom: target.modelFrom,
        endpointHost: openAiHost(),
        credentials: credentials.found ? "found" : "missing",
        credentialsSource: credentials.found ? credentials.source : null,
        allowed: verdict.allowed,
        problem,
        redactNames: settings.redactNames,
    };
}

export class ModelPolicyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ModelPolicyError";
    }
}

export { AiNotConfiguredError };

// ---- the call ---------------------------------------------------------------------------------------------------------------

export interface ModelCall {
    instructions: string;
    /** Sent as the model input (objects are JSON encoded). */
    input: unknown;
    maxOutputTokens?: number;
    /**
     * Ask for an answer in exactly this shape (structured outputs). `schema` is the validator the answer is checked against afterwards;
     * the model is shown its strict-mode form. The schema is part of what is sent, so it is in the audit log too.
     */
    format?: ResponseFormat;
    signal?: AbortSignal;
    /** What this request is for, written to the audit log. */
    purpose?: string;
    context?: { connectionId?: string | null; connectionName?: string | null; ownerId?: string | null; redacted?: boolean; detail?: Record<string, unknown> };
}

export interface ModelUsage {
    inputTokens: number | null;
    outputTokens: number | null;
}

export interface ModelResult {
    output: unknown;
    model: string;
    usage: ModelUsage;
    auditId: number;
    latencyMs: number;
}

export function parseJsonOutput(text: string, label = "The model"): unknown {
    const withoutFence = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
        return JSON.parse(withoutFence);
    } catch {
        const start = withoutFence.indexOf("{");
        const end = withoutFence.lastIndexOf("}");
        if (start >= 0 && end > start) return JSON.parse(withoutFence.slice(start, end + 1));
        throw new Error(`${label} returned invalid JSON`);
    }
}

const PAYLOAD_LIMIT = 400_000;

const sha256 = async (text: string): Promise<string> => {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(text).digest("hex");
};

export async function callModelJson(call: ModelCall): Promise<ModelResult> {
    const { target, settings } = resolveTarget();
    const credentials = await getOpenAi().credentials();
    if (!credentials.found) throw new AiNotConfiguredError(credentials.message || NO_KEY_MESSAGE);

    const purpose = call.purpose ?? "model-call";
    const input = typeof call.input === "string" ? call.input : JSON.stringify(call.input);
    // Built before anything is sent or logged, so a schema the API cannot take fails here, loudly, and never reaches the model.
    const responseSchema: ResponseSchema | undefined = call.format ? buildResponseSchema(call.format.name, forModel(call.format.schema)) : undefined;
    const payload = JSON.stringify({ instructions: call.instructions, input, ...(responseSchema ? { responseFormat: responseSchema } : {}) });
    const base: NewAuditEntry = {
        kind: "model-call",
        purpose,
        status: "ok",
        connectionId: call.context?.connectionId ?? null,
        connectionName: call.context?.connectionName ?? null,
        ownerId: call.context?.ownerId ?? currentOwnerId() ?? null,
        provider: "openai",
        model: target.model,
        endpointHost: openAiHost(),
        redacted: call.context?.redacted ?? false,
        requestChars: call.instructions.length + input.length + (responseSchema ? JSON.stringify(responseSchema).length : 0),
        requestTokensEstimate: Math.ceil((call.instructions.length + input.length + (responseSchema ? JSON.stringify(responseSchema).length : 0)) / 4),
        payload: payload.length > PAYLOAD_LIMIT ? `${payload.slice(0, PAYLOAD_LIMIT)}…[truncated]` : payload,
        sha256: await sha256(payload),
        detail: call.context?.detail ?? null,
    };

    const verdict = checkModelPolicy(target.model, settings);
    if (!verdict.allowed) {
        await auditStore.record({ ...base, status: "blocked", error: verdict.reason ?? "blocked", payload: null });
        throw new ModelPolicyError(verdict.reason ?? "This model is not allowed by the workspace policy.");
    }

    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), target.timeoutMs);
    const cancelRequest = () => controller.abort();
    if (call.signal?.aborted) cancelRequest();
    else call.signal?.addEventListener("abort", cancelRequest, { once: true });

    const maxTokens = call.maxOutputTokens ?? 8_000;
    try {
        let response;
        try {
            response = await getOpenAi().respond({ model: target.model, instructions: call.instructions, input, maxOutputTokens: maxTokens, ...(responseSchema ? { format: responseSchema } : {}) }, controller.signal);
        } catch (error) {
            if (error instanceof AiNotConfiguredError || (error instanceof Error && error.name === "AbortError")) throw error;
            throw new Error(friendlyOpenAiError(error));
        }
        if (response.stopReason === "max_tokens") throw new Error(`The model reached its output limit (${maxTokens} tokens, thinking included) before it finished the answer. Ask for a smaller change, or plan it in parts.`);
        if (!response.text.trim()) throw new Error("OpenAI returned no text output");

        const output = parseJsonOutput(response.text);
        const usage: ModelUsage = { inputTokens: response.inputTokens, outputTokens: response.outputTokens };
        const latencyMs = Math.round(performance.now() - startedAt);
        const text = response.text;
        const auditId = await auditStore.record({ ...base, responseChars: text.length, usageInputTokens: usage.inputTokens, usageOutputTokens: usage.outputTokens, latencyMs, response: text.length > PAYLOAD_LIMIT ? `${text.slice(0, PAYLOAD_LIMIT)}…[truncated]` : text });
        return { output, model: target.model, usage, auditId, latencyMs };
    } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        const message = aborted ? `The OpenAI request timed out after ${Math.round(target.timeoutMs / 1000)} s` : error instanceof Error ? error.message : String(error);
        // The failure being reported matters more than a failure to log it.
        await Promise.resolve(auditStore.record({ ...base, status: "error", error: message, latencyMs: Math.round(performance.now() - startedAt) })).catch((logError) => console.error("could not write the audit entry:", logError));
        throw aborted ? new Error(message) : error;
    } finally {
        clearTimeout(timeout);
        call.signal?.removeEventListener("abort", cancelRequest);
    }
}
