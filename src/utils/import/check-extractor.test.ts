import { describe, expect, it } from "vitest";
import { extractCheckFromAlterTable, extractChecksFromCreateTable } from "./check-extractor";

describe("extractChecksFromCreateTable", () => {
    it("reads a named table-level check verbatim", () => {
        const sql = `CREATE TABLE users (id INT, price INT, CONSTRAINT chk_price CHECK (price>0 AND id <> 3))`;
        expect(extractChecksFromCreateTable(sql)).toEqual([{ name: "chk_price", expression: "price>0 AND id <> 3" }]);
    });

    it("reads unnamed table-level and column-level checks", () => {
        const sql = `CREATE TABLE t (
            id INT PRIMARY KEY,
            qty INT NOT NULL CHECK (qty >= 0),
            price DECIMAL(10,2) CONSTRAINT price_pos CHECK (price > 0),
            CHECK (qty < 1000)
        )`;
        expect(extractChecksFromCreateTable(sql)).toEqual([
            { name: undefined, expression: "qty >= 0" },
            { name: "price_pos", expression: "price > 0" },
            { name: undefined, expression: "qty < 1000" },
        ]);
    });

    it("handles nested parentheses, functions and IN lists", () => {
        const sql = `CREATE TABLE t (a INT, CONSTRAINT c CHECK ((a > 0 AND (a < 10 OR a = 20)) AND lower(name) IN ('x','y')))`;
        expect(extractChecksFromCreateTable(sql)[0].expression).toBe("(a > 0 AND (a < 10 OR a = 20)) AND lower(name) IN ('x','y')");
    });

    it("ignores parentheses, commas and CHECK keywords inside string literals", () => {
        const sql = `CREATE TABLE t (a TEXT DEFAULT 'CHECK (x)', b TEXT, CONSTRAINT c CHECK (b <> 'a),b(' ))`;
        expect(extractChecksFromCreateTable(sql)).toEqual([{ name: "c", expression: "b <> 'a),b('" }]);
    });

    it("does not treat a column named check_in or a default as a check", () => {
        const sql = `CREATE TABLE t (check_in DATE, "check" INT DEFAULT 5, note TEXT DEFAULT 'a')`;
        expect(extractChecksFromCreateTable(sql)).toEqual([]);
    });

    it("unwraps every identifier quoting style", () => {
        for (const quoted of ['"my chk"', "`my chk`", "[my chk]"]) {
            const sql = `CREATE TABLE t (a INT, CONSTRAINT ${quoted} CHECK (a > 0))`;
            expect(extractChecksFromCreateTable(sql)[0].name).toBe("my chk");
        }
    });

    it("ignores a CHECK that appears only in a comment", () => {
        const sql = `CREATE TABLE t (\n a INT, -- CHECK (a > 0)\n b INT /* CONSTRAINT x CHECK (b > 0) */\n)`;
        expect(extractChecksFromCreateTable(sql)).toEqual([]);
    });

    it("returns nothing for a table without checks or broken SQL", () => {
        expect(extractChecksFromCreateTable("CREATE TABLE t (a INT)")).toEqual([]);
        expect(extractChecksFromCreateTable("CREATE TABLE t (a INT, CHECK (a > 0")).toEqual([]);
        expect(extractChecksFromCreateTable("not sql")).toEqual([]);
    });
});

describe("extractCheckFromAlterTable", () => {
    it("reads ADD CONSTRAINT ... CHECK with a qualified table", () => {
        const sql = `ALTER TABLE "public"."users" ADD CONSTRAINT "chk_age" CHECK (age >= 18)`;
        expect(extractCheckFromAlterTable(sql)).toEqual({ tableName: "public.users", name: "chk_age", expression: "age >= 18" });
    });

    it("supports unnamed checks and other quoting", () => {
        expect(extractCheckFromAlterTable("ALTER TABLE `t` ADD CHECK (a > 0)")).toEqual({ tableName: "t", name: undefined, expression: "a > 0" });
        expect(extractCheckFromAlterTable("ALTER TABLE [dbo].[t] ADD CONSTRAINT [c] CHECK (a > 0)")).toEqual({ tableName: "dbo.t", name: "c", expression: "a > 0" });
    });

    it("ignores other ALTER statements", () => {
        expect(extractCheckFromAlterTable("ALTER TABLE t ADD COLUMN a INT")).toBeUndefined();
        expect(extractCheckFromAlterTable("ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id)")).toBeUndefined();
    });
});
