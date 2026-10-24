import { Router } from "express";
import { z } from "zod";
import { ownerOf } from "../auth/context.js";
import { getConnectionStore } from "../db/stores.js";
import { OracleSchemaError, createOracleSchema, dropOracleSchema, getOracleServer, newSchemaPassword, oracleConnectionRow, oracleSchemaName } from "../services/oracle-schemas.js";
import { handle } from "./async-handler.js";
import { toPublicConnection } from "./connections.js";

/** What creating and dropping an Oracle schema do; tests replace these, since there is no Oracle to reach. */
export interface OracleDatabaseDeps {
    createSchema: typeof createOracleSchema;
    dropSchema: typeof dropOracleSchema;
}

export function createOracleDatabasesRouter(deps: OracleDatabaseDeps = { createSchema: createOracleSchema, dropSchema: dropOracleSchema }): Router {
    const router = Router();

    /** Whether this server can create Oracle databases, and how many this account has used. */
    router.get("/status", handle(async (req, res) => {
        const server = getOracleServer();
        if (!server) return res.json({ configured: false });
        res.json({ configured: true, limit: server.maxSchemasPerUser, used: await getConnectionStore().countManaged(ownerOf(req), "oracle") });
    }));

    const createSchema = z.object({
        /** What the database is called to its owner; the schema's name is made from it. */
        name: z.string().trim().min(1).max(60),
        /** The Oracle script to build in it (CREATE TABLE ...). */
        sql: z.string().min(1).max(2_000_000),
    });

    /**
     * Creates a schema for the account on the app's Oracle server, builds the script in it, and saves a connection to it. The account never
     * sees the server's credentials; every page reaches the schema through its saved connection.
     */
    router.post("/", handle(async (req, res) => {
        const server = getOracleServer();
        if (!server) return res.status(404).json({ error: "This server has no Oracle database to create schemas on: set ORACLE_ADMIN_URL in server/.env." });
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
        const { name, sql } = parsed.data;

        const owner = ownerOf(req);
        const store = getConnectionStore();
        const used = await store.countManaged(owner, "oracle");
        if (used >= server.maxSchemasPerUser) {
            return res.status(403).json({ error: `You already have ${used} Oracle databases, the limit on this server. Delete one first.`, code: "oracle-database-limit" });
        }

        const schema = oracleSchemaName(owner, name);
        const password = newSchemaPassword();
        try {
            const { statementsRun } = await deps.createSchema(server.admin, schema, password, sql);
            const row = oracleConnectionRow(server.admin, schema, name, password);
            try {
                await store.insert(owner, row);
            } catch (error) {
                // The schema exists but nothing points at it: remove it rather than leave something nobody can reach or delete.
                await deps.dropSchema(server.admin, schema).catch(() => undefined);
                throw error;
            }
            res.status(201).json({ connection: toPublicConnection(row), statementsRun });
        } catch (error) {
            if (error instanceof OracleSchemaError) {
                if (error.kind === "exists") return res.status(409).json({ error: `You already have an Oracle database called "${name}". Choose another name.` });
                return res.status(error.kind === "permission" ? 403 : error.kind === "schema" ? 422 : 502).json({ error: error.message });
            }
            throw error;
        }
    }));

    return router;
}

export const oracleDatabasesRouter = createOracleDatabasesRouter();
