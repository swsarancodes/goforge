import { z } from "zod";
import { callModelJson, type ModelUsage } from "./provider.js";

/**
 * One correction round of the QueryShift loop: a converted query was run against a reference result and did not match, and the model is
 * shown what was measured (which rows are missing, which are unexpected, which checks broke, or PostgreSQL's error) and asked for a
 * corrected query. The measured difference is the point: the model is never asked whether its own answer is right.
 * Whatever it returns is run and compared again by the caller; nothing in here decides that a query is correct.
 */

const name = z.string().trim().min(1).max(256);
const cell = z.string().max(400).nullable();

export const correctQueryRequestSchema = z.object({
    legacySql: z.string().trim().min(1).max(100_000),
    sourceDialect: z.enum(["oracle", "mssql", "mysql", "db2"]),
    businessPurpose: z.string().max(2_000).optional(),
    /** The target tables: names and column types only. */
    schema: z.object({ tables: z.array(z.object({ name, columns: z.array(z.object({ name, type: z.string().max(128) })).max(300) })).max(300) }),
    /** Legacy table/column to target table/column. */
    mapping: z.array(z.object({ sourceTable: name, sourceColumn: name, targetTable: name, targetColumn: name, note: z.string().max(400).optional() })).max(2_000).default([]),
    /** The query that was just run. */
    previousSql: z.string().trim().min(1).max(100_000),
    attempt: z.number().int().min(1).max(10),
    maxAttempts: z.number().int().min(1).max(10),
    evidence: z.object({
        kind: z.enum(["mismatch", "error"]),
        message: z.string().max(4_000),
        expectedColumns: z.array(z.string().max(256)).max(300),
        columnProblem: z.string().max(1_000).optional(),
        orderProblem: z.string().max(1_000).optional(),
        missingRows: z.array(z.array(cell)).max(20).default([]),
        unexpectedRows: z.array(z.array(cell)).max(20).default([]),
        missingCount: z.number().int().min(0).default(0),
        unexpectedCount: z.number().int().min(0).default(0),
        /** Columns in which a missing row and the unexpected row closest to it differ, with how many rows. */
        differingColumns: z.array(z.object({ column: z.string().max(256), rows: z.number().int().min(1) })).max(300).default([]),
        brokenInvariants: z.array(z.object({ name: z.string().max(400), detail: z.string().max(600) })).max(20).default([]),
        /** What static checks saw in the previous query's text (no data involved): deterministic suspects, not proof. */
        staticFindings: z.array(z.object({ id: z.string().max(100), title: z.string().max(300), detail: z.string().max(1_000) })).max(20).default([]),
    }),
    /** What the rule engine reported about the original query and could not fix. */
    engineWarnings: z.array(z.string().max(600)).max(30).default([]),
});

export type CorrectQueryRequest = z.infer<typeof correctQueryRequestSchema>;

const stringList = (max: number, itemMax = 600) =>
    z.preprocess(
        (value) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, itemMax)).slice(0, max) : []),
        z.array(z.string()),
    );

export const correctQueryResultSchema = z.object({
    sql: z.string().trim().min(1).max(100_000),
    /** What was wrong, in terms of the evidence, and what was changed. */
    explanation: z.string().max(2_000).catch(""),
    changes: stringList(30),
    /** The model's own words about what it is still unsure of. Nothing checks them. */
    risks: stringList(20),
});

export type CorrectQueryResult = z.infer<typeof correctQueryResultSchema>;

export function buildCorrectionInstructions(request: CorrectQueryRequest): string {
    return [
        "You are GoForge's SQL migration engine, in a correction round. An Oracle (or other legacy) query was converted to PostgreSQL, run on a real PostgreSQL database, and compared with the result the ORIGINAL database returns. They differ, or PostgreSQL rejected it.",
        `This is correction ${request.attempt} of at most ${request.maxAttempts}. After the last one the query goes to a human reviewer, so do not guess: change what the evidence points to.`,
        "Return JSON only, no markdown and no text outside the JSON object.",
        "The evidence is a measurement, not an opinion. Missing rows are rows the original returns and the converted query does not. Unexpected rows are rows the converted query returns and the original does not. 'differingColumns' says in which columns a missing row and its closest unexpected row differ. Find the construct whose legacy behaviour differs from PostgreSQL's and explain the difference in the explanation field.",
        "'staticFindings' are observations about the previous query's text made without any data: each names a construct that commonly differs between the legacy dialect and PostgreSQL. They are suspects, not proof: use them to find the cause when the measured rows agree, and ignore one that does not apply.",
        "Typical causes: an outer-join predicate that moved from ON to WHERE; NULL versus empty string; integer division; AVG/COUNT over NULL or null-extended rows; DATE that carries a time of day; date arithmetic returning an interval instead of days; ADD_MONTHS and month ends; ROWNUM and ORDER BY; column names and aliases that differ in the result.",
        "The result must have exactly the column names of 'expectedColumns', in that order, and the same rows, NULLs and ordering as the original.",
        "Use only the tables and columns in the supplied schema. 'mapping' says which legacy table and column became which. Never invent tables, columns or data.",
        "NEVER write the expected rows into the query: no VALUES lists of them, no UNION of constants, no literals copied from the evidence. The query is run against other data as well, and a query that reproduces the evidence is rejected and sent to a human. Fix the logic.",
        "Make the smallest change that fixes what the evidence shows. Keep every part of the previous query that the evidence does not implicate.",
        "One SELECT statement only. Do not write anything that changes data or settings.",
        "The JSON object must contain: sql (string), explanation (string), changes (string[]), risks (string[], what you are still unsure about; these are your words and nothing verifies them).",
    ].join("\n");
}

export async function createQueryCorrection(request: CorrectQueryRequest, signal?: AbortSignal): Promise<{ result: CorrectQueryResult; model: string; auditId: number; usage: ModelUsage; latencyMs: number }> {
    const { output, model, auditId, usage, latencyMs } = await callModelJson({
        instructions: buildCorrectionInstructions(request),
        input: {
            originalQuery: request.legacySql,
            sourceDialect: request.sourceDialect,
            targetDialect: "postgresql",
            businessPurpose: request.businessPurpose ?? null,
            schema: request.schema,
            mapping: request.mapping,
            previousQuery: request.previousSql,
            evidence: request.evidence,
            engineWarnings: request.engineWarnings,
        },
        maxOutputTokens: 8_000,
        format: { name: "correct_query", schema: correctQueryResultSchema },
        purpose: "correct-query",
        signal,
    });

    const parsed = correctQueryResultSchema.safeParse(output);
    if (!parsed.success) {
        const details = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        throw new Error(`The model returned an invalid correction: ${details}`);
    }
    return { result: parsed.data, model, auditId, usage, latencyMs };
}
