import { Router } from "express";
import { z } from "zod";
import { auditToCsv, withoutBodies } from "../ai/audit.js";
import { ownerOf } from "../auth/context.js";
import { isCloudMode } from "../db/stores.js";
import { callModelJson, getAiStatus, getAuditStore, getSettingsStore, ModelPolicyError } from "../ai/provider.js";
import { friendlyOpenAiError, getOpenAi } from "../ai/openai.js";
import { checkModelPolicy, type AiSettings } from "../ai/policy.js";

/** The workspace's AI settings (model, model policy, redaction) and its audit log. Models are called through the OpenAI API with the key in the API's environment, so nothing here holds or returns a secret. */
export const aiGovernanceRouter = Router();

aiGovernanceRouter.get("/settings", async (_req, res) => {
    res.json({ settings: getSettingsStore().read().settings, status: await getAiStatus() });
});

const settingsSchema = z
    .object({
        /** An OpenAI model id. */
        model: z.string().trim().max(2_048),
        timeoutMs: z.number().int().min(1_000).max(900_000),
        allowedModels: z.array(z.string().trim().min(1).max(2_048)).max(100),
        redactNames: z.boolean(),
    })
    .partial()
    .strict();

aiGovernanceRouter.put("/settings", async (req, res) => {
    // These settings are one set for the whole workspace, so with accounts only an admin (the first account) may change them.
    if (isCloudMode() && !req.auth?.isAdmin) return res.status(403).json({ error: "Only the workspace admin can change the AI settings." });
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid settings", details: parsed.error.flatten() });

    const store = getSettingsStore();
    const before = store.read().settings;
    const next: AiSettings = { ...before, ...parsed.data };

    await store.write(next);
    const changed = (Object.keys(parsed.data) as (keyof AiSettings)[]).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]));
    await getAuditStore().record({
        ownerId: ownerOf(req),
        kind: "settings-changed",
        purpose: "ai-settings",
        status: "ok",
        detail: {
            changed,
            // What the policy was after the change, so a reviewer can see it.
            now: { provider: "openai", model: next.model, allowedModels: next.allowedModels, redactNames: next.redactNames },
        },
    });
    res.json({ settings: next, status: await getAiStatus() });
});

/** One small request with the saved settings, to see whether the key and model work. Sends no schema. */
aiGovernanceRouter.post("/settings/test", async (_req, res) => {
    try {
        const status = await getAiStatus();
        if (status.problem) return res.json({ ok: false, error: status.problem });
        const startedAt = performance.now();
        const result = await callModelJson({ instructions: 'Reply with the JSON object {"ok": true} and nothing else.', input: "ping", maxOutputTokens: 50, format: { name: "ping", schema: z.object({ ok: z.boolean() }) }, purpose: "settings-test" });
        res.json({ ok: true, model: result.model, endpointHost: status.endpointHost, latencyMs: Math.round(performance.now() - startedAt) });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(error instanceof ModelPolicyError ? 403 : 200).json({ ok: false, error: message });
    }
});

/** The text models this OpenAI key can use, so the form offers what exists instead of a list kept in the code. */
aiGovernanceRouter.get("/openai/models", async (_req, res) => {
    try {
        res.json({ models: await getOpenAi().listModels() });
    } catch (error) {
        res.json({ models: [], error: friendlyOpenAiError(error) });
    }
});

/** What the policy says about a model id, without saving anything: for the settings form. */
aiGovernanceRouter.post("/settings/check-model", (req, res) => {
    const body = z.object({ model: z.string().max(2_048), allowedModels: z.array(z.string()).max(100) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid request" });
    res.json(checkModelPolicy(body.data.model, body.data));
});

const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(5_000).default(200), sinceId: z.coerce.number().int().min(0).default(0), format: z.enum(["json", "csv"]).default("json"), payload: z.enum(["0", "1"]).default("0") });

aiGovernanceRouter.get("/audit", async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
    const entries = await getAuditStore().list({ limit: parsed.data.limit, sinceId: parsed.data.sinceId, ownerId: ownerOf(req) });
    if (parsed.data.format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="goforge-ai-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.send(auditToCsv(entries));
    }
    if (req.query.download === "1") res.setHeader("Content-Disposition", `attachment; filename="goforge-ai-audit-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ entries: parsed.data.payload === "1" ? entries : entries.map(withoutBodies) });
});

aiGovernanceRouter.get("/audit/:id", async (req, res) => {
    const entry = await getAuditStore().get(Number(req.params.id), ownerOf(req));
    if (!entry) return res.status(404).json({ error: "No such audit entry" });
    res.json(entry);
});

const handoffSchema = z.object({ parentId: z.number().int().min(1).nullable(), connectionId: z.string().max(100).nullable().optional(), connectionName: z.string().max(300).nullable().optional(), steps: z.number().int().min(0).max(10_000), tables: z.array(z.string().max(300)).max(100) });

/** The runbook left this app for the SQL Editor. What happens there is not seen from here, so the entry says "opened", not "applied". */
aiGovernanceRouter.post("/audit/handoff", async (req, res) => {
    const parsed = handoffSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
    const id = await getAuditStore().record({
        ownerId: ownerOf(req),
        kind: "runbook-opened",
        purpose: "schema-plan",
        status: "ok",
        parentId: parsed.data.parentId,
        connectionId: parsed.data.connectionId ?? null,
        connectionName: parsed.data.connectionName ?? null,
        detail: { steps: parsed.data.steps, tables: parsed.data.tables, note: "Opened in the SQL Editor. Running it there is not tracked here." },
    });
    res.json({ id });
});
