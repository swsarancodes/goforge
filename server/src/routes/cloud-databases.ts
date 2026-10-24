import { Router } from "express";
import { z } from "zod";
import { ownerOf } from "../auth/context.js";
import { getCloud, getConnectionStore } from "../db/stores.js";
import { cloudConnectionRow, cloudDatabaseName, dropCloudDatabase, newDatabaseOwner } from "../services/cloud-databases.js";
import { CreateDatabaseError, DatabaseExistsError, createDatabaseFromSql } from "../services/pg-create-database.js";
import { handle } from "./async-handler.js";
import { toPublicConnection } from "./connections.js";

/** What creating and dropping a physical database do; tests replace these, since a stand-in Postgres has a single database. */
export interface CloudDatabaseDeps {
    createDatabase: typeof createDatabaseFromSql;
    dropDatabase: typeof dropCloudDatabase;
}

export function createCloudDatabasesRouter(deps: CloudDatabaseDeps = { createDatabase: createDatabaseFromSql, dropDatabase: dropCloudDatabase }): Router {
    const router = Router();

    const createSchema = z.object({
        /** What the database is called to its owner; the physical name is made from it. */
        name: z.string().trim().min(1).max(60),
        /** The schema script to build in it. */
        sql: z.string().min(1),
    });

    /**
     * Creates a database for the signed-in account on the application's own server, builds the schema in it, and saves a connection to it.
     * The account never sees the server's credentials; every page reaches the database through its saved connection.
     */
    router.post("/", handle(async (req, res) => {
        const cloud = getCloud();
        if (!cloud) return res.status(404).json({ error: "Cloud databases need the application database: set DATABASE_URL in server/.env." });
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
        const { name, sql } = parsed.data;

        const owner = ownerOf(req);
        const store = getConnectionStore();
        const used = await store.countCloud(owner);
        if (used >= cloud.maxDatabasesPerUser) {
            return res.status(403).json({ error: `You already have ${used} cloud databases, the limit on this server. Delete one first.`, code: "cloud-database-limit" });
        }

        const physical = cloudDatabaseName(owner, name);
        try {
            const databaseOwner = newDatabaseOwner(physical);
            const { statementsRun } = await deps.createDatabase(cloud.admin, physical, sql, undefined, databaseOwner);
            const row = cloudConnectionRow(cloud.admin, physical, name, databaseOwner);
            try {
                await store.insert(owner, row);
            } catch (error) {
                // The database exists but nothing points at it: remove it rather than leave something nobody can reach or delete.
                await deps.dropDatabase(cloud.admin, physical).catch(() => undefined);
                throw error;
            }
            res.status(201).json({ connection: toPublicConnection(row), statementsRun });
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (error instanceof DatabaseExistsError) return res.status(409).json({ error: `You already have a database called "${name}". Choose another name.` });
            if (error instanceof CreateDatabaseError) return res.status(error.kind === "permission" ? 403 : error.kind === "schema" ? 422 : 502).json({ error: text });
            throw error;
        }
    }));

    return router;
}

export const cloudDatabasesRouter = createCloudDatabasesRouter();
