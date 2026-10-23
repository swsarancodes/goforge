import { Router } from "express";
import { aiSchemaPlanRequestSchema } from "../ai/schema-plan.js";
import { createQueryModernization, modernizeQueryRequestSchema } from "../ai/modernize-query.js";
import { createSchemaPlan } from "../services/schema-plan-client.js";
import { AiNotConfiguredError, getAiStatus, ModelPolicyError } from "../ai/provider.js";

export const aiRouter = Router();

aiRouter.post("/schema-plan", async (req, res) => {
    const parsed = aiSchemaPlanRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid schema planning request", details: parsed.error.flatten() });
    }

    const requestController = new AbortController();
    const cancelRequest = () => {
        if (!res.writableEnded) requestController.abort();
    };
    req.once("aborted", cancelRequest);
    res.once("close", cancelRequest);

    try {
        const result = await createSchemaPlan(parsed.data, requestController.signal);
        if (requestController.signal.aborted || res.writableEnded) return;
        res.json(result);
    } catch (error) {
        if (requestController.signal.aborted || res.writableEnded) return;
        const message = error instanceof Error ? error.message : String(error);
        const status = error instanceof ModelPolicyError ? 403 : error instanceof AiNotConfiguredError ? 503 : 502;
        res.status(status).json({ error: message });
    } finally {
        req.removeListener("aborted", cancelRequest);
        res.removeListener("close", cancelRequest);
    }
});

// Lets the UI show or hide AI features without ever seeing the key: whether a model is usable, which one, and whether the workspace policy allows it.
aiRouter.get("/status", async (_req, res) => {
    res.json(await getAiStatus());
});

aiRouter.post("/modernize-query", async (req, res) => {
    const parsed = modernizeQueryRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid modernize request", details: parsed.error.flatten() });
    }

    const requestController = new AbortController();
    const cancelRequest = () => {
        if (!res.writableEnded) requestController.abort();
    };
    req.once("aborted", cancelRequest);
    res.once("close", cancelRequest);

    try {
        const result = await createQueryModernization(parsed.data, requestController.signal);
        if (requestController.signal.aborted || res.writableEnded) return;
        res.json(result);
    } catch (error) {
        if (requestController.signal.aborted || res.writableEnded) return;
        const message = error instanceof Error ? error.message : String(error);
        const status = error instanceof ModelPolicyError ? 403 : error instanceof AiNotConfiguredError ? 503 : 502;
        res.status(status).json({ error: message });
    } finally {
        req.removeListener("aborted", cancelRequest);
        res.removeListener("close", cancelRequest);
    }
});
