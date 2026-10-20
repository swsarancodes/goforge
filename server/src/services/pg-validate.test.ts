import { describe, expect, it } from "vitest";
import { PREVIEW_ROWS, excerptAround, isSqlError, previewQuery, validateSql } from "./pg-validate.js";
import type { Queryable } from "./pg-read.js";

type Handler = (text: string) => unknown;

/** Runs the work on a fake client whose answers come from `handler`. */
const runner = (handler: Handler, seen: string[] = []) => async <T>(fn: (client: Queryable) => Promise<T>): Promise<T> =>
    fn({
        async query(config: string | { text: string }) {
            const text = typeof config === "string" ? config : config.text;
            seen.push(text);
            return handler(text);
        },
    });

const sqlError = (message: string, code: string, position?: string) => Object.assign(new Error(message), { code, position });

describe("validateSql", () => {
    it("asks for the plan of each statement inside one read-only transaction, never running it", async () => {
        const seen: string[] = [];
        const result = await validateSql("SELECT 1; UPDATE t SET a = 1", runner(() => [{}, {}, {}, {}], seen));
        expect(result.status).toBe("accepted");
        expect(result.statements.map((s) => s.status)).toEqual(["accepted", "accepted"]);
        expect(seen).toEqual([
            "BEGIN READ ONLY; SET LOCAL statement_timeout = 15000; EXPLAIN SELECT 1; ROLLBACK",
            "BEGIN READ ONLY; SET LOCAL statement_timeout = 15000; EXPLAIN UPDATE t SET a = 1; ROLLBACK",
        ]);
    });

    it("reports PostgreSQL's own error with the position inside the statement", async () => {
        const prefix = "BEGIN READ ONLY; SET LOCAL statement_timeout = 15000; EXPLAIN ".length;
        const result = await validateSql(
            "SELECT nope FROM t",
            runner(() => {
                throw sqlError('column "nope" does not exist', "42703", String(prefix + 8));
            }),
        );
        expect(result.status).toBe("rejected");
        expect(result.statements[0].error).toMatchObject({ message: 'column "nope" does not exist', code: "42703", position: 8 });
        expect(result.statements[0].excerpt).toBe("SELECT nope FROM t");
    });

    it("keeps checking the other statements after one is rejected", async () => {
        let calls = 0;
        const result = await validateSql(
            "SELECT bad; SELECT 1",
            runner(() => {
                calls++;
                if (calls === 1) throw sqlError("syntax error", "42601");
                return [{}];
            }),
        );
        expect(result.statements.map((s) => s.status)).toEqual(["rejected", "accepted"]);
        expect(result.status).toBe("rejected");
    });

    it("skips statements EXPLAIN can't take, and says so", async () => {
        const result = await validateSql("CREATE TABLE x (id int); -- note\nSELECT 1", runner(() => [{}]));
        expect(result.statements.map((s) => s.status)).toEqual(["skipped", "accepted"]);
        expect(result.statements[0].reason).toMatch(/without running/);
        expect((await validateSql("CREATE INDEX i ON t (a)", runner(() => [{}]))).status).toBe("skipped");
    });

    it("looks past leading comments to the statement keyword", async () => {
        const result = await validateSql("-- convert me\n/* x */ SELECT 1", runner(() => [{}]));
        expect(result.statements[0].status).toBe("accepted");
    });

    it("does not call a lost connection a rejected query", async () => {
        await expect(
            validateSql(
                "SELECT 1",
                runner(() => {
                    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
                }),
            ),
        ).rejects.toThrow(/ECONNREFUSED/);
        expect(isSqlError(Object.assign(new Error("x"), { code: "57P01" }))).toBe(false);
        expect(isSqlError(Object.assign(new Error("x"), { code: "42P01" }))).toBe(true);
        expect(isSqlError(new Error("x"))).toBe(false);
    });

    it("limits how many statements it checks", async () => {
        const many = Array.from({ length: 80 }, () => "SELECT 1").join(";");
        expect((await validateSql(many, runner(() => [{}]))).statements).toHaveLength(50);
    });
});

describe("excerptAround", () => {
    it("shows the words around a position on one line, with ellipses where it was cut", () => {
        const text = "SELECT a,\n       b,\n       nope_column,\n       d FROM some_very_long_table_name WHERE x = 1";
        const excerpt = excerptAround(text, text.indexOf("nope_column") + 1);
        expect(excerpt.startsWith("…")).toBe(true);
        expect(excerpt.endsWith("…")).toBe(true);
        expect(excerpt).toContain("nope_column");
        expect(excerpt).not.toContain("\n");
        expect(excerptAround("SELECT 1", 1)).toBe("SELECT 1");
    });
});

describe("previewQuery", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => [String(i)]);
    const batch = (fetched: unknown) => [{ command: "BEGIN" }, { command: "SET" }, { command: "DECLARE" }, fetched, { command: "CLOSE" }, { command: "ROLLBACK" }];

    it("reads through a cursor in a read-only transaction and returns the first rows", async () => {
        const seen: string[] = [];
        const result = await previewQuery("SELECT id FROM t", runner(() => batch({ command: "FETCH", rowCount: 2, fields: [{ name: "id", dataTypeID: 23 }], rows: rows(2) }), seen));
        expect(seen[0]).toBe("BEGIN READ ONLY; SET LOCAL statement_timeout = 15000; DECLARE goforge_preview NO SCROLL CURSOR FOR SELECT id FROM t\n; FETCH FORWARD 101 FROM goforge_preview; CLOSE goforge_preview; ROLLBACK");
        expect(result).toMatchObject({ ok: true, result: { columns: [{ name: "id", dataType: "integer" }], rows: [["0"], ["1"]], truncated: false } });
    });

    it("cuts to 100 rows and says there were more", async () => {
        const result = await previewQuery("SELECT 1", runner(() => batch({ command: "FETCH", rowCount: 101, fields: [{ name: "n", dataTypeID: 25 }], rows: rows(PREVIEW_ROWS + 1) })));
        expect(result.ok && result.result.rows).toHaveLength(PREVIEW_ROWS);
        expect(result.ok && result.result.truncated).toBe(true);
    });

    it("looks up the names of types it doesn't know", async () => {
        const seen: string[] = [];
        const result = await previewQuery(
            "SELECT mood FROM t",
            runner((text) => (text.includes("pg_type") ? { rows: [[99999, "mood"]] } : batch({ command: "FETCH", rowCount: 0, fields: [{ name: "mood", dataTypeID: 99999 }], rows: [] })), seen),
        );
        expect(result.ok && result.result.columns[0].dataType).toBe("mood");
    });

    it("returns the database's error with a position inside the user's SQL", async () => {
        const head = "BEGIN READ ONLY; SET LOCAL statement_timeout = 15000; DECLARE goforge_preview NO SCROLL CURSOR FOR ".length;
        const result = await previewQuery(
            "SELECT nope",
            runner(() => {
                throw sqlError('column "nope" does not exist', "42703", String(head + 8));
            }),
        );
        expect(result).toMatchObject({ ok: false, error: { code: "42703", position: 8 } });
    });
});
