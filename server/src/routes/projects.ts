import { Router } from "express";
import { z } from "zod";
import { ownerOf } from "../auth/context.js";
import { getCloud } from "../db/stores.js";
import { handle } from "./async-handler.js";

export const projectsRouter = Router();

const ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Diagrams saved to the account, as the portable project files the browser already exports. Only exists with accounts on. */
projectsRouter.use((_req, res, next) => {
    if (!getCloud()) return res.status(404).json({ error: "Saving diagrams to the cloud needs the application database: set DATABASE_URL in server/.env." });
    next();
});

const putSchema = z.object({
    name: z.string().trim().min(1).max(200),
    dialect: z.enum(["postgres", "mysql", "sqlite", "mariadb", "mssql", "oracle"]),
    document: z.object({
        format: z.literal("goforge-project"),
        formatVersion: z.number().int().min(1),
        project: z.object({ tables: z.array(z.unknown()) }).passthrough(),
    }).passthrough(),
});

projectsRouter.get("/", handle(async (req, res) => {
    res.json(await getCloud()!.projects.list(ownerOf(req)));
}));

projectsRouter.get("/:id", handle(async (req, res) => {
    const project = ID.test(req.params.id) ? await getCloud()!.projects.get(ownerOf(req), req.params.id) : undefined;
    if (!project) return res.status(404).json({ error: "Diagram not found" });
    res.json(project);
}));

/** Creates the diagram or replaces it (the last save wins). Someone else's id is refused, not overwritten. */
projectsRouter.put("/:id", handle(async (req, res) => {
    if (!ID.test(req.params.id)) return res.status(400).json({ error: "Invalid diagram id" });
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid diagram" });
    const { name, dialect, document } = parsed.data;
    const saved = await getCloud()!.projects.upsert(ownerOf(req), { id: req.params.id, name, dialect, tables: document.project.tables.length, document });
    if (!saved) return res.status(409).json({ error: "That diagram id is already used by another account." });
    res.json(saved);
}));

projectsRouter.delete("/:id", handle(async (req, res) => {
    if (!ID.test(req.params.id)) return res.status(204).end();
    await getCloud()!.projects.delete(ownerOf(req), req.params.id);
    res.status(204).end();
}));
