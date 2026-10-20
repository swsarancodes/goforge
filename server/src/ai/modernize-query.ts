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
    sourceDialect: z.enum(["oracle", "mssql", "mysql", "db2"]),
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
    /** What the rule engine produced and what it could not do, so the model works on the gaps and leaves the rest alone. */
    draft: z
        .object({
            sql: z.string().max(100_000),
            /** What the rules changed, in words. */
            changes: z.array(z.string().max(600)).max(50).default([]),
            /** Constructs the rules reported they could not convert, and why. */
            notConverted: z.array(z.object({ construct: z.string().max(400), reason: z.string().max(600) })).max(50).default([]),
            /** PostgreSQL's message when it rejected the previous answer (the draft or the model's earlier attempt). */
            postgresError: z.string().max(2_000).optional(),
        })
        .optional(),
});

export type ModernizeQueryRequest = z.infer<typeof modernizeQueryRequestSchema>;

export const modernizeQueryResultSchema = z.object({
    sql: z.string().trim().min(1).max(100_000),
    summary: z.string().max(2_000).catch(""),
    changes: stringList(50),
    /** Behaviour differences the model noticed. These are the model's words, not checked by anything. */
    risks: stringList(30),
    unsupported: stringList(30),
});

export type ModernizeQueryResult = z.infer<typeof modernizeQueryResultSchema>;

const DIALECT_NAMES: Record<string, string> = {
    oracle: "Oracle (11g/19c, PL/SQL dialect)",
    mssql: "Microsoft SQL Server (T-SQL)",
    mysql: "MySQL",
    db2: "IBM DB2 (LUW)",
};

export function buildModernizeInstructions(request: ModernizeQueryRequest): string {
    return [
        "You are GoForge's SQL migration engine. Convert one SQL query written for an older database to PostgreSQL 16.",
        `Source dialect: ${DIALECT_NAMES[request.sourceDialect]}. Target: PostgreSQL 16.`,
        "Return JSON only. Do not use markdown fences or any text outside the JSON object.",
        "A real PostgreSQL server will check your answer by planning it. If it rejects it you will be asked again with its error message, so answer with SQL PostgreSQL accepts.",
        "The converted query must return the same rows, columns, ordering and NULL behavior as the original. Preserve semantics over style.",
        "Use only tables and columns that appear in the supplied schema or in the original query. Never invent tables, columns, functions or data.",
        "A rule-based draft is supplied. Keep every part of it that is correct. Work on the constructs it lists as not converted and on the error PostgreSQL gave.",
        "Where a conversion changes behavior subtly (NULL versus empty string, implicit type conversion, case sensitivity, ROWNUM versus ORDER BY, integer division), say so under risks. Do not claim the result is equivalent.",
        "If something cannot be converted faithfully, leave the original construct in place with a SQL comment and list it under unsupported. Do not guess.",
        "You only ever see the query and table/column names. Do not ask for data and do not invent any.",
        "The JSON object must contain: sql (string, the converted query), summary (string, one or two sentences), changes (string[], each a transformation applied and why), risks (string[]), unsupported (string[]).",
    ].join("\n");
}

export async function createZenQueryModernization(request: ModernizeQueryRequest, signal?: AbortSignal): Promise<{ result: ModernizeQueryResult; model: string }> {
    const { output, model } = await callZenJson({
        instructions: buildModernizeInstructions(request),
        input: {
            originalQuery: request.legacySql,
            sourceDialect: request.sourceDialect,
            targetDialect: "postgresql",
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
