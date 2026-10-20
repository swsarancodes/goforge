import { describe, expect, it } from "vitest";
import { findTransactionControl, isSingleReadQuery, maskSql, splitSqlStatements } from "./sql-tokens.js";

describe("maskSql", () => {
    it("keeps length and newlines while blanking comments, strings, identifiers and dollar bodies", () => {
        const sql = "SELECT 'a;b', \"x;y\" -- c;d\n, $$e;f$$ /* g;h */";
        const masked = maskSql(sql);
        expect(masked).toHaveLength(sql.length);
        expect(masked).not.toContain(";");
        expect(masked.split("\n")).toHaveLength(2);
        expect(masked.startsWith("SELECT ")).toBe(true);
    });

    it("handles doubled quotes, E-string backslash escapes and nested block comments", () => {
        expect(maskSql("SELECT 'it''s; fine'")).not.toContain(";");
        expect(maskSql("SELECT E'a\\'; b'")).not.toContain(";");
        expect(maskSql("SELECT /* a /* nested; */ still; comment */ 1")).not.toContain(";");
        expect(maskSql("SELECT 'a\\'; 1")).toContain(";"); // plain strings: a backslash is not an escape
    });

    it("handles tagged dollar quotes and leaves parameters alone", () => {
        expect(maskSql("DO $body$ BEGIN PERFORM 1; END $body$; SELECT 1")).toBe("DO " + " ".repeat("$body$ BEGIN PERFORM 1; END $body$".length) + "; SELECT 1");
        expect(maskSql("SELECT $1, $2")).toBe("SELECT $1, $2");
        expect(maskSql("SELECT a$b; SELECT 2")).toContain(";");
    });

    it("blanks an unterminated string or comment to the end instead of throwing", () => {
        expect(maskSql("SELECT 'oops; more")).toBe("SELECT " + " ".repeat("'oops; more".length));
        expect(maskSql("SELECT 1 -- trailing; no newline")).toBe("SELECT 1 " + " ".repeat("-- trailing; no newline".length));
        expect(() => maskSql("/* never closed; ")).not.toThrow();
    });
});

describe("splitSqlStatements", () => {
    it("splits on real semicolons only and reports offsets", () => {
        const sql = "SELECT 1;\n  INSERT INTO t VALUES ('a;b');\nSELECT $$x;y$$";
        const statements = splitSqlStatements(sql);
        expect(statements.map((s) => s.text)).toEqual(["SELECT 1", "INSERT INTO t VALUES ('a;b')", "SELECT $$x;y$$"]);
        for (const statement of statements) expect(sql.slice(statement.start, statement.start + statement.text.length)).toBe(statement.text);
    });

    it("drops empty statements and comment-only statements", () => {
        expect(splitSqlStatements(";;  ; -- nothing\n;").map((s) => s.text)).toEqual([]);
        expect(splitSqlStatements("SELECT 1; /* later */ ;").map((s) => s.text)).toEqual(["SELECT 1"]);
    });

    it("keeps a function body with semicolons inside dollar quotes as one statement", () => {
        const sql = "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END; $$; SELECT f()";
        expect(splitSqlStatements(sql)).toHaveLength(2);
    });
});

describe("findTransactionControl", () => {
    it.each([
        ["BEGIN", "BEGIN"],
        ["begin;", "BEGIN"],
        ["START TRANSACTION", "START TRANSACTION"],
        ["SELECT 1; COMMIT", "COMMIT"],
        ["select 1;\nrollback;", "ROLLBACK"],
        ["SAVEPOINT x", "SAVEPOINT"],
        ["release savepoint x", "RELEASE"],
        ["END", "END"],
        ["abort", "ABORT"],
        ["  /* hi */ commit", "COMMIT"],
    ])("finds %j", (sql, found) => {
        expect(findTransactionControl(sql)).toBe(found);
    });

    it.each([
        "SELECT 1",
        "SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t",
        "UPDATE t SET note = 'commit; rollback'",
        "-- commit\nSELECT 1",
        "SELECT 'BEGIN'; SELECT \"commit\" FROM t",
        "DO $$ BEGIN PERFORM 1; END $$",
        "CREATE TABLE ends (id int)",
        "SELECT * FROM beginners",
    ])("ignores %j", (sql) => {
        expect(findTransactionControl(sql)).toBeUndefined();
    });
});

describe("isSingleReadQuery", () => {
    it.each(["SELECT * FROM t", "select 1;", "  WITH x AS (SELECT 1) SELECT * FROM x", "VALUES (1), (2)", "TABLE t", "-- note\nSELECT 1 -- done"])("accepts %j", (sql) => {
        expect(isSingleReadQuery(sql)).toBe(true);
    });

    it.each([
        "SELECT 1; SELECT 2",
        "INSERT INTO t VALUES (1)",
        "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
        "SELECT * INTO copy FROM t",
        "UPDATE t SET a = 1",
        "EXPLAIN SELECT 1",
        "",
    ])("rejects %j", (sql) => {
        expect(isSingleReadQuery(sql)).toBe(false);
    });

    it("is not fooled by write keywords inside strings or comments", () => {
        expect(isSingleReadQuery("SELECT 'insert into x' AS note -- delete")).toBe(true);
    });
});
