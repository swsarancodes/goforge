import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CandidateRefused, CandidateTimeout, createDatabase, describeSchema, executeCandidate, scalar, type Database } from "./database";

// Each of these starts PostgreSQL workers (a few hundred ms to a second or two each, more when the whole suite runs in parallel).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const RUNAWAY = "SELECT count(*) FROM generate_series(1, 5000000000)";

let db: Database;
beforeAll(async () => {
    db = await createDatabase("CREATE TABLE t (a integer NOT NULL, b text)", "INSERT INTO t VALUES (1, 'x'), (2, NULL)");
});
afterAll(async () => {
    await db.close();
});

describe("the wall-clock limit", () => {
    it("stops a runaway query, quickly, and says so", async () => {
        const started = Date.now();
        await expect(executeCandidate(db, RUNAWAY, { timeoutMs: 400 })).rejects.toBeInstanceOf(CandidateTimeout);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(db.restarts).toBe(1);
    });

    it("carries on with a fresh worker that has the same data, and anything set up through exec", async () => {
        await db.exec("CREATE VIEW v AS SELECT a FROM t WHERE a > 1");
        await expect(executeCandidate(db, RUNAWAY, { timeoutMs: 300 })).rejects.toBeInstanceOf(CandidateTimeout);
        const table = await executeCandidate(db, "SELECT a, b FROM t ORDER BY a");
        expect(table.rows).toEqual([["1", "x"], ["2", null]]);
        expect((await executeCandidate(db, "SELECT a FROM v")).rows).toEqual([["2"]]);
        expect(db.restarts).toBe(2);
    });

    it("does not let a candidate that finishes in time be stopped", async () => {
        const before = db.restarts;
        await executeCandidate(db, "SELECT count(*) FROM generate_series(1, 200000)", { timeoutMs: 8_000 });
        expect(db.restarts).toBe(before);
    });

    it("applies to the author's own invariant queries too", async () => {
        await expect(scalar(db, RUNAWAY, { timeoutMs: 300 })).rejects.toBeInstanceOf(CandidateTimeout);
    });
});

describe("read-only execution", () => {
    it("refuses to write even when the guard is bypassed, and leaves nothing behind", async () => {
        await expect(db.readOnly("CREATE TABLE should_not_exist (a integer)")).rejects.toThrow(/read-only transaction/);
        await expect(db.readOnly("INSERT INTO t VALUES (3, 'y')")).rejects.toThrow(/read-only transaction/);
        expect((await db.query<{ n: string }>("SELECT count(*) AS n FROM t")).rows[0].n).toBe("2");
        const tables = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
        expect(tables.rows.map((row) => row.table_name)).not.toContain("should_not_exist");
    });

    it("recovers after a failed statement: the next query runs outside the aborted transaction", async () => {
        await expect(executeCandidate(db, "SELECT 1/0")).rejects.toThrow(/division by zero/);
        expect((await executeCandidate(db, "SELECT 1")).rows).toEqual([["1"]]);
    });

    it("is refused by the guard before it reaches the database", async () => {
        await expect(executeCandidate(db, "DELETE FROM t")).rejects.toBeInstanceOf(CandidateRefused);
    });

    it("cuts the result at the row limit and says so", async () => {
        const table = await executeCandidate(db, "SELECT g FROM generate_series(1, 50) g", { maxRows: 10 });
        expect(table.rows).toHaveLength(10);
        expect(table.truncated).toBe(true);
    });

    it("reports column types and nullability", async () => {
        const table = await executeCandidate(db, "SELECT a, b FROM t");
        expect(table.columns.map((column) => [column.name, column.category])).toEqual([["a", "number"], ["b", "text"]]);
        expect(await describeSchema(db)).toContainEqual({ name: "t", columns: [{ name: "a", type: "integer", nullable: false }, { name: "b", type: "text", nullable: true }] });
    });
});
