import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ownerOf } from "../auth/context.js";
import { encryptSecret } from "../crypto/vault.js";
import { getCloud, getConnectionStore, type ConnectionRow } from "../db/stores.js";
import { cloudConnectionRow, cloudDatabaseName, dropCloudDatabase, newDatabaseOwner } from "../services/cloud-databases.js";
import { withOracle } from "../services/oracle-client.js";
import { loadAndVerify, planOracleMigration, type MigrationPlan, type MigrationResult } from "../services/oracle-migration.js";
import { oracleConfigOf } from "../services/oracle-client.js";
import { CreateDatabaseError, DATABASE_NAME_PATTERN, DatabaseExistsError, createDatabaseFromSql } from "../services/pg-create-database.js";
import { toConnectionConfig, withPgClient, type ConnectionConfig } from "../services/pg-client.js";
import { handle } from "./async-handler.js";
import { findConnection } from "./connection-lookup.js";
import { toPublicConnection } from "./connections.js";

/**
 * Migrating an Oracle database (a schema GoForge created) into a new PostgreSQL database: the schema as PostgreSQL, the rows, the keys,
 * and a check that every table arrived whole. The new database is a GoForge cloud database for the account, or a database created on one
 * of the account's saved PostgreSQL servers. If anything fails, the new database is dropped again and nothing is saved.
 */
export const migrationsRouter = Router();

/** What a migration does at its two ends; tests replace these where there is no server to reach. */
export interface MigrationDeps {
    plan: typeof planOracleMigration;
    load: (oracle: ConnectionConfig, pg: ConnectionConfig, plan: MigrationPlan) => Promise<MigrationResult>;
}

const realDeps: MigrationDeps = {
    plan: planOracleMigration,
    load: (oracle, pg, plan) => withOracle(oracle, (connection) => withPgClient(pg, (client) => loadAndVerify(connection, client, plan))),
};

const sourceSchema = z.object({ sourceConnectionId: z.string().min(1) });
const migrateSchema = sourceSchema.extend({
    /** What the new database is called to its owner. */
    name: z.string().trim().min(1).max(60),
    target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("cloud") }),
        z.object({ kind: z.literal("server"), connectionId: z.string().min(1), database: z.string().regex(DATABASE_NAME_PATTERN, "A database name uses letters, digits and underscores, starts with a letter or underscore, and is at most 63 characters.").optional() }),
    ]),
});

async function oracleSource(req: import("express").Request, res: import("express").Response, id: string): Promise<ConnectionRow | undefined> {
    const row = await findConnection(req, id, { engine: "any" });
    if (!row) {
        res.status(404).json({ error: "Connection not found" });
        return undefined;
    }
    if (row.engine !== "oracle") {
        res.status(400).json({ error: `"${row.name}" is not an Oracle database.` });
        return undefined;
    }
    return row;
}

export function createMigrationsRouter(deps: MigrationDeps = realDeps): Router {
    const router = Router();

    /** What a migration would do, without doing it: the tables, how each column becomes PostgreSQL, the rows to copy, and what stops it. */
    router.post("/oracle-to-postgres/plan", handle(async (req, res) => {
        const parsed = sourceSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "Say which Oracle database to migrate." });
        const row = await oracleSource(req, res, parsed.data.sourceConnectionId);
        if (!row) return;
        try {
            const plan = await withOracle(oracleConfigOf(row), deps.plan);
            res.json({ tables: plan.tables, problems: plan.problems, statements: plan.createSql.length + plan.linkSql.length });
        } catch (error) {
            res.status(502).json({ error: `Could not read the Oracle database: ${error instanceof Error ? error.message : String(error)}` });
        }
    }));

    router.post("/oracle-to-postgres", handle(async (req, res) => {
        const parsed = migrateSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
        const { sourceConnectionId, name, target } = parsed.data;
        const source = await oracleSource(req, res, sourceConnectionId);
        if (!source) return;

        const owner = ownerOf(req);
        const store = getConnectionStore();

        let plan: MigrationPlan;
        try {
            plan = await withOracle(oracleConfigOf(source), deps.plan);
        } catch (error) {
            return res.status(502).json({ error: `Could not read the Oracle database: ${error instanceof Error ? error.message : String(error)}` });
        }
        if (plan.problems.length > 0) return res.status(422).json({ error: `This Oracle database cannot be migrated as it is: ${plan.problems.slice(0, 5).join(" ")}${plan.problems.length > 5 ? ` (and ${plan.problems.length - 5} more)` : ""}`, problems: plan.problems });
        const createSql = plan.createSql.join(";\n");

        // 1. the new database, with the tables and their keys
        let dataConfig: ConnectionConfig;
        let row: ConnectionRow;
        let drop: () => Promise<void>;
        try {
            if (target.kind === "cloud") {
                const cloud = getCloud();
                if (!cloud) return res.status(404).json({ error: "Cloud databases need the application database: set DATABASE_URL in server/.env." });
                const used = await store.countCloud(owner);
                if (used >= cloud.maxDatabasesPerUser) return res.status(403).json({ error: `You already have ${used} cloud databases, the limit on this server. Delete one first.`, code: "cloud-database-limit" });
                const physical = cloudDatabaseName(owner, name);
                const databaseOwner = newDatabaseOwner(physical);
                await createDatabaseFromSql(cloud.admin, physical, createSql, undefined, databaseOwner);
                row = cloudConnectionRow(cloud.admin, physical, name, databaseOwner);
                dataConfig = toConnectionConfig(row);
                drop = () => dropCloudDatabase(cloud.admin, physical);
            } else {
                const server = await findConnection(req, target.connectionId);
                if (!server) return res.status(404).json({ error: "The server to create the database on was not found." });
                if (server.kind === "cloud") return res.status(400).json({ error: "Choose the GoForge cloud target instead: a cloud database's login may not create more databases." });
                const config = toConnectionConfig(server);
                const database = target.database ?? name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "db_$1").slice(0, 63);
                if (!DATABASE_NAME_PATTERN.test(database)) return res.status(400).json({ error: "Give the database a name that uses letters, digits and underscores." });
                await createDatabaseFromSql(config, database, createSql);
                const secret = encryptSecret(config.password);
                const now = new Date().toISOString();
                row = { id: randomUUID(), name, host: server.host, port: server.port, username: server.username, database_name: database, ssl_mode: server.ssl_mode, password_ciphertext: secret.ciphertext, password_iv: secret.iv, password_auth_tag: secret.authTag, created_at: now, updated_at: now };
                dataConfig = { ...config, database };
                drop = () => withPgClient(config, (client) => client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)).then(() => undefined);
            }
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (error instanceof DatabaseExistsError) return res.status(409).json({ error: target.kind === "cloud" ? `You already have a database called "${name}". Choose another name.` : text });
            if (error instanceof CreateDatabaseError) return res.status(error.kind === "permission" ? 403 : error.kind === "schema" ? 422 : 502).json({ error: text });
            throw error;
        }

        // 2. the rows, the foreign keys, and the check; if any of it fails the database goes again
        let result: MigrationResult;
        try {
            result = await deps.load(oracleConfigOf(source), dataConfig, plan);
            await store.insert(owner, row);
        } catch (error) {
            const cleanup = await drop().then(() => "", (dropError) => ` The new database could not be removed again (${dropError instanceof Error ? dropError.message : String(dropError)}); drop it by hand.`);
            return res.status(502).json({ error: `The migration did not complete and nothing was kept. ${error instanceof Error ? error.message : String(error)}${cleanup}` });
        }
        res.status(201).json({ connection: toPublicConnection(row), tables: result.tables, verification: result.verification, statementsRun: plan.createSql.length + plan.linkSql.length });
    }));

    return router;
}

