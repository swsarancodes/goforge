import { z } from "zod";
import { callZenJson } from "../services/zen-client.js";

const name = z.string().trim().min(1).max(256);

/** Keeps only the strings from whatever list the model returned (models sometimes mix in objects or null). */
const stringList = (max: number, itemMax = 600) =>
    z.preprocess(
        (value) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, itemMax)).slice(0, max) : []),
        z.array(z.string()),
    );

export const modernizeQueryRequestSchema = z.object({
    legacySql: z.string().trim().min(1).max(100_000),
    sourceDialect: z.enum(["oracle", "mssql", "mysql", "db2", "sqlite"]),
    targetDialect: z.enum(["postgresql", "mysql", "sqlite"]),
    /** Table and column names/types from the open project. Never data. */
    schema: z
        .object({
            databaseName: z.string().max(256).optional(),
            dialect: z.string().max(64).optional(),
            tables: z
                .array(
                    z.object({
                        name,
                        columns: z.array(z.object({ name, type: z.string().max(128), isPrimary: z.boolean().optional(), isUnique: z.boolean().optional() })).max(300),
                    }),
                )
                .max(300),
        })
        .optional(),
    /** What the rule engine produced, so the model can start from it and fix what it got wrong. */
    draft: z
        .object({
            sql: z.string().max(100_000),
            notes: z.array(z.string().max(600)).max(50).default([]),
            issues: z.array(z.string().max(600)).max(50).default([]),
        })
        .optional(),
});

export type ModernizeQueryRequest = z.infer<typeof modernizeQueryRequestSchema>;

export const modernizeQueryResultSchema = z.object({
    sql: z.string().trim().min(1).max(100_000),
    summary: z.string().max(2_000).catch(""),
    changes: stringList(50),
    risks: stringList(30),
    unsupported: stringList(30),
    indexSuggestions: z.preprocess(
        (value) => (Array.isArray(value) ? value : []),
        z.array(
            z
                .object({
                    tableName: name,
                    columns: z.array(name).min(1).max(8),
                    unique: z.boolean().optional(),
                    reason: z.string().max(600).catch(""),
                })
                .catch(undefined as never),
        ).transform((items) => items.filter(Boolean).slice(0, 10)),
    ),
});

export type ModernizeQueryResult = z.infer<typeof modernizeQueryResultSchema>;

const DIALECT_NAMES: Record<string, string> = {
    oracle: "Oracle (11g/19c PL/SQL dialect)",
    mssql: "Microsoft SQL Server (T-SQL)",
    mysql: "MySQL",
    db2: "IBM DB2",
    sqlite: "SQLite",
    postgresql: "PostgreSQL 16",
};

export function buildModernizeInstructions(request: ModernizeQueryRequest): string {
    return [
        "You are GoForge's SQL migration engine. Convert one SQL query from one database dialect to another.",
        `Source dialect: ${DIALECT_NAMES[request.sourceDialect]}. Target dialect: ${DIALECT_NAMES[request.targetDialect]}.`,
        "Return JSON only. Do not use markdown fences or any text outside the JSON object.",
        "The converted query must return exactly the same rows, columns, ordering and NULL behavior as the original. Preserve semantics over style.",
        "Use only tables and columns that appear in the supplied schema or in the original query. Never invent tables, columns, functions or data.",
        "If the original references objects that are not in the schema, keep them as written and mention it under risks.",
        "Translate dialect-specific constructs (outer join syntax, hierarchical queries, built-in functions, row limiting, string concatenation, date arithmetic, sequences, DUAL) into the target dialect's idiomatic equivalent.",
        "Where a conversion changes behavior subtly (NULL versus empty string, implicit type conversion, case sensitivity, ROWNUM versus ORDER BY, integer division), say so under risks.",
        "If something cannot be converted faithfully, leave the original construct in place with a SQL comment and list it under unsupported. Do not guess.",
        "A rule-based draft may be supplied. Use it as a starting point, but fix anything in it that is wrong or incomplete.",
        "Suggest an index only when a join or filter in this query clearly lacks one; never suggest indexes on tables that are not in the schema.",
        "You only ever see the query and table/column names. Do not ask for data and do not invent any.",
        "The JSON object must contain: sql (string, the converted query), summary (string, one or two sentences), changes (string[], each a transformation applied and why), risks (string[]), unsupported (string[]), indexSuggestions (array of { tableName, columns (string[]), unique (boolean, optional), reason (string) }).",
    ].join("\n");
}

export async function createZenQueryModernization(request: ModernizeQueryRequest, signal?: AbortSignal): Promise<{ result: ModernizeQueryResult; model: string }> {
    const { output, model } = await callZenJson({
        instructions: buildModernizeInstructions(request),
        input: {
            originalQuery: request.legacySql,
            sourceDialect: request.sourceDialect,
            targetDialect: request.targetDialect,
            schema: request.schema ?? null,
            ruleBasedDraft: request.draft ?? null,
        },
        maxOutputTokens: 8_000,
        signal,
    });

    const parsed = modernizeQueryResultSchema.safeParse(output);
    if (!parsed.success) {
        const details = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        throw new Error(`Zen returned an invalid conversion: ${details}`);
    }
    return { result: parsed.data, model };
}
