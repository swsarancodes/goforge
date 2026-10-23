import { describe, expect, it } from "vitest";
import type { LegacyDialect } from "../types";
import { classify, splitScript } from "./script";

const split = (text: string, dialect: LegacyDialect = "oracle") => splitScript(text, dialect);
const shape = (text: string, dialect: LegacyDialect = "oracle") => split(text, dialect).units.map((unit) => [unit.kind, unit.text]);

describe("splitScript: statements", () => {
    it("splits on ; and ignores ; inside strings, quoted names and comments", () => {
        const script = `SELECT 'a;b' FROM t; -- not; a split
SELECT "x;y" FROM u; /* nor; this */ SELECT 3 FROM v`;
        expect(shape(script)).toEqual([
            ["query", "SELECT 'a;b' FROM t"],
            ["query", 'SELECT "x;y" FROM u'],
            ["query", "SELECT 3 FROM v"],
        ]);
    });

    it("numbers lines from 1, keeps the comments before a statement with it, and drops comment-only chunks", () => {
        const { units } = split(`-- header\n\nSELECT 1 FROM dual;\n\n/* about the next */\nSELECT 2\nFROM dual;\n-- the end\n`);
        expect(units.map((u) => [u.startLine, u.endLine])).toEqual([[3, 3], [6, 7]]);
        expect(units[0].comments).toContain("-- header");
        expect(units[1].comments).toContain("about the next");
        expect(units).toHaveLength(2);
    });

    it("reads Windows line endings and a byte-order mark", () => {
        const { units } = split("﻿SELECT 1;\r\nSELECT 2;\r\n");
        expect(units.map((u) => u.text)).toEqual(["SELECT 1", "SELECT 2"]);
        expect(units[1].startLine).toBe(2);
    });

    it("handles empty input, comments only, and a last statement without a terminator", () => {
        expect(split("").units).toEqual([]);
        expect(split("-- nothing\n/* here */").units).toEqual([]);
        expect(shape("SELECT 1; SELECT 2")).toEqual([["query", "SELECT 1"], ["query", "SELECT 2"]]);
    });

    it("never splits inside a bracketed name in T-SQL or a backtick name in MySQL", () => {
        expect(shape("SELECT [a;b] FROM t; SELECT 2", "mssql")).toEqual([["query", "SELECT [a;b] FROM t"], ["query", "SELECT 2"]]);
        expect(shape("SELECT `a;b` FROM t; SELECT 2", "mysql")).toEqual([["query", "SELECT `a;b` FROM t"], ["query", "SELECT 2"]]);
    });

    it("reads MySQL escapes and comments", () => {
        expect(shape("SELECT 'it\\'s; fine' FROM t; # a comment; with a semicolon\nSELECT 2 -- x\n; SELECT 3", "mysql")).toEqual([
            ["query", "SELECT 'it\\'s; fine' FROM t"],
            ["query", "SELECT 2 -- x"],
            ["query", "SELECT 3"],
        ]);
        // "--" without a space is not a comment in MySQL
        expect(shape("SELECT 5--3; SELECT 2", "mysql")[0]).toEqual(["query", "SELECT 5--3"]);
    });

    it("reads Oracle q-quoted strings", () => {
        expect(shape("SELECT q'[it's; here]' FROM dual; SELECT q'!a;b!' FROM dual")).toEqual([["query", "SELECT q'[it's; here]' FROM dual"], ["query", "SELECT q'!a;b!' FROM dual"]]);
    });

    it("says so when a quote or a comment is never closed", () => {
        const quote = split("SELECT 1;\nSELECT 'oops;\nSELECT 3;");
        expect(quote.warnings[0]).toMatch(/quote that starts on line 2/);
        expect(quote.units).toHaveLength(2);
        const comment = split("SELECT 1; /* never closed\nSELECT 2;");
        expect(comment.warnings[0]).toMatch(/comment that starts on line 1/);
        expect(comment.units).toHaveLength(1);
    });
});

describe("splitScript: Oracle", () => {
    it("ends a statement at a lone / line, with or without a ;", () => {
        expect(shape("SELECT 1 FROM dual\n/\nSELECT 2 FROM dual;\n/\n")).toEqual([["query", "SELECT 1 FROM dual"], ["query", "SELECT 2 FROM dual"]]);
    });

    it("keeps a procedure, a package and an anonymous block whole and labels them procedural", () => {
        const script = `CREATE OR REPLACE PROCEDURE p AS
BEGIN
  UPDATE t SET a = 1;
  COMMIT;
END;
/
CREATE OR REPLACE PACKAGE BODY pkg AS
  FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END;
END pkg;
/
DECLARE
  x NUMBER;
BEGIN
  SELECT 1 INTO x FROM dual;
END;
/
SELECT 1 FROM dual;`;
        const { units, warnings } = split(script);
        expect(units.map((u) => [u.kind, u.keyword, u.startLine, u.endLine])).toEqual([
            ["procedural", "CREATE", 1, 5],
            ["procedural", "CREATE", 7, 9],
            ["procedural", "DECLARE", 11, 15],
            ["query", "SELECT", 17, 17],
        ]);
        expect(units[0].text).toContain("COMMIT;");
        expect(warnings).toEqual([]);
    });

    it("ends a BEGIN block at its own END;, however many ; are inside", () => {
        expect(shape("BEGIN\n  IF a THEN b; END IF;\n  CASE WHEN x THEN y END;\nEND;\nSELECT 1 FROM dual;")).toEqual([
            ["procedural", "BEGIN\n  IF a THEN b; END IF;\n  CASE WHEN x THEN y END;\nEND"],
            ["query", "SELECT 1 FROM dual"],
        ]);
    });

    it("treats SQL*Plus lines as session commands and does not let them swallow the next statement", () => {
        const { units } = split("SET LINESIZE 200\nSPOOL out.txt\nPROMPT hello;\nSELECT 1 FROM dual;\nEXIT");
        expect(units.map((u) => [u.kind, u.text])).toEqual([["session", "SET LINESIZE 200"], ["session", "SPOOL out.txt"], ["session", "PROMPT hello"], ["query", "SELECT 1 FROM dual"], ["session", "EXIT"]]);
    });

    it("says when a program unit has no closing / and runs to the end of the file", () => {
        const { units, warnings } = split("CREATE PROCEDURE p AS BEGIN NULL; END;\nSELECT 1 FROM dual;");
        expect(units).toHaveLength(1);
        expect(units[0].note).toMatch(/runs to the end of the file/);
        expect(warnings[0]).toMatch(/line 1/);
    });
});

describe("splitScript: SQL Server", () => {
    it("splits batches at GO lines (also GO 5, and GO with a comment)", () => {
        expect(shape("SELECT 1\nGO\nSELECT 2\ngo 3\nSELECT 3 -- x\nGO -- end", "mssql")).toEqual([["query", "SELECT 1"], ["query", "SELECT 2"], ["query", "SELECT 3 -- x"]]);
    });

    it("keeps a procedure until GO, whatever is inside", () => {
        const { units } = split("CREATE PROCEDURE dbo.p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND\nGO\nSELECT 3;", "mssql");
        expect(units.map((u) => [u.kind, u.startLine, u.endLine])).toEqual([["procedural", 1, 5], ["query", 7, 7]]);
    });

    it("separates DECLARE from the query that follows it, and calls BEGIN TRAN a session command", () => {
        expect(shape("DECLARE @x INT = 5; SELECT * FROM emp WHERE id = @x; BEGIN TRAN; UPDATE t SET a = 1; COMMIT;", "mssql")).toEqual([
            ["procedural", "DECLARE @x INT = 5"],
            ["query", "SELECT * FROM emp WHERE id = @x"],
            ["session", "BEGIN TRAN"],
            ["query", "UPDATE t SET a = 1"],
            ["session", "COMMIT"],
        ]);
    });

    it("keeps IF ... BEGIN ... END whole", () => {
        expect(shape("IF @a = 1\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND;\nSELECT 3;", "mssql").map(([kind]) => kind)).toEqual(["procedural", "query"]);
    });
});

describe("splitScript: MySQL and DB2", () => {
    it("follows DELIMITER, so a procedure is one unit and the directive is not a statement", () => {
        const script = `DELIMITER $$
CREATE PROCEDURE p()
BEGIN
  SELECT 1;
  SELECT 2;
END$$
DELIMITER ;
SELECT 3;`;
        const { units } = split(script, "mysql");
        expect(units.map((u) => [u.kind, u.startLine, u.endLine])).toEqual([["procedural", 2, 6], ["query", 8, 8]]);
        expect(units[0].text.endsWith("END")).toBe(true);
    });

    it("ends a procedure at its balanced END; when no DELIMITER is used", () => {
        expect(shape("CREATE PROCEDURE p() BEGIN SELECT 1; IF a THEN SELECT 2; END IF; END; SELECT 3;", "mysql").map(([kind]) => kind)).toEqual(["procedural", "query"]);
    });

    it("follows DB2's --#SET TERMINATOR", () => {
        const { units } = split("--#SET TERMINATOR @\nCREATE PROCEDURE p() BEGIN SELECT 1 FROM sysibm.sysdummy1; END@\nSELECT 2 FROM sysibm.sysdummy1@", "db2");
        expect(units.map((u) => u.kind)).toEqual(["procedural", "query"]);
    });
});

describe("classify", () => {
    it("tells queries, schema statements, session commands and the unknown apart", () => {
        const kind = (sql: string, dialect: LegacyDialect = "oracle") => classify(sql, dialect).kind;
        expect(kind("select 1")).toBe("query");
        expect(kind("WITH x AS (SELECT 1) SELECT * FROM x")).toBe("query");
        expect(kind("(SELECT 1) UNION (SELECT 2)")).toBe("query");
        expect(kind("MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN UPDATE SET a=1")).toBe("query");
        expect(kind("REPLACE INTO t VALUES (1)", "mysql")).toBe("query");
        expect(kind("CREATE TABLE t (a INT)")).toBe("ddl");
        expect(kind("CREATE OR REPLACE VIEW v AS SELECT 1")).toBe("ddl");
        expect(kind("ALTER TABLE t ADD b INT")).toBe("ddl");
        expect(kind("GRANT SELECT ON t TO u")).toBe("ddl");
        expect(kind("CREATE OR REPLACE FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END")).toBe("procedural");
        expect(kind("CREATE PROC p AS SELECT 1", "mssql")).toBe("procedural");
        expect(kind("EXEC p 1", "mssql")).toBe("procedural");
        expect(kind("CALL p()", "mysql")).toBe("procedural");
        expect(kind("USE db", "mssql")).toBe("session");
        expect(kind("COMMIT")).toBe("session");
        expect(kind("BEGIN TRANSACTION", "mssql")).toBe("session");
        expect(kind("frobnicate the widgets")).toBe("other");
    });
});
