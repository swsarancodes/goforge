import { describe, expect, it } from "vitest";
import { keyedBackfill, pagedBackfill } from "./backfill.js";
import { isPlainTypeName, loadFacts, probe, splitQualified, type ProbeRequest } from "./facts.js";
import { riskOf, sizeClass, SIZE_LIMITS, summarizeRunbook, type LockMode, type Work } from "./runbook.js";
import { checkDefaultExpression, formatBytes, functionsIn, ident, isIntegerType, limitName, literal, renderType } from "./sql-render.js";
import { classifyTypeChange, parseType, sameType } from "./type-change.js";
import { GIB, MIB, table } from "./test-fixtures.js";
import type { Queryable } from "../services/pg-read.js";

describe("sql-render", () => {
    it("quotes only what needs quoting", () => {
        expect(ident("orders")).toBe("orders");
        expect(ident("Orders")).toBe('"Orders"');
        expect(ident("order")).toBe('"order"');
        expect(ident("user")).toBe('"user"');
        expect(ident("status")).toBe("status");
        expect(ident('we"ird')).toBe('"we""ird"');
        expect(ident("9lives")).toBe('"9lives"');
        expect(() => ident("a\0b")).toThrow();
    });

    it("writes string literals safely", () => {
        expect(literal("it's")).toBe("'it''s'");
        expect(literal("a\\b")).toBe("E'a\\\\b'");
    });

    it("keeps invented names within 63 bytes and unique", () => {
        const long = "x".repeat(80);
        expect(Buffer.byteLength(limitName(long))).toBeLessThanOrEqual(63);
        expect(limitName("a_idx", new Set(["a_idx"]))).toBe("a_idx_1");
        expect(limitName("a_idx", new Set(["a_idx", "a_idx_1"]))).toBe("a_idx_2");
        const taken = new Set([limitName(long)]);
        const next = limitName(long, taken);
        expect(next).not.toBe([...taken][0]);
        expect(Buffer.byteLength(next)).toBeLessThanOrEqual(63);
    });

    it("adds length, precision and scale to the type that takes them", () => {
        expect(renderType({ dataType: "varchar", maxLength: 40 })).toBe("varchar(40)");
        expect(renderType({ dataType: "character varying", maxLength: 40 })).toBe("character varying(40)");
        expect(renderType({ dataType: "numeric", precision: 12, scale: 2 })).toBe("numeric(12,2)");
        expect(renderType({ dataType: "numeric", precision: 12 })).toBe("numeric(12)");
        expect(renderType({ dataType: "varchar(10)", maxLength: 99 })).toBe("varchar(10)");
        expect(renderType({ dataType: "text", maxLength: 99 })).toBe("text");
        expect(renderType({ dataType: "varchar[]", maxLength: 8 })).toBe("varchar(8)[]");
        expect(isIntegerType("BIGINT")).toBe(true);
        expect(isIntegerType("numeric(10,0)")).toBe(false);
    });

    it("accepts a single expression as a default and nothing that could be a second statement", () => {
        for (const ok of ["0", "'new'", "now()", "gen_random_uuid()", "'a;b'", "(1 + 2) * 3", "'x'::text", "current_timestamp", "'it''s; fine'"]) expect(checkDefaultExpression(ok), ok).toBeUndefined();
        for (const bad of ["", "1; drop table x", "1 -- hi", "/* c */ 1", "(select 1)", "$$x$$", "'unterminated", "1, delete from t", "1) AS int), (2", "(1", "now())"]) expect(checkDefaultExpression(bad), bad).toBeDefined();
        expect(functionsIn("coalesce(lower('A(b)'), now()) + abs(1)")).toEqual(["lower", "now", "abs"]);
    });

    it("formats sizes", () => {
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(1536)).toBe("1.5 KiB");
        expect(formatBytes(5 * GIB)).toBe("5.0 GiB");
    });
});

describe("type changes", () => {
    it("parses types with arguments and aliases", () => {
        expect(parseType("character varying(20)")).toEqual({ base: "character varying", args: [20], array: false });
        expect(parseType("varchar(20)[]")).toEqual({ base: "character varying", args: [20], array: true });
        expect(parseType("numeric(12,2)")).toEqual({ base: "numeric", args: [12, 2], array: false });
        expect(parseType("int4").base).toBe("integer");
        expect(sameType("varchar(20)", "character varying(20)")).toBe(true);
        expect(sameType("varchar(20)", "character varying(21)")).toBe(false);
        // a type on the search path is reported without its schema
        expect(sameType("public.mood", "mood")).toBe(true);
        expect(sameType("mood[]", "public.mood[]")).toBe(true);
        expect(sameType("billing.mood", "public.mood")).toBe(false);
        expect(sameType("public.mood", "public.moods")).toBe(false);
    });

    it("lists the changes that are catalog-only and treats everything else as a rewrite", () => {
        const rewrite = (from: string, to: string, cast?: "b" | "f") => classifyTypeChange(from, to, cast).rewrite;
        expect(rewrite("character varying(20)", "character varying(50)")).toBe(false);
        expect(rewrite("character varying(20)", "character varying")).toBe(false);
        expect(rewrite("character varying(20)", "text", "b")).toBe(false);
        expect(rewrite("text", "character varying", "b")).toBe(false);
        expect(rewrite("numeric(10,2)", "numeric(12,2)")).toBe(false);
        expect(rewrite("numeric(10,2)", "numeric")).toBe(false);
        expect(rewrite("character varying(20)", "character varying(10)")).toBe(true);
        expect(rewrite("character varying", "character varying(30)")).toBe(true);
        expect(rewrite("text", "character varying(100)", "b")).toBe(true);
        expect(rewrite("numeric(10,2)", "numeric(10,3)")).toBe(true);
        expect(rewrite("numeric(10,2)", "numeric(8,2)")).toBe(true);
        expect(rewrite("integer", "bigint", "f")).toBe(true);
        expect(rewrite("text", "integer", undefined)).toBe(true);
        expect(rewrite("integer", "integer[]")).toBe(true);
    });
});

describe("risk", () => {
    const risk = (lock: LockMode, work: Work, size: Parameters<typeof riskOf>[0]["size"]) => riskOf({ lock, work, size }).risk;

    it("classifies a table by the size of its data", () => {
        expect(sizeClass(undefined)).toBe("new");
        expect(sizeClass(table({ name: "t", bytes: SIZE_LIMITS.smallBytes - 1 }))).toBe("small");
        expect(sizeClass(table({ name: "t", bytes: SIZE_LIMITS.smallBytes }))).toBe("medium");
        expect(sizeClass(table({ name: "t", bytes: SIZE_LIMITS.largeBytes }))).toBe("large");
        expect(sizeClass({ ...table({ name: "t", bytes: 5 * GIB }), isNew: true })).toBe("new");
    });

    it("follows the stated rules", () => {
        expect(risk("ACCESS EXCLUSIVE", "metadata", "small")).toBe("low");
        expect(risk("ACCESS EXCLUSIVE", "metadata", "medium")).toBe("low");
        expect(risk("ACCESS EXCLUSIVE", "metadata", "large")).toBe("medium");
        expect(risk("SHARE UPDATE EXCLUSIVE", "metadata", "large")).toBe("low");
        expect(risk("ACCESS EXCLUSIVE", "scan", "small")).toBe("low");
        expect(risk("ACCESS EXCLUSIVE", "scan", "medium")).toBe("medium");
        expect(risk("ACCESS EXCLUSIVE", "scan", "large")).toBe("high");
        expect(risk("SHARE", "index-build", "large")).toBe("high");
        expect(risk("SHARE UPDATE EXCLUSIVE", "index-build", "large")).toBe("low");
        expect(risk("SHARE UPDATE EXCLUSIVE", "scan", "large")).toBe("low");
        expect(risk("ACCESS EXCLUSIVE", "rewrite", "small")).toBe("medium");
        expect(risk("ACCESS EXCLUSIVE", "rewrite", "medium")).toBe("high");
        expect(risk("ACCESS EXCLUSIVE", "rewrite", "large")).toBe("high");
        expect(risk("ROW EXCLUSIVE", "backfill", "medium")).toBe("low");
        expect(risk("ROW EXCLUSIVE", "backfill", "large")).toBe("medium");
        expect(risk("ACCESS EXCLUSIVE", "rewrite", "new")).toBe("low");
        expect(riskOf({ lock: "SHARE", work: "scan", size: "large" }).reason).toMatch(/large table/);
    });

    it("counts the steps that will run, not the optional ones", () => {
        const step = (risk: "low" | "high", optional = false) => ({ risk, optional, work: "metadata", destructive: false }) as never;
        expect(summarizeRunbook({ steps: [step("low"), step("high"), step("high", true)] })).toMatchObject({ steps: 3, byRisk: { low: 1, medium: 0, high: 1 }, optional: 1 });
    });
});

describe("batched backfill", () => {
    it("walks the key in committed batches, skips rows already done, and has no OR on the variable", () => {
        const sql = keyedBackfill({ table: "public.orders", key: "id", assignments: "qty__new = qty::bigint", needsUpdate: "qty__new IS DISTINCT FROM qty::bigint", batchRows: 5000, pauseMs: 100 });
        expect(sql).toContain("last_key public.orders.id%TYPE;");
        expect(sql).toContain("LIMIT 5000");
        expect(sql).toContain("COMMIT;");
        expect(sql).toContain("PERFORM pg_sleep(0.1);");
        expect(sql).toContain("AND (qty__new IS DISTINCT FROM qty::bigint)");
        expect(sql).not.toMatch(/last_key IS NULL OR/);
        expect(keyedBackfill({ table: "t", key: "id", assignments: "a = 1", needsUpdate: "true", batchRows: 1, pauseMs: 0 })).not.toContain("pg_sleep");
    });

    it("walks pages when there is no key", () => {
        const sql = pagedBackfill({ table: "public.log", assignments: "a = 1", needsUpdate: "a IS NULL", pagesPerBatch: 40, pauseMs: 0 });
        expect(sql).toContain("'public.log'::regclass");
        expect(sql).toContain("first_page + 40");
        expect(sql).toContain("COMMIT;");
    });
});

/** A client that answers the way the read-only runner expects: [BEGIN, SET, ...results, ROLLBACK]. */
const fakeClient = (rows: Record<string, unknown>[][], seen: string[] = []): Queryable => ({
    async query(text: string) {
        seen.push(text);
        return [{ rows: [] }, { rows: [] }, ...rows.map((r) => ({ rows: r })), { rows: [] }];
    },
});

describe("facts", () => {
    it("never asks for column values: no most_common_vals, histogram or row data", async () => {
        const seen: string[] = [];
        await loadFacts(fakeClient([[{ num: "160000", text: "16.0", stats_reset: null }], [], [], [], [], [], [], []], seen), ["public.orders"]);
        const sql = seen.join("\n");
        expect(sql).not.toMatch(/most_common|histogram|most_common_freqs|correlation/i);
        expect(sql).toMatch(/null_frac/);
        expect(sql).toMatch(/READ ONLY/);
        expect(sql).not.toMatch(/\bFROM\s+(public\.)?orders\b/);
    });

    it("builds tables out of the rows, with sizes as numbers, and groups what belongs to each", async () => {
        const facts = await loadFacts(
            fakeClient([
                [{ num: "160004", text: "16.4", stats_reset: "2026-01-02T00:00:00Z" }],
                [{ oid: "1", schema: "public", name: "orders", partitioned: false, estimated_rows: "42", heap_bytes: "8192", index_bytes: "16384", total_bytes: "24576", partition_count: 0, nested_partitions: false, partitions: [], user_triggers: 1, live: "40", dead: "2", last_vacuum: null, last_autovacuum: "2026-01-03T00:00:00Z", last_analyze: null, last_autoanalyze: null, seq_scan: "5", idx_scan: null, mods: "3" }],
                [{ schema: "public", table: "orders", name: "id", type: "bigint", type_schema: "pg_catalog", not_null: true, default: null, generated: "always-identity", null_frac: 0, n_distinct: -1 }],
                [{ schema: "public", table: "orders", name: "orders_fk", kind: "f", definition: "", validated: false, columns: ["customer_id"], ref_schema: "public", ref_table: "customers", ref_columns: ["id"], on_delete: "c", on_update: "a" }],
                [{ ref_schema: "public", ref_table: "orders", schema: "public", table: "items", name: "items_fk", columns: ["order_id"], ref_columns: ["id"] }],
                [{ schema: "public", table: "orders", name: "orders_pkey", definition: "CREATE UNIQUE INDEX ...", method: "btree", columns: ["id"], unique: true, primary: true, valid: true, partial: false, constraint: "orders_pkey", bytes: "16384", scans: "9" }],
                [
                    { schema: "public", table: "orders", column: "id", kind: "view", description: "view public.open_orders", blocks: true, external: true },
                    { schema: "public", table: "orders", column: "id", kind: "sequence", description: "sequence orders_id_seq", blocks: false, external: false },
                    { schema: "public", table: "orders", column: "status", kind: "view", description: "view public.open_orders", blocks: true, external: true },
                ],
                [{ schema: "public", table: "orders", view: "public.open_orders" }],
            ]),
            ["public.orders"],
        );
        const orders = facts.tables.get("public.orders");
        expect(facts.serverVersionNum).toBe(160004);
        expect(facts.statsResetAt).toBe("2026-01-02T00:00:00.000Z");
        expect(orders).toMatchObject({ estimatedRows: 42, heapBytes: 8192, indexBytes: 16384, totalBytes: 24576, userTriggers: 1, primaryKey: ["id"], dependentViews: ["public.open_orders"] });
        expect(orders?.stats).toMatchObject({ liveTuples: 40, deadTuples: 2, seqScans: 5, indexScans: 0, lastVacuum: "2026-01-03T00:00:00.000Z" });
        expect(orders?.foreignKeys[0]).toMatchObject({ name: "orders_fk", onDelete: "CASCADE", onUpdate: "NO ACTION", validated: false });
        expect(orders?.referencedBy[0]).toMatchObject({ table: "items", columns: ["order_id"] });
        expect(orders?.indexes[0]).toMatchObject({ constraint: "orders_pkey", scans: 9, bytes: 16384 });
        expect(orders?.columns[0]).toMatchObject({ generated: "always-identity", nullFraction: 0, distinct: -1 });
        expect(orders?.columns[0].dependents).toEqual([
            { kind: "view", description: "view public.open_orders", blocks: true, external: true },
            { kind: "sequence", description: "sequence orders_id_seq", blocks: false, external: false },
        ]);
        // the view uses two columns but blocks a table drop once
        expect(orders?.dependents).toEqual([{ kind: "view", description: "view public.open_orders", blocks: true, external: true }]);
    });

    it("quotes the names it was asked about", async () => {
        const seen: string[] = [];
        await loadFacts(fakeClient([[{ num: "1", text: "x", stats_reset: null }], [], [], [], [], [], [], []], seen), ["public.o'rders", "we ird.t"]);
        expect(seen[0]).toContain("('public', 'o''rders')");
        expect(seen[0]).toContain("('we ird', 't')");
    });

    it("splits names, and only lets plain type names near the database", () => {
        expect(splitQualified("billing.invoices")).toEqual({ schema: "billing", name: "invoices" });
        expect(splitQualified("invoices")).toEqual({ name: "invoices" });
        for (const ok of ["integer", "varchar(40)", "numeric(12, 2)", "double precision", "timestamp with time zone", "int[]", "public.mood", "text[ ]"]) expect(isPlainTypeName(ok), ok).toBe(true);
        for (const bad of ["integer; drop table x", "int)", "a--b", "'x'", "(select 1)", "x".repeat(200), '"Quoted"']) expect(isPlainTypeName(bad), bad).toBe(false);
    });

    it("probes for types, casts, functions, names and defaults, and records a rejected default", async () => {
        const request: ProbeRequest = {
            types: ["varchar(10)", "bad; type"],
            typeChanges: [{ from: "integer", to: "bigint" }],
            functions: ["now", "x; y"],
            defaults: [],
            checks: [],
            relations: [{ schema: "public", name: "ix" }],
            schemas: ["public"],
        };
        const seen: string[] = [];
        const probes = await probe(
            fakeClient([[{ t0: "character varying", t1: "integer", t2: "bigint" }], [{ c0: "f" }], [{ proname: "now", volatility: "s" }], [{ r0: true, s0: true }]], seen),
            request,
        );
        expect(probes.types.get("varchar(10)")).toBe("character varying");
        expect(probes.types.has("bad; type")).toBe(true);
        expect(probes.types.get("bad; type")).toBeUndefined();
        expect([...probes.casts.values()]).toEqual(["f"]);
        expect(probes.volatility.get("now")).toBe("s");
        expect(probes.volatility.has("x; y")).toBe(false);
        expect(probes.relationExists.get("public.ix")).toBe(true);
        expect(probes.schemaExists.get("public")).toBe(true);
        expect(seen.join("\n")).not.toContain("bad; type");

        const rejecting: Queryable = {
            async query(text: string) {
                if (text.startsWith("ROLLBACK")) return [];
                throw Object.assign(new Error("column \"active\" does not exist"), { code: "42703" });
            },
        };
        const rejected = await probe(rejecting, { types: [], typeChanges: [], functions: [], defaults: [{ expression: "active", type: "text" }], checks: [], relations: [], schemas: [] });
        expect([...rejected.defaults.values()]).toEqual(['column "active" does not exist']);

        // a CHECK is planned against its table the same way, and a rejection is recorded, not thrown
        const seenChecks: string[] = [];
        const checking = {
            async query(text: string) {
                seenChecks.push(text);
                if (text.startsWith("ROLLBACK")) return [];
                throw Object.assign(new Error('column "nope" does not exist'), { code: "42703" });
            },
        };
        const checked = await probe(checking, { types: [], typeChanges: [], functions: [], defaults: [], checks: [{ table: "public.orders", expression: "nope > 0" }], relations: [], schemas: [] });
        expect([...checked.checks.values()]).toEqual(['column "nope" does not exist']);
        expect(seenChecks.join("\n")).toContain("EXPLAIN SELECT 1 FROM public.orders WHERE (nope > 0)");
    });
});

void MIB;
