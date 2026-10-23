import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RISK_CATEGORIES, databaseFor, databasesFor, evaluateCandidate, loadCase, parseCaseDefinition, runKnownCandidates, type LoadedCase } from "./case";
import type { Database } from "./database";

// Each of these starts PostgreSQL workers (a few hundred ms to a second or two each, more when the whole suite runs in parallel).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = resolve(import.meta.dirname, "../cases");
const dirs = readdirSync(root).map((name) => resolve(root, name)).filter((path) => statSync(path).isDirectory()).sort();
const cases = dirs.map(loadCase);

describe("the case set meets the challenge", () => {
    it("has at least three cases", () => expect(cases.length).toBeGreaterThanOrEqual(3));
    it("gives every case held-out data and a reference result for it", () => {
        for (const c of cases) expect(c.heldOut?.expected.rows.length, c.definition.id).toBeGreaterThan(0);
    });
    it("covers every required risk category", () => {
        const covered = new Set(cases.flatMap((c) => c.definition.risks));
        for (const risk of RISK_CATEGORIES) expect(covered, risk).toContain(risk);
    });
    it("gives every case one correct translation and at least one known-wrong one that still executes", () => {
        for (const c of cases) {
            expect(c.definition.candidates.filter((x) => x.expect === "pass"), c.definition.id).toHaveLength(1);
            expect(c.definition.candidates.filter((x) => x.expect === "fail").length, c.definition.id).toBeGreaterThanOrEqual(1);
        }
    });
});

describe.each(cases)("$definition.id: $definition.title", (loaded: LoadedCase) => {
    let dbs: Awaited<ReturnType<typeof databasesFor>>;
    beforeAll(async () => {
        dbs = await databasesFor(loaded);
    });
    afterAll(async () => {
        await dbs.close();
    });

    it("judges every known candidate as the case says: the correct one passes, the wrong ones do not", async () => {
        const runs = await runKnownCandidates(dbs, loaded);
        for (const run of runs) expect(run.asExpected, `${run.file}: ${run.report.verdict}: ${run.report.summary}`).toBe(true);
    });

    it("lets the known-wrong translations execute: they are silent failures, not syntax errors", async () => {
        const runs = await runKnownCandidates(dbs, loaded);
        for (const run of runs.filter((r) => r.expect === "fail" && r.catchBy === "primary")) expect(["fail"], `${run.file}: ${run.report.summary}`).toContain(run.report.verdict);
    });

    it("never changes the data it reads", async () => {
        const before = (await dbs.primary.query("SELECT (SELECT count(*) FROM customers) AS c, (SELECT count(*) FROM policies) AS p, (SELECT count(*) FROM claims) AS k")).rows;
        await runKnownCandidates(dbs, loaded);
        const after = (await dbs.primary.query("SELECT (SELECT count(*) FROM customers) AS c, (SELECT count(*) FROM policies) AS p, (SELECT count(*) FROM claims) AS k")).rows;
        expect(after).toEqual(before);
    });

    it("has held-out data whose ids never overlap the primary data's", async () => {
        expect(dbs.heldOut, "held-out data").toBeDefined();
        for (const [table, column] of [["customers", "customer_id"], ["policies", "policy_id"], ["claims", "claim_id"]]) {
            const ids = async (db: Database) => new Set((await db.query<Record<string, string>>(`SELECT ${column} AS id FROM ${table}`)).rows.map((row) => row.id));
            const primary = await ids(dbs.primary);
            const heldOut = await ids(dbs.heldOut!);
            expect([...heldOut].filter((id) => primary.has(id)), `${table} ids shared`).toEqual([]);
            expect(heldOut.size, table).toBeGreaterThan(0);
        }
    });

    it("declares which static findings every candidate draws, and the correct translation draws none", async () => {
        for (const run of await runKnownCandidates(dbs, loaded)) {
            const declared = loaded.definition.candidates.find((candidate) => candidate.file === run.file)!.flags;
            expect(declared, `${run.file} declares its flags`).toBeDefined();
            expect([...new Set(run.findings.map((finding) => finding.id))].sort(), run.file).toEqual([...declared!].sort());
            if (run.expect === "pass") expect(run.findings, run.file).toEqual([]);
        }
    });

    it("accepts the correct translation on both datasets", async () => {
        const [correct] = (await runKnownCandidates(dbs, loaded)).filter((run) => run.expect === "pass");
        expect(correct.report.verdict).toBe("pass");
        expect(correct.heldOut?.verdict).toBe("pass");
    });

    it("catches every known-wrong translation on the held-out data too, except the ones that exist to show the held-out data is needed", async () => {
        for (const run of await runKnownCandidates(dbs, loaded)) {
            if (run.expect === "pass") continue;
            expect(run.heldOut?.verdict, `${run.file} on held-out data`).not.toBe("pass");
        }
    });

    it("has a candidate that passes the primary data and is stopped only by the held-out data", async () => {
        const overfit = (await runKnownCandidates(dbs, loaded)).filter((run) => run.catchBy === "heldout");
        expect(overfit.length).toBeGreaterThanOrEqual(1);
        for (const run of overfit) {
            expect(run.report.verdict, `${run.file} on primary data`).toBe("pass");
            expect(run.heldOut?.verdict, `${run.file} on held-out data`).toBe("fail");
        }
    });

    it("never changes the held-out data either", async () => {
        const count = async () => (await dbs.heldOut!.query("SELECT (SELECT count(*) FROM customers) AS c, (SELECT count(*) FROM policies) AS p, (SELECT count(*) FROM claims) AS k")).rows;
        const before = await count();
        await runKnownCandidates(dbs, loaded);
        expect(await count()).toEqual(before);
    });
});

describe("evaluateCandidate", () => {
    const loaded = cases[0];
    let db: Database;
    beforeAll(async () => {
        db = await databaseFor(loaded);
    });
    afterAll(async () => {
        await db.close();
    });

    it("refuses a statement that writes, and the data is untouched", async () => {
        const report = await evaluateCandidate(db, loaded, "DELETE FROM customers");
        expect(report.verdict).toBe("refused");
        expect((await db.query<{ n: string }>("SELECT count(*) AS n FROM customers")).rows[0].n).toBe("7");
    });

    it("reports PostgreSQL's own rejection as an error, not as a mismatch", async () => {
        const report = await evaluateCandidate(db, loaded, "SELECT no_such_column FROM customers");
        expect(report.verdict).toBe("error");
        expect(report.summary).toMatch(/no_such_column/);
    });

    it("reports a wrong column set as a column problem", async () => {
        const report = await evaluateCandidate(db, loaded, "SELECT customer_id FROM customers");
        expect(report.verdict).toBe("fail");
        expect(report.comparison?.columnProblem).toBeDefined();
    });

    it("stays usable after a failed statement (the transaction is rolled back)", async () => {
        await evaluateCandidate(db, loaded, "SELECT 1/0");
        const good = readFileSync(resolve(loaded.dir, "candidates/correct.sql"), "utf8");
        expect((await evaluateCandidate(db, loaded, good)).verdict).toBe("pass");
    });
});

describe("parseCaseDefinition", () => {
    const valid = JSON.parse(readFileSync(resolve(dirs[0], "case.json"), "utf8"));
    it("accepts the shipped cases", () => expect(() => parseCaseDefinition(valid)).not.toThrow());
    it("names the problem in a half-defined case", () => {
        expect(() => parseCaseDefinition({ ...valid, risks: ["whatever"] })).toThrow(/risks/);
        expect(() => parseCaseDefinition({ ...valid, difficulty: "impossible" })).toThrow(/difficulty/);
        expect(() => parseCaseDefinition({ ...valid, legacyQuery: undefined })).toThrow(/legacyQuery/);
        expect(() => parseCaseDefinition({ ...valid, invariants: [{ name: "x", kind: "nope", sql: "select 1" }] })).toThrow(/invariants\[0\]/);
        expect(() => parseCaseDefinition({ ...valid, heldOutExpected: undefined })).toThrow(/held-out data but the case has no heldOutExpected/);
        expect(() => parseCaseDefinition({ ...valid, candidates: [{ file: "a.sql", expect: "fail", catchBy: "sometime", why: "x" }] })).toThrow(/catchBy/);
    });
});
