import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ownerOf } from "../auth/context.js";
import { encryptSecret } from "../crypto/vault.js";
import { getCloud, getConnectionStore, type ConnectionRow } from "../db/stores.js";
import { cloudConnectionRow, cloudDatabaseName, dropCloudDatabase, newDatabaseOwner } from "../services/cloud-databases.js";
import { withOracle } from "../services/oracle-client.js";
import { failedChecks, introspectOracle, loadAndVerify, planOracleMigration, verifyTable, type MigrationEdits, type MigrationPlan, type MigrationResult, type OracleTable, type TableVerification } from "../services/oracle-migration.js";
import { allowedPgTypes, applyOperations } from "../services/oracle-type-edits.js";
import { AiNotConfiguredError, ModelPolicyError } from "../ai/provider.js";
import { createMigrationAgentReply, migrationAgentRequestSchema, type AgentState, type MigrationAgentResult } from "../ai/migration-agent.js";
import { createMigrationSummary } from "../ai/migration-summary.js";
import { checkFindings, createMigrationReview, type MigrationReviewResult } from "../ai/migration-review.js";
import { buildReport, digestForReview, digestForSummary, type DataFacts, type MigrationReport, type ReportSample } from "../services/migration-report.js";
import { readDataFacts, readSamples } from "../services/oracle-report-data.js";
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
    plan: (connection: import("oracledb").Connection, edits?: MigrationEdits) => Promise<MigrationPlan>;
    /** The Oracle schema as the dictionary describes it; the assistant's changes are checked against it. */
    introspect: typeof introspectOracle;
    /** Asks the model what changes the person's message calls for. */
    agent: (input: Parameters<typeof createMigrationAgentReply>[0], signal?: AbortSignal) => Promise<{ result: MigrationAgentResult; model: string }>;
    load: (oracle: ConnectionConfig, pg: ConnectionConfig, plan: MigrationPlan) => Promise<MigrationResult>;
    /** Reads the Oracle data the report is made from: counts of NULLs and of values the copy changes, and a few rows of every table. */
    readData: (connection: import("oracledb").Connection, plan: MigrationPlan, options: { samples: boolean }) => Promise<{ facts: DataFacts; samples?: Record<string, ReportSample> }>;
    /** Asks the model for the opening paragraph of the report, from the report's figures. */
    summary: (input: Parameters<typeof createMigrationSummary>[0], signal?: AbortSignal) => Promise<{ result: { summary: string }; model: string }>;
    /** Asks the model for a second opinion on the plan, from the report's figures (the plan reviewer: separate from the assistant that changes the plan). */
    review: (input: Parameters<typeof createMigrationReview>[0], signal?: AbortSignal) => Promise<{ result: MigrationReviewResult; model: string }>;
    /** Runs the checks of a migration again, against a database that already exists. */
    verify: (oracle: ConnectionConfig, pg: ConnectionConfig, plan: MigrationPlan) => Promise<TableVerification[]>;
}

export const defaultMigrationDeps: MigrationDeps = {
    plan: planOracleMigration,
    introspect: introspectOracle,
    agent: createMigrationAgentReply,
    readData: async (connection, plan, options) => ({ facts: await readDataFacts(connection, plan), ...(options.samples ? { samples: await readSamples(connection, plan) } : {}) }),
    summary: createMigrationSummary,
    review: createMigrationReview,
    load: (oracle, pg, plan) => withOracle(oracle, (connection) => withPgClient(pg, (client) => loadAndVerify(connection, client, plan))),
    verify: (oracle, pg, plan) =>
        withOracle(oracle, (connection) =>
            withPgClient(pg, async (client) => {
                const results: TableVerification[] = [];
                for (const table of plan.tables) results.push(await verifyTable(connection, client, table));
                return results;
            }),
        ),
};

const editsSchema = z
    .object({
        tables: z.record(z.object({ pgName: z.string().max(128).optional() })).default({}),
        columns: z.record(z.object({ pgName: z.string().max(128).optional(), pgType: z.string().max(60).optional(), dropDefault: z.boolean().optional() })).default({}),
        objects: z.record(z.object({ carry: z.boolean() })).default({}),
    })
    .default({});
const sourceSchema = z.object({ sourceConnectionId: z.string().min(1), edits: editsSchema });
const reviewSchema = sourceSchema.extend({ focus: z.string().trim().max(500).optional() });
const verifySchema = sourceSchema.extend({ targetConnectionId: z.string().min(1) });
const migrateSchema = sourceSchema.extend({
    /** The person has read the data a change would lose, and accepts it. */
    acceptLoss: z.boolean().default(false),
    /** The report the person read and approved: the fingerprint of it. The migration refuses to start if the report is no longer this one. */
    approval: z.object({ reportHash: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
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

/** How many things the person has changed in the plan. */
export const editCount = (edits: MigrationEdits): number => Object.keys(edits.tables ?? {}).length + Object.keys(edits.columns ?? {}).length + Object.keys(edits.objects ?? {}).length;

/** What the plan page needs of a plan: the tables with their notes and checks, what blocks the migration, what was refused, and what is left behind. */
export function planResponse(plan: MigrationPlan) {
    return { tables: plan.tables, problems: plan.problems, editProblems: plan.editProblems, notCarried: plan.notCarried, objects: plan.objects, behaviour: plan.behaviour, statements: plan.createSql.length + plan.linkSql.length + plan.objectSql.length };
}

/** What the model is shown of a plan: names, types, how each column fares, and the counts the checks found. No rows. */
export function agentState(plan: MigrationPlan, tables: OracleTable[]): AgentState {
    return {
        tables: plan.tables.map((table) => ({
            oracleName: table.oracleName,
            pgName: table.pgName,
            rows: table.rows,
            renamed: table.renamed,
            columns: table.columns.map((column) => {
                const source = tables.find((candidate) => candidate.name === table.oracleName)?.columns.find((candidate) => candidate.name === column.oracleName);
                return {
                    oracleName: column.oracleName,
                    pgName: column.pgName,
                    oracleType: column.oracleType,
                    pgType: column.pgType,
                    status: column.note.status,
                    note: column.note.text,
                    edited: column.edited,
                    oracleDefault: column.oracleDefault,
                    allowedPgTypes: source ? allowedPgTypes(source) : [],
                    ...(column.check ? { check: { description: column.check.description, count: column.check.count } } : {}),
                };
            }),
        })),
        problems: plan.problems,
        editProblems: plan.editProblems,
        notCarried: plan.notCarried.map((entry) => ({ kind: entry.kind, name: entry.name })),
        objects: plan.objects.map((object) => ({ kind: object.kind, name: object.oracleName, table: object.table, detail: object.detail, canCarry: object.carriable, ...(object.reason ? { reason: object.reason } : {}), carried: object.carried })),
    };
}

export function createMigrationsRouter(deps: MigrationDeps = defaultMigrationDeps): Router {
    const router = Router();

    /** What a migration would do, without doing it: the tables, how each column becomes PostgreSQL, the rows to copy, and what stops it. */
    router.post("/oracle-to-postgres/plan", handle(async (req, res) => {
        const parsed = sourceSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "Say which Oracle database to migrate." });
        const row = await oracleSource(req, res, parsed.data.sourceConnectionId);
        if (!row) return;
        try {
            const plan = await withOracle(oracleConfigOf(row), (connection) => deps.plan(connection, parsed.data.edits));
            res.json(planResponse(plan));
        } catch (error) {
            res.status(502).json({ error: `Could not read the Oracle database: ${error instanceof Error ? error.message : String(error)}` });
        }
    }));

    /**
     * The report a person reads before approving: what changes in the schema and in the data, from the plan and from reading the Oracle data
     * (read only), with a few sample rows per table. No model writes any of it.
     */
    router.post("/oracle-to-postgres/report", handle(async (req, res) => {
        const parsed = sourceSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "Say which Oracle database to report on." });
        const row = await oracleSource(req, res, parsed.data.sourceConnectionId);
        if (!row) return;
        try {
            const report = await withOracle(oracleConfigOf(row), async (connection) => {
                const plan = await deps.plan(connection, parsed.data.edits);
                const data = await deps.readData(connection, plan, { samples: true });
                return buildReport(plan, { source: row.name, facts: data.facts, samples: data.samples, edits: editCount(parsed.data.edits) });
            });
            res.json({ report });
        } catch (error) {
            res.status(502).json({ error: `Could not build the report: ${error instanceof Error ? error.message : String(error)}` });
        }
    }));

    /** The opening paragraph of the report, written by the model from the report's figures (never from row values) and sent back to be shown as AI commentary. */
    router.post("/oracle-to-postgres/report/summary", handle(async (req, res) => {
        const parsed = sourceSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "Say which Oracle database to summarize." });
        const row = await oracleSource(req, res, parsed.data.sourceConnectionId);
        if (!row) return;
        const controller = new AbortController();
        res.once("close", () => {
            if (!res.writableEnded) controller.abort();
        });
        try {
            const report = await withOracle(oracleConfigOf(row), async (connection) => {
                const plan = await deps.plan(connection, parsed.data.edits);
                const data = await deps.readData(connection, plan, { samples: false });
                return buildReport(plan, { source: row.name, facts: data.facts, edits: editCount(parsed.data.edits) });
            });
            const answer = await deps.summary({ digest: digestForSummary(report) }, controller.signal);
            if (controller.signal.aborted || res.writableEnded) return;
            res.json({ summary: answer.result.summary, model: answer.model, reportHash: report.hash });
        } catch (error) {
            if (controller.signal.aborted || res.writableEnded) return;
            const text = error instanceof Error ? error.message : String(error);
            const status = error instanceof ModelPolicyError ? 403 : error instanceof AiNotConfiguredError ? 503 : 502;
            res.status(status).json({ error: status === 502 ? `CosmicQuery could not write the summary: ${text}` : text });
        }
    }));

    /**
     * A second opinion on the plan, from a reviewer that is not the assistant: it is handed the report (never row values) and the list of changes the
     * person made, and answers with what looks wrong or risky. Every finding is checked against the plan before it is sent back, and none of it is part of what
     * is approved. Asked for on purpose; nothing else calls it.
     */
    router.post("/oracle-to-postgres/review", handle(async (req, res) => {
        const parsed = reviewSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "Say which Oracle database to review." });
        const row = await oracleSource(req, res, parsed.data.sourceConnectionId);
        if (!row) return;
        const controller = new AbortController();
        res.once("close", () => {
            if (!res.writableEnded) controller.abort();
        });
        try {
            const built = await withOracle(oracleConfigOf(row), async (connection) => {
                const tables = await deps.introspect(connection);
                const plan = await deps.plan(connection, parsed.data.edits);
                const data = await deps.readData(connection, plan, { samples: false });
                return { tables, report: buildReport(plan, { source: row.name, facts: data.facts, edits: editCount(parsed.data.edits) }) };
            });
            const answer = await deps.review({ digest: digestForReview(built.report, { edits: parsed.data.edits, tables: built.tables }), ...(parsed.data.focus ? { focus: parsed.data.focus } : {}) }, controller.signal);
            if (controller.signal.aborted || res.writableEnded) return;
            const checked = checkFindings(answer.result.findings, built.report.tables);
            res.json({ review: { overview: answer.result.overview, findings: checked.findings, dropped: checked.dropped }, model: answer.model, reportHash: built.report.hash });
        } catch (error) {
            if (controller.signal.aborted || res.writableEnded) return;
            const text = error instanceof Error ? error.message : String(error);
            const status = error instanceof ModelPolicyError ? 403 : error instanceof AiNotConfiguredError ? 503 : 502;
            res.status(status).json({ error: status === 502 ? `The reviewer could not answer: ${text}` : text });
        }
    }));

    /**
     * CosmicQuery, the assistant. The person's message and the plan go to the model, which answers with a reply and changes in a fixed set of operations;
     * each change is checked against the rules in `oracle-type-edits` and applied or refused with its reason, and the plan is built again from
     * the edits that stand. The model never touches the plan itself.
     */
    router.post("/oracle-to-postgres/agent", handle(async (req, res) => {
        const parsed = migrationAgentRequestSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "Say what you want changed." });
        const row = await oracleSource(req, res, parsed.data.sourceConnectionId);
        if (!row) return;
        const { message, messages, edits } = parsed.data;
        const config = oracleConfigOf(row);

        const controller = new AbortController();
        res.once("close", () => {
            if (!res.writableEnded) controller.abort();
        });
        try {
            const current = await withOracle(config, async (connection) => ({ tables: await deps.introspect(connection), plan: await deps.plan(connection, edits) }));
            const answer = await deps.agent({ state: agentState(current.plan, current.tables), messages, message, currentEdits: edits }, controller.signal);
            const changed = applyOperations(current.tables, edits, answer.result.operations, current.plan.objects.map((object) => ({ kind: object.kind, name: object.oracleName, carriable: object.carriable, reason: object.reason })));
            const plan = changed.applied.length === 0 ? current.plan : await withOracle(config, (connection) => deps.plan(connection, changed.edits));
            if (controller.signal.aborted || res.writableEnded) return;
            res.json({ reply: answer.result.reply, applied: changed.applied, rejected: changed.rejected, edits: changed.edits, plan: planResponse(plan), model: answer.model });
        } catch (error) {
            if (controller.signal.aborted || res.writableEnded) return;
            const text = error instanceof Error ? error.message : String(error);
            const status = error instanceof ModelPolicyError ? 403 : error instanceof AiNotConfiguredError ? 503 : 502;
            res.status(status).json({ error: status === 502 ? `CosmicQuery could not answer: ${text}` : text });
        }
    }));

    /** The checks of a migration, run again by queries on both databases: for an Oracle database and the PostgreSQL database it was migrated into. */
    router.post("/oracle-to-postgres/verify", handle(async (req, res) => {
        const parsed = verifySchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "Say which Oracle database and which PostgreSQL database to compare." });
        const source = await oracleSource(req, res, parsed.data.sourceConnectionId);
        if (!source) return;
        const target = await findConnection(req, parsed.data.targetConnectionId);
        if (!target) return res.status(404).json({ error: "The PostgreSQL database was not found." });
        try {
            const plan = await withOracle(oracleConfigOf(source), (connection) => deps.plan(connection, parsed.data.edits));
            const verification = await deps.verify(oracleConfigOf(source), toConnectionConfig(target), plan);
            res.json({ verification });
        } catch (error) {
            res.status(502).json({ error: `Could not compare the two databases: ${error instanceof Error ? error.message : String(error)}` });
        }
    }));

    router.post("/oracle-to-postgres", handle(async (req, res) => {
        const parsed = migrateSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
        const { sourceConnectionId, name, target, edits, acceptLoss } = parsed.data;
        const source = await oracleSource(req, res, sourceConnectionId);
        if (!source) return;

        const owner = ownerOf(req);
        const store = getConnectionStore();

        let plan: MigrationPlan;
        try {
            plan = await withOracle(oracleConfigOf(source), (connection) => deps.plan(connection, edits));
        } catch (error) {
            return res.status(502).json({ error: `Could not read the Oracle database: ${error instanceof Error ? error.message : String(error)}` });
        }
        if (plan.problems.length > 0) return res.status(422).json({ error: `This Oracle database cannot be migrated as it is: ${plan.problems.slice(0, 5).join(" ")}${plan.problems.length > 5 ? ` (and ${plan.problems.length - 5} more)` : ""}`, problems: plan.problems });
        // an approval is of one report: if what the person read is not what would run now (an edit, or the data moved), it is refused
        let approval: { reportHash: string; approvedAt: string } | undefined;
        if (parsed.data.approval) {
            let current: MigrationReport;
            try {
                current = await withOracle(oracleConfigOf(source), async (connection) => buildReport(plan, { source: source.name, facts: (await deps.readData(connection, plan, { samples: false })).facts, edits: editCount(edits) }));
            } catch (error) {
                return res.status(502).json({ error: `Could not check the report you approved: ${error instanceof Error ? error.message : String(error)}` });
            }
            if (current.hash !== parsed.data.approval.reportHash) return res.status(409).json({ code: "report-changed", error: "The report changed since you approved it (the plan or the data is not what you read). Read the new report and approve it again." });
            approval = { reportHash: current.hash, approvedAt: new Date().toISOString() };
        }
        // what the plan's own queries found on the Oracle data is decided here, from the data as it is now, not from what the page last showed
        const lossy = failedChecks(plan);
        if (lossy.length > 0 && !acceptLoss) {
            return res.status(409).json({
                code: "data-loss-not-accepted",
                error: `Some values would change or be lost, and that has not been accepted: ${lossy.slice(0, 5).map((entry) => `${entry.table}.${entry.column} (${entry.check.count === null ? `the check could not run: ${entry.check.error}` : `${entry.check.count} ${entry.check.description}`})`).join("; ")}${lossy.length > 5 ? ` (and ${lossy.length - 5} more)` : ""}.`,
                checks: lossy.map((entry) => ({ table: entry.table, column: entry.column, ...entry.check })),
            });
        }
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
        res.status(201).json({ connection: toPublicConnection(row), tables: result.tables, verification: result.verification, statementsRun: plan.createSql.length + plan.linkSql.length + plan.objectSql.length, carried: result.carried, approval: approval ?? null });
    }));

    return router;
}

