import { describe, expect, it, vi } from "vitest";
import type { ValidationResponse } from "@/lib/modernizer-api";
import type { QueryModernizationRequest } from "@/lib/ai-api";
import { BatchDeps, inspectScript, runBatch } from "./batch";
import type { AiConversion } from "./types";

const accepted: ValidationResponse = { status: "accepted", statements: [{ index: 0, sql: "", status: "accepted" }], elapsedMs: 1 };
const rejected = (message: string, code?: string): ValidationResponse => ({ status: "rejected", statements: [{ index: 0, sql: "", status: "rejected", error: { message, code, position: 8 }, excerpt: "SELECT nope" }], elapsedMs: 1 });
const reply = (sql: string): { result: AiConversion; model: string } => ({ model: "test-model", result: { sql, summary: "ok", changes: ["did it"], risks: ["maybe different"], unsupported: [] } });
const deps = (overrides: Partial<BatchDeps> = {}): BatchDeps => ({ syntax: async () => ({ ok: true }), ...overrides });

const run = (script: string, overrides: Partial<BatchDeps> = {}, dialect: "oracle" | "mssql" | "mysql" = "oracle", options = {}) => runBatch({ script, dialect }, deps(overrides), options);
const only = async (sql: string, overrides: Partial<BatchDeps> = {}) => (await run(sql, overrides)).items[0];

describe("one status per statement, with the facts behind it", () => {
    it("converted and accepted by the database", async () => {
        const item = await only("SELECT NVL(a, 0) FROM t", { validate: async () => accepted });
        expect(item).toMatchObject({ status: "converted", verification: "database" });
        expect(item.reasons).toEqual(["1 rule applied, nothing left over."]);
    });

    it("converted and only checked by a grammar when no connection is chosen", async () => {
        expect(await only("SELECT NVL(a, 0) FROM t")).toMatchObject({ status: "converted", verification: "syntax" });
    });

    it("unchanged when no rule has anything to do", async () => {
        expect(await only("SELECT a FROM t WHERE b = 1", { validate: async () => accepted })).toMatchObject({ status: "unchanged", verification: "database", reasons: ["No rule had anything to change."] });
    });

    it("failed when the rules leave something unconverted, naming it", async () => {
        const item = await only("SELECT TRUNC(hired) FROM emp", { validate: async () => accepted });
        expect(item.status).toBe("failed");
        expect(item.reasons[0]).toMatch(/1 construct not converted: TRUNC/);
    });

    it("names what was not converted before what PostgreSQL said about it", async () => {
        const item = await only("SELECT TRUNC(hired) FROM emp", { validate: async () => rejected("function trunc(date) does not exist", "42883") });
        expect(item.status).toBe("failed");
        expect(item.reasons).toHaveLength(2);
        expect(item.reasons[0]).toMatch(/not converted: TRUNC/);
        expect(item.reasons[1]).toMatch(/PostgreSQL rejects the result: function trunc\(date\) does not exist/);
    });

    it("failed when PostgreSQL rejects the result, with its own message", async () => {
        const item = await only("SELECT NVL(a, 0) FROM t", { validate: async () => rejected("syntax error at or near \"x\"", "42601") });
        expect(item.status).toBe("failed");
        expect(item.reasons[0]).toMatch(/PostgreSQL rejects the result: syntax error at or near "x"/);
    });

    it("failed when the text cannot be read", async () => {
        const item = await only("SELECT 'never closed FROM t;");
        expect(item.status).toBe("failed");
    });

    it("needs review, not failure, when the only complaint is a table this connection does not have, and does not ask the model", async () => {
        const ask = vi.fn(async () => reply("SELECT 1"));
        const result = await run("SELECT NVL(a, 0) FROM emp", { validate: async () => rejected('relation "emp" does not exist', "42P01"), ask });
        expect(result.items[0]).toMatchObject({ status: "review", verification: "syntax" });
        expect(result.items[0].reasons[0]).toMatch(/could not resolve a name.*does not have the object/);
        expect(ask).not.toHaveBeenCalled();
        expect(result.summary.namesUnresolved).toBe(1);
    });

    it("needs review for a result that can differ and for bind variables", async () => {
        const order = await only("SELECT * FROM emp WHERE ROWNUM <= 10 ORDER BY salary DESC", { validate: async () => accepted });
        expect(order.status).toBe("review");
        expect(order.reasons[0]).toMatch(/Can return different results/);

        const bind = await only("SELECT * FROM emp WHERE id = :id", { validate: async () => accepted });
        expect(bind.status).toBe("review");
        expect(bind.reasons[0]).toMatch(/bind variables \(:id\).*\$1/);
    });

    it("only notes the tables the open project does not have", async () => {
        const result = await runBatch({ script: "SELECT * FROM ghosts", dialect: "oracle", schema: { tables: [{ name: "emp", columns: [{ name: "id", type: "int" }] }] } }, deps());
        expect(result.items[0].status).toBe("unchanged");
        expect(result.items[0].notes[0]).toMatch(/not in the open project: ghosts/);
    });

    it("keeps worth-checking notes next to a plain conversion without changing its status", async () => {
        const item = await only("SELECT a / b FROM t", { validate: async () => accepted });
        expect(item.status).toBe("unchanged");
        expect(item.notes.some((note) => /Worth checking/.test(note))).toBe(true);
    });

    it("needs review when the model did the converting, and says so, with its own notes labelled as its own", async () => {
        const ask = vi.fn(async () => reply("SELECT date_trunc('day', hired) FROM emp"));
        const item = await only("SELECT TRUNC(hired) FROM emp", { validate: async () => accepted, ask });
        expect(item.status).toBe("review");
        expect(item.reasons[0]).toMatch(/test-model converted it and PostgreSQL accepts the result/);
        expect(item.reasons[1]).toMatch(/model's own notes \(nothing checks them\): maybe different/);
    });
});

describe("statements that are not queries", () => {
    it("are listed and counted, never converted and never called failures", async () => {
        const script = `SET LINESIZE 200
CREATE TABLE t (a NUMBER);
CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;
/
BEGIN p; END;
/
SELECT NVL(a, 0) FROM t;`;
        const result = await run(script);
        expect(result.items.map((item) => [item.unit.keyword, item.status])).toEqual([
            ["SET", "out-of-scope"],
            ["CREATE", "out-of-scope"],
            ["CREATE", "out-of-scope"],
            ["BEGIN", "out-of-scope"],
            ["SELECT", "converted"],
        ]);
        expect(result.summary.byStatus).toMatchObject({ "out-of-scope": 4, converted: 1, failed: 0 });
        expect(result.summary.byKind).toMatchObject({ session: 1, ddl: 1, procedural: 2, query: 1 });
        expect(result.items[2].reasons.join(" ")).toMatch(/not translated/);
    });
});

describe("running a file", () => {
    it("keeps the statements in file order, with their lines", async () => {
        const result = await run("SELECT NVL(a, 0) FROM t;\n\nSELECT 2 FROM dual;\nSELECT ROWNUM FROM emp");
        expect(result.items.map((item) => [item.unit.startLine, item.status])).toEqual([[1, "converted"], [3, "converted"], [4, "failed"]]);
        expect(result.lineCount).toBe(4);
    });

    it("converts an identical statement once and points the others at the first", async () => {
        const syntax = vi.fn(async () => ({ ok: true }));
        const result = await run("SELECT NVL(a, 0) FROM t;\nSELECT NVL(b, 0) FROM t;\nSELECT NVL(a, 0) FROM t;\nSELECT NVL(a, 0) FROM t;", { syntax });
        expect(result.items.map((item) => item.repeatOf)).toEqual([undefined, undefined, 0, 0]);
        expect(syntax).toHaveBeenCalledTimes(2);
        expect(result.summary.repeated).toBe(2);
        expect(result.items[3].outcome).toBe(result.items[0].outcome);
    });

    it("asks the model about at most the limit of different statements, and says so for the rest", async () => {
        const ask = vi.fn(async (request: QueryModernizationRequest) => reply(`SELECT 1 /* ${request.legacySql.length} */`));
        const result = await run("SELECT TRUNC(a) FROM t;\nSELECT TRUNC(b) FROM t;\nSELECT TRUNC(c) FROM t;\nSELECT TRUNC(a) FROM t;", { ask }, "oracle", { maxAiStatements: 2, concurrency: 1 });
        expect(result.items.map((item) => item.status)).toEqual(["review", "review", "failed", "review"]);
        expect(result.items[2].reasons.join(" ")).toMatch(/limit of 2 statements sent to the model/);
        expect(result.aiStatementsAsked).toBe(2);
        expect(result.summary.convertedByModel).toBe(3);
    });

    it("never converts more statements at once than asked", async () => {
        let active = 0;
        let most = 0;
        const syntax = async () => {
            active++;
            most = Math.max(most, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            return { ok: true };
        };
        const script = Array.from({ length: 12 }, (_, i) => `SELECT NVL(a${i}, 0) FROM t;`).join("\n");
        const result = await run(script, { syntax }, "oracle", { concurrency: 3 });
        expect(result.items).toHaveLength(12);
        expect(most).toBeLessThanOrEqual(3);
        expect(most).toBeGreaterThan(1);
    });

    it("reports progress up to the total and stops when told to", async () => {
        const progress: number[] = [];
        const controller = new AbortController();
        const script = Array.from({ length: 10 }, (_, i) => `SELECT NVL(a${i}, 0) FROM t;`).join("\n");
        const result = await runBatch({ script, dialect: "oracle" }, deps({ syntax: async () => ({ ok: true }) }), {
            concurrency: 1,
            signal: controller.signal,
            onProgress: (done, total) => {
                progress.push(done);
                if (done === 4) controller.abort();
                expect(total).toBe(10);
            },
        });
        expect(progress).toEqual([0, 1, 2, 3, 4]);
        expect(result.aborted).toBe(true);
        expect(result.items).toHaveLength(4);
        expect(result.skipped).toBe(6);
    });

    it("turns an error inside one conversion into that statement's failure, not the end of the run", async () => {
        let calls = 0;
        const syntax = async () => {
            if (++calls === 2) throw new Error("the parser fell over");
            return { ok: true };
        };
        const result = await run("SELECT NVL(a, 0) FROM t;\nSELECT NVL(b, 0) FROM t;\nSELECT NVL(c, 0) FROM t;", { syntax }, "oracle", { concurrency: 1 });
        expect(result.items.map((item) => item.status)).toEqual(["converted", "failed", "converted"]);
        expect(result.items[1].reasons[0]).toMatch(/the parser fell over/);
    });

    it("adds up what happened: rules, left-over constructs, behaviour differences, database errors and how it was checked", async () => {
        const validate = async (sql: string) => (sql.includes("nope") ? rejected('column "nope" does not exist', "42703") : accepted);
        const script = `SELECT NVL(a, 0) FROM t;
SELECT NVL(b, 0) FROM t;
SELECT TRUNC(x) FROM t;
SELECT TRUNC(y) FROM u;
SELECT * FROM emp WHERE ROWNUM <= 5 ORDER BY id;
SELECT nope FROM t;`;
        const { summary } = await run(script, { validate });
        expect(summary.byStatus).toMatchObject({ converted: 2, failed: 2, review: 2 });
        expect(summary.rules[0]).toMatchObject({ id: "nvl", statements: 2, count: 2 });
        expect(summary.unconverted[0]).toMatchObject({ statements: 2 });
        expect(summary.unconverted[0].construct).toBe("TRUNC(…)");
        expect(summary.traps.map((trap) => trap.id)).toContain("rownum-order-by");
        // the two NVL statements and the ROWNUM one were accepted by the database; the one naming a column that is not there was only parsed
        expect(summary.verification).toEqual({ database: 3, syntax: 1, none: 0 });
    });
});

describe("inspectScript", () => {
    it("counts what a file contains without converting it", () => {
        const found = inspectScript("SET x\nCREATE TABLE t (a INT);\nSELECT 1 FROM dual;\nSELECT 2 FROM dual;", "oracle");
        expect(found.byKind).toEqual({ query: 2, ddl: 1, session: 1, procedural: 0, other: 0 });
        expect(found.units).toHaveLength(4);
    });
});
