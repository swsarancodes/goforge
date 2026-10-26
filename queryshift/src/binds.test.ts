import { describe, expect, it } from "vitest";
import { convertQuery } from "../../src/features/query-modernizer/engine/convert";
import { oracleLiteral, parseBindValues, substituteBinds, type BindValues } from "./binds";

const fail = (message: string): never => {
    throw new Error(message);
};
const cutoff: BindValues = { cutoff: { type: "date", value: "2026-01-01" } };
const DATE = "TO_DATE('2026-01-01', 'YYYY-MM-DD')";

describe("substituteBinds", () => {
    it("writes a declared value into the query in place of its :name", () => {
        const { sql, unused } = substituteBinds("SELECT 1 FROM t WHERE d >= :cutoff AND e < :cutoff", cutoff);
        expect(sql).toBe(`SELECT 1 FROM t WHERE d >= ${DATE} AND e < ${DATE}`);
        expect(unused).toEqual([]);
    });

    it("does not tell :Cutoff from :cutoff, as Oracle does not", () => {
        expect(substituteBinds("x >= :CUTOFF", cutoff).sql).toBe(`x >= ${DATE}`);
    });

    it("leaves a bind variable it was not given a value for, so the query still reads as having one", () => {
        expect(substituteBinds("x >= :cutoff AND y = :region", cutoff).sql).toBe(`x >= ${DATE} AND y = :region`);
    });

    it("copies everything else exactly: whitespace, line endings, comments, case", () => {
        const text = "select  A.b\r\n\tfrom T -- note\r\n where x = 1 /* :cutoff */\n";
        expect(substituteBinds(text, cutoff)).toEqual({ sql: text, unused: ["cutoff"] });
    });

    it("does not treat :name inside a string, a quoted name or a comment as a bind variable", () => {
        const text = ["'at :cutoff'", '"x:cutoff"', "-- :cutoff", "/* :cutoff */", "q'[:cutoff]'", "q'(it's :cutoff)'", "'it''s :cutoff'"].join(" ");
        expect(substituteBinds(text, cutoff).sql).toBe(text);
    });

    it("finds the bind variable right after a string, a comment or a word that merely ends in q", () => {
        expect(substituteBinds("'a' || :cutoff", cutoff).sql).toBe(`'a' || ${DATE}`);
        expect(substituteBinds("/* c */:cutoff", cutoff).sql).toBe(`/* c */${DATE}`);
        expect(substituteBinds("faq'[x]' || :cutoff", cutoff).sql).toBe(`faq'[x]' || ${DATE}`);
    });

    it("does not read :: or := as the start of a bind variable", () => {
        const text = "a::cutoff b:=cutoff";
        expect(substituteBinds(text, cutoff).sql).toBe(text);
    });

    it("handles a bind variable next to punctuation, and numbered binds", () => {
        const values: BindValues = { ...cutoff, "1": { type: "number", value: "5" } };
        expect(substituteBinds("f(:cutoff,:1)>=:1", values).sql).toBe(`f(${DATE},5)>=5`);
    });

    it("quotes a string value, doubling a single quote in it", () => {
        expect(substituteBinds("n = :who", { who: { type: "string", value: "O'Brien" } }).sql).toBe("n = 'O''Brien'");
    });

    it("names a declared value the query never uses, as the case spelled it", () => {
        expect(substituteBinds("SELECT 1", { Region: { type: "string", value: "EU" } }).unused).toEqual(["Region"]);
    });

    it("leaves the rule engine with nothing to complain about, where before it reported a bind variable", () => {
        const legacy = "SELECT c.CUST_ID FROM CUST_MST c, POLCY_HDR p WHERE c.CUST_ID = p.CUST_ID(+) AND p.EFF_DT(+) >= :cutoff";
        expect(convertQuery({ sql: legacy, dialect: "oracle" }).parameters).toEqual([":cutoff"]);
        const bound = convertQuery({ sql: substituteBinds(legacy, cutoff).sql, dialect: "oracle" });
        expect(bound.parameters).toEqual([]);
        expect(bound.unconverted).toEqual([]);
        expect(bound.sql).toContain(DATE);
        expect(bound.sql).not.toContain(":cutoff");
    });
});

describe("oracleLiteral", () => {
    it("writes each type the way the legacy query would have it inline", () => {
        expect(oracleLiteral({ type: "date", value: "2026-01-01" })).toBe(DATE);
        expect(oracleLiteral({ type: "number", value: "-12.50" })).toBe("-12.50");
        expect(oracleLiteral({ type: "string", value: "AC" })).toBe("'AC'");
    });
});

describe("parseBindValues", () => {
    it("is empty when the case declares none", () => expect(parseBindValues(undefined, fail)).toEqual({}));

    it("reads a date, a number (as a JSON number or as text) and a string", () => {
        expect(parseBindValues({ cutoff: { type: "date", value: "2026-01-01" }, limit: { type: "number", value: 5 }, rate: { type: "number", value: "0.25" }, status: { type: "string", value: "AC" } }, fail)).toEqual({
            cutoff: { type: "date", value: "2026-01-01" },
            limit: { type: "number", value: "5" },
            rate: { type: "number", value: "0.25" },
            status: { type: "string", value: "AC" },
        });
    });

    it("says what is wrong with a declaration", () => {
        const bad = (raw: unknown) => () => parseBindValues(raw, fail);
        expect(bad([])).toThrow(/object/);
        expect(bad({ ":cutoff": { type: "date", value: "2026-01-01" } })).toThrow(/without the colon/);
        expect(bad({ cutoff: { type: "date", value: "2026-02-30" } })).toThrow(/YYYY-MM-DD and must exist/);
        expect(bad({ cutoff: { type: "date", value: "01/01/2026" } })).toThrow(/YYYY-MM-DD/);
        expect(bad({ n: { type: "number", value: "1e5" } })).toThrow(/plain digits/);
        expect(bad({ n: { type: "number", value: "5; DROP TABLE t" } })).toThrow(/plain digits/);
        expect(bad({ s: { type: "string", value: 5 } })).toThrow(/must be a string/);
        expect(bad({ s: { type: "timestamp", value: "2026-01-01" } })).toThrow(/date, number or string/);
        expect(bad({ s: "2026-01-01" })).toThrow(/date, number or string/);
        expect(bad({ Cutoff: { type: "string", value: "a" }, cutoff: { type: "string", value: "b" } })).toThrow(/declared twice/);
    });
});
