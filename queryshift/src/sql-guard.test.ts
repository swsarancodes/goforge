import { describe, expect, it } from "vitest";
import { guardSelect, skeleton } from "./sql-guard";

const refused = (sql: string) => guardSelect(sql);

describe("guardSelect: what may run", () => {
    it.each([
        "SELECT 1",
        "select * from customers where customer_id = 1;",
        "WITH t AS (SELECT 1 AS a) SELECT * FROM t",
        "(SELECT 1) UNION ALL (SELECT 2)",
        "SELECT CASE WHEN a > 1 THEN 'x' END FROM t FETCH FIRST 5 ROWS ONLY",
        "SELECT 'insert; drop table x' AS text_that_looks_dangerous",
        "SELECT \"customer_name\" FROM customers -- ; delete from customers",
        "SELECT 1 /* nested /* comment */ still comment; delete */",
        "SELECT $$ ; drop table x $$",
        "SELECT c.customer_id FROM customers c WHERE c.joined_on >= DATE '2026-01-01' ORDER BY 1",
    ])("allows %s", (sql) => expect(guardSelect(sql)).toEqual({ ok: true }));
});

describe("guardSelect: what is refused, and why", () => {
    it.each([
        ["", /empty/],
        ["INSERT INTO customers VALUES (1)", /Only a SELECT/],
        ["DELETE FROM customers", /Only a SELECT/],
        ["DROP TABLE customers", /Only a SELECT/],
        ["SELECT 1; DROP TABLE customers", /one statement/],
        ["SELECT 1; SELECT 2", /one statement/],
        ["WITH d AS (DELETE FROM claims RETURNING *) SELECT * FROM d", /DELETE/],
        ["WITH u AS (UPDATE claims SET claim_amount = 0 RETURNING *) SELECT * FROM u", /UPDATE/],
        ["SELECT * INTO backup FROM customers", /INTO/],
        ["SELECT * FROM customers FOR UPDATE", /UPDATE|locking/i],
        ["SELECT * FROM customers FOR SHARE", /locking/],
        ["COPY customers TO PROGRAM 'x'", /Only a SELECT/],
        ["SELECT pg_read_file('/etc/passwd')", /pg_read_file/],
        ["SELECT pg_catalog.pg_read_file ('/etc/passwd')", /pg_read_file/],
        ["SELECT \"pg_read_file\"('/etc/passwd')", /pg_read_file/],
        ["SELECT pg_read_file /* hide */ ('/etc/passwd')", /pg_read_file/],
        ["SELECT lo_import('/etc/passwd')", /lo_import/],
        ["SELECT * FROM dblink('host=elsewhere', 'select 1') AS t(a int)", /dblink/],
        ["SELECT pg_sleep(60)", /pg_sleep/],
        ["SELECT set_config('statement_timeout', '0', false)", /set_config/],
        ["SELECT nextval('s')", /nextval/],
        ["SELECT query_to_xml('delete from claims', true, true, '')", /query_to_xml/],
        ["SELECT 'unclosed", /never closed/],
        ["SELECT 1 /* unclosed", /never closed/],
        ["SELECT $a$ unclosed", /never closed/],
    ])("refuses %j", (sql, reason) => {
        const result = refused(sql);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(reason);
    });

    it("refuses an over-long statement", () => expect(refused(`SELECT '${"x".repeat(21_000)}'`).ok).toBe(false));
});

describe("skeleton", () => {
    it("blanks literals and comments and keeps quoted names as words", () => {
        const flat = skeleton("SELECT 'a;b', \"Weird Name\" -- tail\nFROM t")!;
        expect(flat).not.toContain(";");
        expect(flat).not.toContain("tail");
        expect(flat.replace(/\s+/g, " ")).toBe("select '', weird name from t");
    });
    it("understands E'' strings with escaped quotes: the ; inside stays inside", () => {
        expect(skeleton("SELECT E'it\\'s; drop' AS x")).toBe("select e'' as x");
        expect(guardSelect("SELECT E'it\\'s; drop' AS x").ok).toBe(true);
    });
});
