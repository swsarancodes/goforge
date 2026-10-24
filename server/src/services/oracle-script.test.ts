import { describe, expect, it } from "vitest";
import { splitOracleScript } from "./oracle-script.js";

const texts = (sql: string) => splitOracleScript(sql).map((statement) => statement.text);

describe("splitOracleScript", () => {
    it("splits plain statements on ; and drops the ; (the driver rejects it)", () => {
        expect(texts("SELECT 1 FROM dual;\nSELECT 2 FROM dual;")).toEqual(["SELECT 1 FROM dual", "SELECT 2 FROM dual"]);
        expect(texts("SELECT 1 FROM dual")).toEqual(["SELECT 1 FROM dual"]);
        expect(texts("SELECT 1 FROM dual; ; ;SELECT 2 FROM dual")).toEqual(["SELECT 1 FROM dual", "SELECT 2 FROM dual"]);
    });

    it("keeps several statements on one line apart, and a statement over several lines together", () => {
        expect(texts("SELECT a,\n       b\nFROM t\nWHERE a = 1;")).toEqual(["SELECT a,\n       b\nFROM t\nWHERE a = 1"]);
        expect(texts("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);")).toEqual(["INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (2)"]);
    });

    it("does not split on a ; inside a string, a quoted name, q'[...]', or a comment", () => {
        expect(texts("SELECT 'a;b' FROM dual; SELECT \"x;y\" FROM t")).toEqual(["SELECT 'a;b' FROM dual", 'SELECT "x;y" FROM t']);
        expect(texts("SELECT q'[it's; here]' FROM dual; SELECT 2 FROM dual")).toEqual(["SELECT q'[it's; here]' FROM dual", "SELECT 2 FROM dual"]);
        expect(texts("SELECT 1 /* a; b */ FROM dual; -- trailing; comment\nSELECT 2 FROM dual")).toEqual(["SELECT 1 /* a; b */ FROM dual", "-- trailing; comment\nSELECT 2 FROM dual"]);
        expect(texts("SELECT 'it''s; ok' FROM dual;")).toEqual(["SELECT 'it''s; ok' FROM dual"]);
    });

    it("runs a PL/SQL block to the line with only a /, keeping its own ;", () => {
        const script = "BEGIN\n  INSERT INTO t VALUES (1);\n  INSERT INTO t VALUES (2);\nEND;\n/\nSELECT 1 FROM dual;";
        expect(texts(script)).toEqual(["BEGIN\n  INSERT INTO t VALUES (1);\n  INSERT INTO t VALUES (2);\nEND;", "SELECT 1 FROM dual"]);
    });

    it("treats CREATE PROCEDURE / FUNCTION / TRIGGER / PACKAGE as blocks, and a CREATE TABLE as a plain statement", () => {
        const proc = "CREATE OR REPLACE PROCEDURE p IS\nBEGIN\n  NULL;\nEND;\n/";
        expect(texts(proc)).toEqual(["CREATE OR REPLACE PROCEDURE p IS\nBEGIN\n  NULL;\nEND;"]);
        expect(texts("create or replace trigger trg before insert on t for each row begin :new.id := 1; end;\n/")).toHaveLength(1);
        expect(texts("CREATE TABLE a (id NUMBER); CREATE TABLE b (id NUMBER);")).toEqual(["CREATE TABLE a (id NUMBER)", "CREATE TABLE b (id NUMBER)"]);
        expect(texts("DECLARE x NUMBER; BEGIN x := 1; END;")).toEqual(["DECLARE x NUMBER; BEGIN x := 1; END;"]);
    });

    it("ends a block at the end of the script when there is no /", () => {
        expect(texts("BEGIN NULL; END;")).toEqual(["BEGIN NULL; END;"]);
    });

    it("is not confused by a / that is division, or comment-only and empty input", () => {
        expect(texts("SELECT 4 / 2 FROM dual;\nSELECT 6 / 3 FROM dual;")).toEqual(["SELECT 4 / 2 FROM dual", "SELECT 6 / 3 FROM dual"]);
        expect(texts("")).toEqual([]);
        expect(texts("-- only a comment\n/* and another */")).toEqual([]);
        expect(texts(";;;")).toEqual([]);
    });

    it("reports where each statement starts in the script", () => {
        const script = "SELECT 1 FROM dual;\n\n  SELECT 2 FROM dual;";
        const statements = splitOracleScript(script);
        expect(statements.map((statement) => script.slice(statement.offset, statement.offset + statement.text.length))).toEqual(statements.map((statement) => statement.text));
    });
});
