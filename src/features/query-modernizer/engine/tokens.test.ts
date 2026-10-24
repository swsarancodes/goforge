import { describe, expect, it } from "vitest";
import { SqlSyntaxError, buildTree, isGroup, print, splitTopLevel, tokenize, tpl } from "./tokens";

const roundTrip = (sql: string, dialect: Parameters<typeof tokenize>[1] = "oracle") => print(buildTree(tokenize(sql, dialect)));

describe("tokenizer", () => {
    it("prints unchanged SQL exactly as written, including whitespace and comments", () => {
        const sql = "SELECT  a,\n   b -- note\n FROM t /* block */ WHERE x = 'it''s'";
        expect(roundTrip(sql)).toBe(sql);
    });

    it("reads strings with doubled quotes, Oracle q-quoting and the N prefix", () => {
        expect(tokenize("'it''s'", "oracle")[0]).toMatchObject({ kind: "string", value: "it's" });
        expect(tokenize("q'[it's [x]]'", "oracle")[0]).toMatchObject({ kind: "string", value: "it's [x]" });
        expect(tokenize("N'abc'", "mssql")[0]).toMatchObject({ kind: "string", value: "abc", text: "'abc'" });
    });

    it("turns MySQL double-quoted text and backslash escapes into standard strings", () => {
        expect(tokenize('"abc"', "mysql")[0]).toMatchObject({ kind: "string", text: "'abc'" });
        expect(tokenize("'it\\'s'", "mysql")[0]).toMatchObject({ kind: "string", value: "it's", text: "'it''s'" });
        // elsewhere "x" is a name: kept as written, except that Oracle and DB2 keep bare names in upper case, so "NAME" is the same column as name
        expect(tokenize('"X"', "mssql")[0]).toMatchObject({ kind: "ident", quote: "double", text: '"X"' });
        expect(tokenize('"NAME"', "oracle")[0]).toMatchObject({ kind: "ident", text: "name", converted: true });
        expect(tokenize('"Name"', "oracle")[0]).toMatchObject({ kind: "ident", text: '"Name"' });
        expect(tokenize('"ORDER"', "oracle")[0]).toMatchObject({ text: '"order"' });
    });

    it("reads [brackets] and `backticks` as names only in the dialect that has them", () => {
        expect(tokenize("[first name]", "mssql")[0]).toMatchObject({ kind: "ident", value: "first name", text: '"first name"' });
        expect(tokenize("[Orders]", "mssql")[0]).toMatchObject({ kind: "ident", text: "orders" });
        expect(tokenize("[Order]", "mssql")[0]).toMatchObject({ kind: "ident", text: '"order"' });
        expect(tokenize("`name`", "mysql")[0]).toMatchObject({ kind: "ident", text: "name" });
        expect(tokenize("a[1]", "oracle").map((t) => t.text)).toEqual(["a", "[", "1", "]"]);
    });

    it("finds the Oracle (+) marker, with or without spaces", () => {
        expect(tokenize("a.b (+)", "oracle").map((t) => t.kind)).toEqual(["word", "punct", "word", "outer"]);
        expect(tokenize("a.b(+)", "oracle").at(-1)?.kind).toBe("outer");
        // not a marker in other dialects, and a plain sum is untouched
        expect(tokenize("(+)", "mysql").map((t) => t.text)).toEqual(["(", "+", ")"]);
        expect(tokenize("x * (+1)", "oracle").some((t) => t.kind === "outer")).toBe(false);
    });

    it("keeps Oracle hints apart from ordinary comments", () => {
        expect(tokenize("SELECT /*+ FULL(t) */ 1", "oracle").map((t) => t.kind)).toEqual(["word", "hint", "number"]);
        expect(tokenize("SELECT /* note */ 1", "oracle").map((t) => t.kind)).toEqual(["word", "number"]);
    });

    it("tells bind variables from the :: cast", () => {
        expect(tokenize(":name", "oracle")[0]).toMatchObject({ kind: "param", text: ":name" });
        expect(tokenize("x::int", "oracle").map((t) => t.text)).toEqual(["x", "::", "int"]);
        expect(tokenize("@x", "mssql")[0]).toMatchObject({ kind: "param" });
        expect(tokenize("?", "mysql")[0]).toMatchObject({ kind: "param" });
    });

    it("reports unclosed strings, comments, names and brackets", () => {
        expect(() => tokenize("SELECT 'abc", "oracle")).toThrow(SqlSyntaxError);
        expect(() => tokenize("SELECT /* abc", "oracle")).toThrow(SqlSyntaxError);
        expect(() => tokenize("SELECT [abc", "mssql")).toThrow(SqlSyntaxError);
        expect(() => buildTree(tokenize("SELECT (1", "oracle"))).toThrow(SqlSyntaxError);
        expect(() => buildTree(tokenize("SELECT 1)", "oracle"))).toThrow(SqlSyntaxError);
    });

    it("builds one group per bracket pair and splits on top-level commas only", () => {
        const tree = buildTree(tokenize("f(a, g(b, c), d)", "oracle"));
        expect(tree).toHaveLength(2);
        const group = tree[1];
        expect(isGroup(group)).toBe(true);
        if (isGroup(group)) expect(splitTopLevel(group.items)).toHaveLength(3);
    });

    it("prints template fragments with natural spacing", () => {
        const [a] = buildTree(tokenize("x + 1", "oracle")).length ? [buildTree(tokenize("x + 1", "oracle"))] : [[]];
        expect(print(tpl`COALESCE(${a}, 0)`)).toBe("COALESCE(x + 1, 0)");
        expect(print(tpl`CAST(${a} AS text)`)).toBe("CAST(x + 1 AS text)");
        expect(print(tpl`INTERVAL '${"3"} months'`)).toBe("INTERVAL '3 months'");
        expect(print(tpl`x::text || 'a'`)).toBe("x::text || 'a'");
    });
});
