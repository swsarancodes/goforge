import { describe, expect, it } from "vitest";
import type { ValidationResponse } from "@/lib/modernizer-api";
import { runBatch } from "./batch";
import { CSV_COLUMNS, convertedScript, readinessMarkdown, resultsCsv } from "./batch-report";

const accepted: ValidationResponse = { status: "accepted", statements: [{ index: 0, sql: "", status: "accepted" }], elapsedMs: 1 };
const SCRIPT = `-- nightly job
SELECT NVL(bonus, 0) FROM emp;
SELECT name FROM emp WHERE id = 1;
SELECT * FROM emp WHERE ROWNUM <= 10 ORDER BY salary DESC;
SELECT TRUNC(hired) FROM emp;
CREATE TABLE t (a NUMBER);
CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;
/
SET LINESIZE 80`;

const build = () => runBatch({ script: SCRIPT, dialect: "oracle" }, { syntax: async () => ({ ok: true }), validate: async () => accepted, connectionName: "staging" });

describe("the converted file", () => {
    it("has the converted SQL for what converted and every other statement as a comment with its reason", async () => {
        const text = convertedScript(await build());
        expect(text).toMatch(/^-- Oracle script converted to PostgreSQL by GoForge\./);
        expect(text).toContain("-- nightly job");
        expect(text).toContain("-- line 2: CONVERTED\nSELECT COALESCE(bonus, 0) FROM emp;");
        expect(text).toContain("-- line 3: ALREADY POSTGRESQL\nSELECT name FROM emp WHERE id = 1;");
        expect(text).toMatch(/-- line 4: NEEDS REVIEW - Can return different results/);
        expect(text).toContain("SELECT * FROM emp ORDER BY salary DESC LIMIT 10;");
        expect(text).toContain("-- line 5: NOT CONVERTED\n--   1 construct not converted: TRUNC");
        expect(text).toContain("-- SELECT TRUNC(hired) FROM emp");
        expect(text).toContain("-- line 6: NOT A QUERY");
        expect(text).toContain("-- CREATE TABLE t (a NUMBER)");
        expect(text).toContain("-- BEGIN NULL; END;".replace("BEGIN", "CREATE OR REPLACE PROCEDURE p AS BEGIN"));
        // nothing that failed or is not a query is left as runnable SQL
        const runnable = text.split("\n").filter((line) => line && !line.startsWith("--"));
        expect(runnable).toEqual(["SELECT COALESCE(bonus, 0) FROM emp;", "SELECT name FROM emp WHERE id = 1;", "SELECT * FROM emp ORDER BY salary DESC LIMIT 10;"]);
    });

    it("can keep the statements that need review out of the runnable SQL", async () => {
        const text = convertedScript(await build(), { reviewAsSql: false });
        const runnable = text.split("\n").filter((line) => line && !line.startsWith("--"));
        expect(runnable).toEqual(["SELECT COALESCE(bonus, 0) FROM emp;", "SELECT name FROM emp WHERE id = 1;"]);
        expect(text).toContain("NEEDS REVIEW (kept as a comment)");
    });
});

describe("the report", () => {
    it("counts the statements by status and says how they were checked", async () => {
        const md = readinessMarkdown(await build(), { fileName: "nightly.sql", generatedAt: "2026-10-20 12:00" });
        expect(md).toMatch(/^# Migration report: nightly\.sql \(Oracle to PostgreSQL\)/);
        expect(md).toContain("7 statements in 9 lines; 4 queries and 3 statements that are not queries.");
        expect(md).toContain("| Converted | 1 | The rules finished and the result was accepted. |");
        expect(md).toContain("| Already PostgreSQL | 1 |");
        expect(md).toContain("| Needs review | 1 |");
        expect(md).toContain("| Failed | 1 |");
        expect(md).toContain("| Out of scope | 3 |");
        expect(md).toContain('PostgreSQL itself, through the connection "staging"');
        expect(md).toContain("3 of the 3 queries that were not failures were accepted by the database");
    });

    it("lists what blocks, what needs a person and what is out of scope, and says what the statuses do not mean", async () => {
        const md = readinessMarkdown(await build(), { generatedAt: "now" });
        expect(md).toContain("| `TRUNC(…)` | 1 |");
        expect(md).toMatch(/\| Lines \| Status \| Why \|[\s\S]*\| 4 \| Needs review \|/);
        expect(md).toMatch(/\| session: SET \| 1 \|/);
        expect(md).toMatch(/\| ddl: CREATE \| 1 \|/);
        expect(md).toMatch(/\| procedural: CREATE \| 1 \|/);
        expect(md).toContain("does not mean the new statement returns the same rows");
        expect(md).not.toMatch(/\d+%/);
        expect(md).toContain("# Migration report: pasted script");
    });

    it("says so when the run was stopped, and when the connection has no grammar-only checks", async () => {
        const result = await build();
        const stopped = readinessMarkdown({ ...result, aborted: true, skipped: 3 }, { generatedAt: "now" });
        expect(stopped).toContain("The run was stopped early: 3 statements were not converted");
        const noConnection = readinessMarkdown({ ...result, connectionName: undefined }, { generatedAt: "now" });
        expect(noConnection).toContain("a PostgreSQL grammar only (no database connection was chosen)");
    });
});

describe("the spreadsheet", () => {
    it("has a header, one row per statement, quoting where needed", async () => {
        const csv = resultsCsv(await build());
        const lines = csv.split("\r\n");
        expect(lines[0]).toBe(CSV_COLUMNS.join(","));
        expect(lines.filter(Boolean)).toHaveLength(1 + 7);
        expect(lines[1]).toContain("converted,database");
        expect(lines[1]).toContain("SELECT COALESCE(bonus, 0) FROM emp");
        expect(csv).toContain("out-of-scope,,");
    });

    it("keeps a formula-looking cell from being run by a spreadsheet, and quotes quotes and newlines", async () => {
        const result = await runBatch({ script: "SELECT 'a\"b' FROM dual;\nSELECT TRUNC(hired) FROM emp WHERE note = '=cmd()'", dialect: "oracle" }, { syntax: async () => ({ ok: true }) });
        const csv = resultsCsv(result);
        expect(csv).toContain(`"SELECT 'a""b'`);
        const converted = convertedScript(result);
        expect(converted).toContain("-- SELECT TRUNC(hired)");
        // the converted SQL of a failed statement is not exported; a converted one starting with a dash would be guarded
        const risky = { ...result, items: result.items.map((item) => ({ ...item, outcome: item.outcome && { ...item.outcome, sql: "-1 + 1" } })) };
        expect(resultsCsv(risky)).toContain(",'-1 + 1");
    });
});
