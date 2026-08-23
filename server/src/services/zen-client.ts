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

const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const copyDefined = (source: Record<string, unknown>, keys: string[]) => Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
);

const normalizeOperation = (value: unknown): unknown => {
    const operation = asRecord(value);
    const type = typeof operation.type === "string"
        ? operation.type.trim().toLowerCase().replace(/[\s-]+/g, "_")
        : operation.type;
    const tableName = operation.tableName ?? operation.table;
    const fieldKeys = [
        "dataType", "nullable", "primaryKey", "unique", "autoIncrement", "defaultValue",
        "maxLength", "precision", "scale", "unsigned", "values", "note",
    ];
    const columnName = operation.columnName ?? operation.column ?? operation.name;

    switch (type) {
        case "add_column": {
            const fieldValue = asRecord(operation.field);
            return {
                type,
                tableName,
                field: {
                    name: fieldValue.name ?? columnName,
                    ...copyDefined(operation, fieldKeys),
                    ...fieldValue,
                },
            };
        }
        case "alter_column": {
            const changes = asRecord(operation.changes);
            return {
                type,
                tableName,
                columnName,
                changes: {
                    ...copyDefined(operation, ["newName", ...fieldKeys]),
                    ...changes,
                },
            };
        }
        case "drop_column":
            return { type, tableName, columnName };
        case "rename_table":
            return { type, tableName, newName: operation.newName ?? operation.name };
        case "drop_table":
            return { type, tableName };
        case "create_table": {
            const table = asRecord(operation.table);
            return {
                type,
                table: {
                    name: table.name ?? operation.tableName ?? operation.name,
                    ...copyDefined(operation, ["note", "fields", "indexes"]),
                    ...table,
                },
            };
        }
        case "add_index": {
            const index = asRecord(operation.index);
            return {
                type,
                tableName,
                index: {
                    name: index.name ?? operation.indexName ?? operation.name,
                    columns: index.columns ?? operation.columns,
                    ...(index.unique !== undefined || operation.unique !== undefined
                        ? { unique: index.unique ?? operation.unique }
                        : {}),
                },
            };
        }
        case "drop_index":
            return { type, tableName, indexName: operation.indexName ?? operation.name };
        case "add_relationship":
            return {
                type,
                relationship: {
                    ...copyDefined(operation, [
                        "name", "sourceTable", "sourceColumn", "targetTable", "targetColumn",
                        "cardinality", "onDelete", "onUpdate",
                    ]),
                    ...asRecord(operation.relationship),
                },
            };
        case "drop_relationship":
            return {
                type,
                ...copyDefined(operation, ["sourceTable", "sourceColumn", "targetTable", "targetColumn"]),
            };
        default:
            return value;
    }
};

function normalizePlanOutput(value: unknown): unknown {
    const plan = asRecord(value);
    return {
        summary: plan.summary,
        assumptions: plan.assumptions ?? [],
        warnings: plan.warnings ?? [],
        clarifyingQuestions: plan.clarifyingQuestions ?? plan.clarifying_questions ?? plan.questions ?? [],
        operations: Array.isArray(plan.operations) ? plan.operations.map(normalizeOperation) : [],
    };
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
        "If a missing requirement could materially change table structure, keys, cardinality, tenancy, or deletion behavior, ask concise clarifying questions and return no operations.",
        "Use assumptions only for low-risk details that do not materially change the design.",
        "The JSON object must contain: summary (string), assumptions (string[]), warnings (string[]), clarifyingQuestions (string[]), operations (array).",
        "Supported operation types: create_table, rename_table, drop_table, add_column, alter_column, drop_column, add_relationship, drop_relationship, add_index, drop_index.",
        "Use the exact nested operation shapes described below; do not put field attributes at the operation root.",
        "create_table.table contains name, optional note, fields, and optional indexes.",
        "A field contains name, dataType, and optional nullable, primaryKey, unique, autoIncrement, defaultValue, maxLength, precision, scale, unsigned, values, note.",
        "alter_column.changes may contain newName, dataType, nullable, primaryKey, unique, autoIncrement, defaultValue, maxLength, precision, scale, unsigned, values, note.",
        "An index contains name, columns, and optional unique.",
        "A relationship contains optional name, sourceTable, sourceColumn, targetTable, targetColumn, optional cardinality, onDelete, and onUpdate.",
        `Target dialect: ${request.dialect}.`,
        request.scope === "selected_tables"
            ? `Only modify these selected tables: ${(request.selectedTables ?? []).join(", ")}. Do not create tables or alter relationships involving unselected tables.`
            : "The request is scoped to the whole database.",
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
                    scope: request.scope,
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

        const parsed = aiSchemaPlanSchema.safeParse(normalizePlanOutput(parseJsonOutput(extractOutputText(body))));
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
