import { aiSchemaPlanModelSchema, aiSchemaPlanSchema, type AiSchemaPlan, type AiSchemaPlanRequest } from "../ai/schema-plan.js";
import { normalizePlanOutput } from "../ai/plan-normalize.js";
import { callModelJson } from "../ai/provider.js";

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
        "Supported operation types: create_table, rename_table, drop_table, add_column, alter_column, drop_column, add_relationship, drop_relationship, add_index, drop_index, add_unique, add_check, drop_constraint.",
        "Use the exact nested operation shapes described below; do not put field attributes at the operation root.",
        "Every key of the answer's shape is always written: give null for any that does not apply. To remove an existing column's default, set changes.dropDefault to true; to leave the default alone, leave it null.",
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

/** One schema plan for the diagram's AI Schema feature. The request goes through the workspace policy and the audit log like every other model call. */
export async function createSchemaPlan(
    request: AiSchemaPlanRequest,
    requestSignal?: AbortSignal,
): Promise<{ plan: AiSchemaPlan; model: string }> {
    const { output, model } = await callModelJson({
        instructions: buildInstructions(request),
        input: {
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
        },
        format: { name: "schema_plan", schema: aiSchemaPlanModelSchema },
        signal: requestSignal,
    });

    const parsed = aiSchemaPlanSchema.safeParse(normalizePlanOutput(output));
    if (!parsed.success) {
        const details = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        throw new Error(`The model returned an invalid schema plan: ${details}`);
    }

    return { plan: parsed.data, model };
}
