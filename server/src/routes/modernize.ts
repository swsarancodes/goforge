import { Router } from "express";
import { z } from "zod";

export const modernizeRouter = Router();

const modernizeRequestSchema = z.object({
    legacySql: z.string().min(1, "legacySql is required"),
    sourceDialect: z.enum(["oracle", "mssql", "mysql", "db2", "sqlite"]).default("oracle"),
    targetDialect: z.enum(["postgresql", "mysql", "sqlite", "oracle", "mssql"]).default("postgresql"),
    schemaContext: z.object({
        databaseName: z.string().optional(),
        dialect: z.string().optional(),
        tables: z.array(z.object({
            name: z.string(),
            columns: z.array(z.object({
                name: z.string(),
                type: z.string(),
                isPrimary: z.boolean().optional(),
                isUnique: z.boolean().optional(),
            })),
        })).default([]),
    }).optional(),
    options: z.object({
        optimize: z.boolean().optional(),
        generateIndexes: z.boolean().optional(),
        aggressiveRefactor: z.boolean().optional(),
    }).optional(),
});

// Import the multi-agent orchestrator from server AI module
import { modernizeQuery } from "../ai/query-modernizer/orchestrator.js";
import { ENTERPRISE_SAMPLE_QUERIES } from "../ai/query-modernizer/samples.js";

modernizeRouter.get("/samples", (_req, res) => {
    res.json({ samples: ENTERPRISE_SAMPLE_QUERIES });
});

modernizeRouter.post("/query", async (req, res) => {
    const parsed = modernizeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid modernize request", details: parsed.error.flatten() });
    }

    try {
        const result = await modernizeQuery(parsed.data);
        res.json(result);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: "Multi-Agent modernizer failed", details: message });
    }
});
