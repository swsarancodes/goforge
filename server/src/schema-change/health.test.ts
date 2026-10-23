import { describe, expect, it } from "vitest";
import { analyzeHealth, findingsForSummary, loadHealthData, type HealthData, type HealthIndex, type HealthTable } from "./health.js";
import type { Queryable } from "../services/pg-read.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");

const table = (name: string, extra: Partial<HealthTable> = {}): HealthTable => ({
    schema: "public", name, partitioned: false, columns: 5, hasPrimaryKey: true, estimatedRows: 1000, totalBytes: 1 << 20, liveTuples: 1000, deadTuples: 0,
    modificationsSinceAnalyze: 0, lastAnalyze: "2026-05-30T00:00:00.000Z", hasStatistics: true, ...extra,
});
const index = (tableName: string, name: string, columns: (string | null)[], extra: Partial<HealthIndex> = {}): HealthIndex => ({
    schema: "public", table: tableName, name, method: "btree", columns, shape: `CREATE INDEX ON public.${tableName} USING btree (${columns.join(", ")})`, unique: false, primary: false,
    valid: true, partial: false, constraint: null, bytes: 4 << 20, scans: 10, ...extra,
});
const data = (extra: Partial<HealthData> = {}): HealthData => ({ serverVersion: "16.0", statsResetAt: "2026-03-01T00:00:00.000Z", tables: [], indexes: [], foreignKeys: [], unvalidated: [], sequences: [], ...extra });
const cats = (report: ReturnType<typeof analyzeHealth>, category: string) => report.findings.filter((f) => f.category === category);

describe("analyzeHealth", () => {
    it("reports nothing for a database with nothing wrong", () => {
        const report = analyzeHealth(
            data({
                tables: [table("a"), table("b")],
                indexes: [index("a", "a_pkey", ["id"], { primary: true, unique: true, constraint: "a_pkey" }), index("b", "b_x", ["x"], { scans: 3 })],
                foreignKeys: [{ name: "b_a_fk", schema: "public", table: "b", columns: ["x"], refSchema: "public", refTable: "a", validated: true }],
            }),
            { now: NOW },
        );
        expect(report.findings).toEqual([]);
        expect(report.categories.every((c) => c.count === 0)).toBe(true);
        expect(report.tables).toBe(2);
    });

    it("finds a foreign key's index whatever the order of its columns, and ignores partial and invalid ones", () => {
        const fk = { name: "fk", schema: "public", table: "c", columns: ["a", "b"], refSchema: "public", refTable: "p", validated: true };
        const run = (...indexes: HealthIndex[]) => cats(analyzeHealth(data({ tables: [table("c")], indexes, foreignKeys: [fk] }), { now: NOW }), "fk-without-index").length;
        expect(run(index("c", "i1", ["a", "b"]))).toBe(0);
        expect(run(index("c", "i2", ["b", "a", "z"]))).toBe(0);
        expect(run(index("c", "i3", ["a"]))).toBe(1);
        expect(run(index("c", "i4", ["a", "b"], { partial: true }))).toBe(1);
        expect(run(index("c", "i5", ["a", "b"], { valid: false }))).toBe(1);
        expect(run(index("c", "i6", ["a", "b"], { method: "hash" }))).toBe(1);
        expect(run()).toBe(1);
    });

    it("keeps the index that enforces something, or is used, and reports the rest as duplicates", () => {
        const shape = "CREATE UNIQUE INDEX ON public.t USING btree (a)";
        const report = analyzeHealth(
            data({
                tables: [table("t")],
                indexes: [
                    index("t", "t_a_key", ["a"], { shape, unique: true, constraint: "t_a_key" }),
                    index("t", "t_a_idx", ["a"], { shape, unique: true }),
                    index("t", "x1", ["x"], { scans: 0 }),
                    index("t", "x2", ["x"], { scans: 50 }),
                ],
            }),
            { now: NOW },
        );
        expect(cats(report, "duplicate-index").map((f) => f.object).sort()).toEqual(["t_a_idx", "x1"]);
        expect(cats(report, "duplicate-index").every((f) => (f.detail.sameAs as string).length > 0)).toBe(true);
        expect(cats(report, "duplicate-index").find((f) => f.object === "x1")?.detail.sameAs).toBe("x2");
    });

    it("calls an index redundant only when a longer, complete btree index starts with the same columns", () => {
        const report = analyzeHealth(
            data({
                tables: [table("t")],
                indexes: [
                    index("t", "short", ["a"]),
                    index("t", "long", ["a", "b"]),
                    index("t", "other", ["b"]),
                    index("t", "uniq", ["c"], { unique: true }),
                    index("t", "uniq_long", ["c", "d"]),
                    index("t", "part", ["e"]),
                    index("t", "part_long", ["e", "f"], { partial: true }),
                ],
            }),
            { now: NOW },
        );
        expect(cats(report, "redundant-index").map((f) => f.object)).toEqual(["short"]);
    });

    it("lists unused indexes only when large enough, never scanned, and not enforcing anything; and says how old the statistics are", () => {
        const report = analyzeHealth(
            data({
                tables: [table("t")],
                indexes: [
                    index("t", "big_unused", ["a"], { scans: 0, bytes: 50 << 20 }),
                    index("t", "tiny_unused", ["b"], { scans: 0, bytes: 8192 }),
                    index("t", "used", ["c"], { scans: 1, bytes: 50 << 20 }),
                    index("t", "unique_unused", ["d"], { scans: 0, bytes: 50 << 20, unique: true }),
                    index("t", "unknown", ["e"], { scans: null, bytes: 50 << 20 }),
                ],
            }),
            { now: NOW },
        );
        const unused = cats(report, "unused-index");
        expect(unused.map((f) => f.object)).toEqual(["big_unused"]);
        expect(unused[0].summary).toMatch(/92 days ago/);
        expect(report.limits[0]).toMatch(/read replica/);
    });

    it("reports invalid indexes, unvalidated constraints and wide tables", () => {
        const report = analyzeHealth(
            data({
                tables: [table("wide", { columns: 80 }), table("narrow", { columns: 49 })],
                indexes: [index("wide", "broken", ["a"], { valid: false })],
                unvalidated: [{ name: "c1", schema: "public", table: "wide", kind: "check" }],
            }),
            { now: NOW },
        );
        expect(cats(report, "invalid-index").map((f) => f.object)).toEqual(["broken"]);
        expect(cats(report, "unvalidated-constraint")[0].summary).toMatch(/Check c1/);
        expect(cats(report, "wide-table").map((f) => f.table)).toEqual(["public.wide"]);
    });

    it("tells never-analyzed, stale and bloated tables apart from healthy ones", () => {
        const report = analyzeHealth(
            data({
                tables: [
                    table("never", { estimatedRows: null, liveTuples: 500, lastAnalyze: null }),
                    table("stale", { liveTuples: 10_000, modificationsSinceAnalyze: 9_000 }),
                    table("fresh", { liveTuples: 10_000, modificationsSinceAnalyze: 100 }),
                    table("small_churn", { liveTuples: 100, modificationsSinceAnalyze: 90 }),
                    table("bloated", { liveTuples: 100_000, deadTuples: 30_000 }),
                    table("some_dead", { liveTuples: 100_000, deadTuples: 5_000 }),
                ],
            }),
            { now: NOW },
        );
        expect(cats(report, "stale-statistics").map((f) => f.table).sort()).toEqual(["public.never", "public.stale"]);
        expect(cats(report, "dead-rows").map((f) => f.table)).toEqual(["public.bloated"]);
    });

    it("lists a table without a key and says when a unique index could stand in", () => {
        const report = analyzeHealth(data({ tables: [table("t", { hasPrimaryKey: false })], indexes: [index("t", "t_u", ["a"], { unique: true, constraint: "t_u" })] }), { now: NOW });
        expect(cats(report, "no-primary-key")[0].detail.uniqueIndexInstead).toBe("t_u");
    });

    it("reports sequences past half their range with the column that uses them", () => {
        const report = analyzeHealth(
            data({
                sequences: [
                    { schema: "public", name: "orders_id_seq", type: "integer", lastValue: 1_700_000_000, maxValue: 2_147_483_647, owner: "public.orders.id" },
                    { schema: "public", name: "calm_seq", type: "bigint", lastValue: 5, maxValue: 9_223_372_036_854_775_807, owner: null },
                ],
            }),
            { now: NOW },
        );
        expect(cats(report, "sequence-near-limit").map((f) => [f.object, f.table])).toEqual([["public.orders_id_seq", "public.orders"]]);
        expect(cats(report, "sequence-near-limit")[0].summary).toMatch(/79%/);
    });

    it("keeps at most perCategory findings per category but counts them all", () => {
        const many = Array.from({ length: 30 }, (_, i) => table(`t${i}`, { hasPrimaryKey: false, totalBytes: i }));
        const report = analyzeHealth(data({ tables: many }), { now: NOW, thresholds: { perCategory: 5 } });
        const category = report.categories.find((c) => c.category === "no-primary-key");
        expect(category).toMatchObject({ count: 30, shown: 5 });
        expect(cats(report, "no-primary-key").map((f) => f.table)).toEqual(["public.t29", "public.t28", "public.t27", "public.t26", "public.t25"]);
    });

    it("gives the same ids every time, and a model's input has no free text and at most a few of each kind", () => {
        const many = Array.from({ length: 30 }, (_, i) => table(`t${i}`, { hasPrimaryKey: false, columns: 70 }));
        const first = analyzeHealth(data({ tables: many }), { now: NOW });
        const second = analyzeHealth(data({ tables: many }), { now: NOW });
        expect(first.findings.map((f) => f.id)).toEqual(second.findings.map((f) => f.id));
        const input = findingsForSummary(first, 3);
        expect(input).toHaveLength(6);
        expect(Object.keys(input[0]).sort()).toEqual(["bytes", "category", "detail", "id", "object", "table"]);
    });

    it("reads the database in one read-only round trip", async () => {
        const seen: string[] = [];
        const client: Queryable = {
            async query(text: string) {
                seen.push(text);
                return [{ rows: [] }, { rows: [] }, { rows: [{ version: "16.0", stats_reset: null }] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }];
            },
        };
        const loaded = await loadHealthData(client);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatch(/^BEGIN READ ONLY/);
        expect(seen[0]).toMatch(/ROLLBACK$/);
        expect(loaded).toMatchObject({ serverVersion: "16.0", statsResetAt: null, tables: [] });
    });
});
