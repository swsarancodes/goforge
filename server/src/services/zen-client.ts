import { aiSchemaPlanSchema, type AiSchemaPlan, type AiSchemaPlanRequest } from "../ai/schema-plan.js";

const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
const DEFAULT_MODEL = "muse-spark-1.2-contributor-free";
const DEFAULT_TIMEOUT_MS = 60_000;

interface ZenResponseContent {
    type?: string;
    text?: string;
}
interface ZenResponseOutput {
    type?: string;
    content?: ZenResponseContent[];
}

interface ZenResponseBody {
    output_text?: string;
    output?: ZenResponseOutput[];
    error?: { message?: string } | null;
}

function getConfig() {
    const apiKey = process.env.ZEN_API_KEY?.trim();
    if (!apiKey) throw new Error("ZEN_API_KEY is not configured on the server");

    return {
        apiKey,
        baseUrl: (process.env.ZEN_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ""),
        model: process.env.ZEN_MODEL?.trim() || DEFAULT_MODEL,
        timeoutMs: Number(process.env.ZEN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    };
}

function extractOutputText(body: ZenResponseBody): string {
    if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text;

    const chunks = body.output
        ?.flatMap((item) => item.content ?? [])
        .filter((content) => content.type === "output_text" && typeof content.text === "string")
        .map((content) => content.text as string);

    if (chunks?.length) return chunks.join("");
    throw new Error(body.error?.message || "Zen returned no text output");
}

function parseJsonOutput(text: string): unknown {
    const withoutFence = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");

    try {
        return JSON.parse(withoutFence);
    } catch {
        const start = withoutFence.indexOf("{");
        const end = withoutFence.lastIndexOf("}");
        if (start >= 0 && end > start) return JSON.parse(withoutFence.slice(start, end + 1));
        throw new Error("Zen returned invalid JSON");
    }
}

function buildInstructions(request: AiSchemaPlanRequest): string {
    return [
        "You are GoForge's database schema planning engine.",
        "Return JSON only. Do not use markdown fences or prose outside the JSON object.",
        "Create the smallest safe set of operations that satisfies the user's prompt.",
        "Never drop or rename an existing table or column unless the user explicitly requests it.",
        "Use existing table and column names exactly as supplied.",
        "Every dataType must be selected from allowedDataTypes.",
        "Do not generate SQL. Do not invent database rows, credentials, or application secrets.",
        "Relationship source is the referenced/parent field and target is the foreign-key/child field.",
        "If the request is ambiguous, state the assumption instead of making destructive changes.",
        "The JSON object must contain: summary (string), assumptions (string[]), warnings (string[]), operations (array).",
        "Supported operation types: create_table, rename_table, drop_table, add_column, alter_column, drop_column, add_relationship, drop_relationship, add_index, drop_index.",
        "create_table.table contains name, optional note, fields, and optional indexes.",
        "A field contains name, dataType, and optional nullable, primaryKey, unique, autoIncrement, defaultValue, maxLength, precision, scale, unsigned, values, note.",
        "alter_column.changes may contain newName, dataType, nullable, primaryKey, unique, autoIncrement, defaultValue, maxLength, precision, scale, unsigned, values, note.",
        "An index contains name, columns, and optional unique.",
        "A relationship contains optional name, sourceTable, sourceColumn, targetTable, targetColumn, optional cardinality, onDelete, and onUpdate.",
        `Target dialect: ${request.dialect}.`,
    ].join("\n");
}

export async function createZenSchemaPlan(request: AiSchemaPlanRequest): Promise<{ plan: AiSchemaPlan; model: string }> {
    const config = getConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
        const response = await fetch(`${config.baseUrl}/responses`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: config.model,
                store: false,
                max_output_tokens: 8_000,
                instructions: buildInstructions(request),
                input: JSON.stringify({
                    userRequest: request.prompt,
                    currentSchema: {
                        databaseName: request.databaseName,
                        dialect: request.dialect,
                        tables: request.tables,
                        relationships: request.relationships,
                    },
                    selectedTables: request.selectedTables ?? [],
                    allowedDataTypes: request.allowedDataTypes,
                }),
            }),
            signal: controller.signal,
        });

        const rawBody = await response.text();
        let body: ZenResponseBody;
        try {
            body = JSON.parse(rawBody) as ZenResponseBody;
        } catch {
            throw new Error(`Zen returned a non-JSON response (${response.status})`);
        }

        if (!response.ok) {
            throw new Error(body.error?.message || `Zen request failed with status ${response.status}`);
        }

        const parsed = aiSchemaPlanSchema.safeParse(parseJsonOutput(extractOutputText(body)));
        if (!parsed.success) {
            const details = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
            throw new Error(`Zen returned an invalid schema plan: ${details}`);
        }

        return { plan: parsed.data, model: config.model };
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error("Zen request timed out");
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
