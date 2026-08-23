import { Router } from "express";
import { aiSchemaPlanRequestSchema } from "../ai/schema-plan.js";
import { createZenSchemaPlan } from "../services/zen-client.js";

export const aiRouter = Router();

aiRouter.post("/schema-plan", async (req, res) => {
    const parsed = aiSchemaPlanRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid schema planning request", details: parsed.error.flatten() });
    }

    try {
        const result = await createZenSchemaPlan(parsed.data);
        res.json(result);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes("not configured") ? 503 : 502;
        res.status(status).json({ error: message });
    }
});
