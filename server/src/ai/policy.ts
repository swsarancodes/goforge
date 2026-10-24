/**
 * What may be sent to which model, decided before any request leaves the machine. Models are called through the OpenAI API only; the
 * workspace's rules are an optional allow-list of model ids and whether names are replaced by placeholders. Both are stated in the
 * UI; nothing is hidden in the code.
 */

/** Used when no model is saved in the AI settings and OPENAI_MODEL is not set. */
export const DEFAULT_MODEL = "gpt-5.6-luna";

export interface AiSettings {
    /** An OpenAI model id. Empty: OPENAI_MODEL from server/.env, else gpt-5.6-luna. */
    model: string;
    timeoutMs: number;
    /** Exact model ids, or `prefix*`. Empty means any model. */
    allowedModels: string[];
    /** Replace schema, table, column and index names with placeholders before a prompt leaves the server. */
    redactNames: boolean;
    updatedAt: string | null;
}

export const DEFAULT_SETTINGS: AiSettings = {
    model: "",
    timeoutMs: 120_000,
    allowedModels: [],
    redactNames: false,
    updatedAt: null,
};

export interface PolicyVerdict {
    allowed: boolean;
    reason?: string;
}

const matchesAllowed = (model: string, entry: string): boolean => (entry.endsWith("*") ? model.startsWith(entry.slice(0, -1)) : model === entry);

export function checkModelPolicy(model: string, settings: Pick<AiSettings, "allowedModels">): PolicyVerdict {
    if (!model.trim()) return { allowed: false, reason: "No model is chosen." };
    if (settings.allowedModels.length > 0 && !settings.allowedModels.some((entry) => matchesAllowed(model, entry))) {
        return { allowed: false, reason: `"${model}" is not on this workspace's list of allowed models.` };
    }
    return { allowed: true };
}

/**
 * Settings saved by earlier versions named another kind of endpoint (a custom URL and key, or an AWS Bedrock region). A model id or
 * allow-list from there is not an OpenAI model id, so only what still means something is kept: the time limit and the name redaction.
 */
export function settingsFromStored(stored: Record<string, unknown>): AiSettings {
    const legacy = "provider" in stored || "baseUrl" in stored || "region" in stored;
    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    return {
        ...DEFAULT_SETTINGS,
        model: legacy ? "" : text(stored.model),
        allowedModels: legacy ? [] : Array.isArray(stored.allowedModels) ? stored.allowedModels.filter((entry): entry is string => typeof entry === "string") : [],
        timeoutMs: typeof stored.timeoutMs === "number" && stored.timeoutMs >= 1_000 ? Math.max(stored.timeoutMs, legacy ? DEFAULT_SETTINGS.timeoutMs : 0) : DEFAULT_SETTINGS.timeoutMs,
        redactNames: stored.redactNames === true,
    };
}
