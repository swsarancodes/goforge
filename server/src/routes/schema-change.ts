import { Router } from "express";
import { z } from "zod";
import { ownerOf } from "../auth/context.js";
import type { ConnectionRow } from "../db/stores.js";
import { findConnection } from "./connection-lookup.js";
import { AiNotConfiguredError, ModelPolicyError, callModelJson, getAuditStore, getSettingsStore } from "../ai/provider.js";
import { loadCatalog, type Catalog } from "../schema-change/catalog.js";
import { loadFacts, probe } from "../schema-change/facts.js";
import { healthReport } from "../schema-change/health.js";
import { diffExpected } from "../schema-change/expected-state.js";
import { preflight } from "../schema-change/preflight.js";
import { summarizeHealth } from "../schema-change/health-summary.js";
import { PlannerError, planSchemaChange } from "../schema-change/planner.js";
import { buildSearchIndex, selectScope, type SearchIndex } from "../schema-change/retrieval.js";
import { summarizeRunbook } from "../schema-change/runbook.js";
import { withReadClient } from "../services/pg-pool.js";

/** Planning a schema change on a live PostgreSQL database: find the tables, read the facts, plan, compile, report on health. Read-only on the database. */
export const schemaChangeRouter = Router();

// The catalog of a large database is the slowest thing to read; keep it for a short while so scope changes feel instant.
const CATALOG_TTL_MS = 60_000;
const catalogs = new Map<string, { at: number; version: string; catalog: Catalog; index: SearchIndex }>();

async function catalogFor(row: ConnectionRow, fresh = false) {
    const cached = catalogs.get(row.id);
    if (!fresh && cached && cached.version === row.updated_at && Date.now() - cached.at < CATALOG_TTL_MS) return cached;
    const catalog = await withReadClient(row, loadCatalog);
    const entry = { at: Date.now(), version: row.updated_at, catalog, index: buildSearchIndex(catalog) };
    catalogs.set(row.id, entry);
    return entry;
}

const fail = (res: import("express").Response, error: unknown) => {
    if (error instanceof ModelPolicyError) return res.status(403).json({ error: error.message, code: "blocked_by_policy" });
    if (error instanceof PlannerError) return res.status(error.status).json({ error: error.message });
    const message = error instanceof Error ? error.message : String(error);
    return res.status(error instanceof AiNotConfiguredError ? 503 : 502).json({ error: message });
};

const abortOnClose = (req: import("express").Request, res: import("express").Response) => {
    const controller = new AbortController();
    const cancel = () => {
        if (!res.writableEnded) controller.abort();
    };
    req.once("aborted", cancel);
    res.once("close", cancel);
    return controller;
};

schemaChangeRouter.get("/:id/schema-change/catalog", async (req, res) => {
    const row = await findConnection(req);
    if (!row) return res.status(404).json({ error: "Connection not found" });
    try {
        const { catalog } = await catalogFor(row, req.query.refresh === "1");
        res.json({
            serverVersion: catalog.serverVersion,
            loadedAt: catalog.loadedAt,
            tables: catalog.tables.map(({ qualified, schema, name, partitioned, partitionCount, estimatedRows, totalBytes, columns, foreignKeys }) => ({
                qualified, schema, name, partitioned, partitionCount, estimatedRows, totalBytes, columns: columns.length, foreignKeys: foreignKeys.length,
            })),
        });
    } catch (error) {
        fail(res, error);
    }
});

const scopeSchema = z.object({ prompt: z.string().trim().min(1).max(8_000), maxTables: z.number().int().min(1).max(100).optional() });

schemaChangeRouter.post("/:id/schema-change/scope", async (req, res) => {
    const row = await findConnection(req);
    if (!row) return res.status(404).json({ error: "Connection not found" });
    const parsed = scopeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    try {
        const { index, catalog } = await catalogFor(row);
        const startedAt = performance.now();
        const scope = selectScope(index, parsed.data.prompt, parsed.data.maxTables ? { maxTables: parsed.data.maxTables } : {});
        res.json({ ...scope, searchMs: Math.round((performance.now() - startedAt) * 10) / 10, catalogLoadedAt: catalog.loadedAt });
    } catch (error) {
        fail(res, error);
    }
});

const planSchema = z.object({
    prompt: z.string().trim().min(3).max(8_000),
    /** Tables the model is shown. Optional: with none, it is given the names of the tables that exist and the ones the plan turns out to need are read for it. */
    tables: z.array(z.string().min(1).max(300)).max(100).default([]),
    /** Absent: the workspace setting decides. */
    redact: z.boolean().optional(),
});

schemaChangeRouter.post("/:id/schema-change/plan", async (req, res) => {
    const row = await findConnection(req);
    if (!row) return res.status(404).json({ error: "Connection not found" });
    const parsed = planSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

    const controller = abortOnClose(req, res);
    try {
        const redact = parsed.data.redact ?? getSettingsStore().read().settings.redactNames;
        const result = await planSchemaChange(
            {
                loadFacts: (tables) => withReadClient(row, (client) => loadFacts(client, tables)),
                probe: (request) => withReadClient(row, (client) => probe(client, request)),
                wholeDatabase: async () => ({ tables: (await catalogFor(row)).catalog.tables.map(({ schema, name }) => ({ schema, name })) }),
                callModel: callModelJson,
            },
            { prompt: parsed.data.prompt, tables: parsed.data.tables, redact, connection: { id: row.id, name: row.name }, signal: controller.signal },
        );
        if (controller.signal.aborted || res.writableEnded) return;
        // The plan as one more audit line: what was produced from the model call(s) it follows.
        const auditId = await getAuditStore().record({
            ownerId: ownerOf(req),
            kind: "plan",
            purpose: "schema-plan",
            status: "ok",
            connectionId: row.id,
            connectionName: row.name,
            parentId: result.auditIds[result.auditIds.length - 1] ?? null,
            redacted: result.redacted,
            detail: {
                operations: result.plan.operations.length,
                compiled: result.runbook ? result.plan.operations.length - result.runbook.uncompiled.length : 0,
                errors: result.findings.filter((finding) => finding.severity === "error").length,
                steps: result.runbook?.steps.length ?? 0,
                risk: result.runbook ? summarizeRunbook(result.runbook).byRisk : null,
                lintViolations: result.lint?.violations.length ?? null,
                tables: result.scope,
                summary: result.plan.summary,
            },
        });
        res.json({ ...result, auditId, summary: result.runbook ? summarizeRunbook(result.runbook) : null });
    } catch (error) {
        if (controller.signal.aborted || res.writableEnded) return;
        fail(res, error);
    }
});

schemaChangeRouter.get("/:id/schema-change/health", async (req, res) => {
    const row = await findConnection(req);
    if (!row) return res.status(404).json({ error: "Connection not found" });
    try {
        res.json(await withReadClient(row, (client) => healthReport(client)));
    } catch (error) {
        fail(res, error);
    }
});

/** What to check on the live database before running a runbook: other sessions on the tables, long transactions, replicas, slots, timeouts. Read-only. */
schemaChangeRouter.get("/:id/schema-change/preflight", async (req, res) => {
    const row = await findConnection(req);
    if (!row) return res.status(404).json({ error: "Connection not found" });
    const tables = (typeof req.query.tables === "string" ? req.query.tables.split(",") : []).map((name) => name.trim()).filter(Boolean).slice(0, 100);
    if (tables.some((name) => name.length > 300)) return res.status(400).json({ error: "A table name is too long." });
    try {
        res.json(await withReadClient(row, (client) => preflight(client, tables)));
    } catch (error) {
        fail(res, error);
    }
});

const name = z.string().min(1).max(300);
const expectedSchema = z.object({
    tables: z.array(z.object({
        qualified: name,
        columns: z.array(z.object({ name, type: z.string().max(300), notNull: z.boolean() })).max(2_000),
        primaryKey: z.array(name).max(100),
        uniques: z.array(z.object({ name, columns: z.array(name).max(100) })).max(500),
        checks: z.array(z.object({ name, validated: z.boolean() })).max(500),
        foreignKeys: z.array(z.object({ name, columns: z.array(name).max(100), refTable: name, refColumns: z.array(name).max(100), validated: z.boolean() })).max(500),
        indexes: z.array(z.object({ name, columns: z.array(name.nullable()).max(100), unique: z.boolean() })).max(1_000),
        views: z.array(name).max(1_000),
    })).max(100),
    absent: z.array(name).max(100),
});

/** After a runbook has run: read the catalog again and compare it with the state the compiler said it would leave. Read-only. */
schemaChangeRouter.post("/:id/schema-change/verify", async (req, res) => {
    const row = await findConnection(req);
    if (!row) return res.status(404).json({ error: "Connection not found" });
    const parsed = z.object({ expected: expectedSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    const { expected } = parsed.data;
    try {
        const names = [...expected.tables.map((table) => table.qualified), ...expected.absent];
        const actual = await withReadClient(row, (client) => loadFacts(client, names));
        res.json({ checkedAt: new Date().toISOString(), tables: expected.tables.length + expected.absent.length, mismatches: diffExpected(expected, actual) });
    } catch (error) {
        fail(res, error);
    }
});

schemaChangeRouter.post("/:id/schema-change/health/summary", async (req, res) => {
    const row = await findConnection(req);
    if (!row) return res.status(404).json({ error: "Connection not found" });
    const controller = abortOnClose(req, res);
    try {
        const report = await withReadClient(row, (client) => healthReport(client));
        const redact = typeof req.body?.redact === "boolean" ? req.body.redact : getSettingsStore().read().settings.redactNames;
        const summary = await summarizeHealth(report, { callModel: callModelJson }, { redact, connection: { id: row.id, name: row.name }, signal: controller.signal });
        if (controller.signal.aborted || res.writableEnded) return;
        res.json({ summary, generatedAt: report.generatedAt });
    } catch (error) {
        if (controller.signal.aborted || res.writableEnded) return;
        fail(res, error);
    }
});
