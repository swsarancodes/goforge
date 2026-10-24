import { describe, expect, it } from "vitest";
import type { SchemaTable } from "./database";
import { analyzeCandidate } from "./semantic";

const col = (name: string, type: string, nullable = true) => ({ name, type, nullable });
const schema: SchemaTable[] = [
    { name: "t", columns: [col("id", "integer", false), col("n", "integer"), col("s", "text"), col("name", "text", false), col("d", "date"), col("ts", "timestamp without time zone"), col("amount", "numeric")] },
    { name: "u", columns: [col("id", "integer", false), col("t_id", "integer", false), col("status", "text"), col("v", "numeric")] },
];

/** Ids of the findings for a candidate, given the legacy query it replaces. */
async function ids(legacySql: string, sql: string, resultColumns?: { name: string; typeOid?: number }[]) {
    return [...new Set((await analyzeCandidate({ legacySql, sql, schema, resultColumns })).map((finding) => finding.id))].sort();
}

describe("outer_join_filtered_in_where", () => {
    const legacy = "SELECT t.id, COUNT(u.id) FROM t, u WHERE t.id = u.t_id(+) AND u.status(+) = 'AC' GROUP BY t.id";
    it("flags a predicate on the outer-joined table in WHERE", async () => {
        expect(await ids(legacy, "SELECT t.id FROM t LEFT JOIN u ON u.t_id = t.id WHERE u.status = 'AC'")).toEqual(["outer_join_filtered_in_where"]);
        expect(await ids(legacy, "SELECT t.id FROM t LEFT JOIN u ON u.t_id = t.id WHERE u.status = 'AC' OR u.id IS NULL")).toEqual(["outer_join_filtered_in_where"]);
        expect(await ids(legacy, "SELECT t.id FROM t LEFT JOIN u ON u.t_id = t.id WHERE u.v IS NOT NULL")).toEqual(["outer_join_filtered_in_where"]);
    });
    it("does not flag the predicate in ON, an anti-join, a filter on the other table, or a legacy query with no outer join", async () => {
        expect(await ids(legacy, "SELECT t.id FROM t LEFT JOIN u ON u.t_id = t.id AND u.status = 'AC'")).toEqual([]);
        expect(await ids(legacy, "SELECT t.id FROM t LEFT JOIN u ON u.t_id = t.id WHERE u.id IS NULL")).toEqual([]);
        expect(await ids(legacy, "SELECT t.id FROM t LEFT JOIN u ON u.t_id = t.id WHERE t.n > 1")).toEqual([]);
        expect(await ids("SELECT t.id FROM t, u WHERE t.id = u.t_id AND u.status = 'AC'", "SELECT t.id FROM t LEFT JOIN u ON u.t_id = t.id WHERE u.status = 'AC'")).toEqual([]);
    });
    it("recognises an ANSI LEFT JOIN in the legacy query, and a join inside a subquery", async () => {
        expect(await ids("SELECT 1 FROM t LEFT JOIN u ON u.t_id = t.id AND u.status = 'AC'", "SELECT * FROM (SELECT t.id FROM t LEFT JOIN u ON u.t_id = t.id WHERE u.status = 'AC') x")).toEqual(["outer_join_filtered_in_where"]);
    });
    it("resolves an unqualified column to the outer table only when it is unambiguous", async () => {
        expect(await ids(legacy, "SELECT t.id FROM t LEFT JOIN u ON u.t_id = t.id WHERE status = 'AC'")).toEqual(["outer_join_filtered_in_where"]);
        expect(await ids(legacy, "SELECT t.id FROM t LEFT JOIN u ON u.t_id = t.id WHERE id = 1")).toEqual(["fitted_to_a_literal"]);
    });
});

describe("count_star_over_outer_join", () => {
    it("flags COUNT(*) with an outer join unless the legacy query counted rows the same way", async () => {
        expect(await ids("SELECT COUNT(u.id) FROM t, u WHERE t.id = u.t_id(+)", "SELECT COUNT(*) FROM t LEFT JOIN u ON u.t_id = t.id")).toEqual(["count_star_over_outer_join"]);
        expect(await ids("SELECT COUNT(*) FROM t, u WHERE t.id = u.t_id(+)", "SELECT COUNT(*) FROM t LEFT JOIN u ON u.t_id = t.id")).toEqual([]);
        expect(await ids("SELECT COUNT(u.id) FROM t, u WHERE t.id = u.t_id", "SELECT COUNT(*) FROM t JOIN u ON u.t_id = t.id")).toEqual([]);
        expect(await ids("SELECT COUNT(u.id) FROM t, u WHERE t.id = u.t_id(+)", "SELECT COUNT(u.id) FROM t LEFT JOIN u ON u.t_id = t.id")).toEqual([]);
    });
});

describe("integer_division", () => {
    const legacy = "SELECT COUNT(x) / COUNT(y) FROM t";
    it("flags a division of integers", async () => {
        expect(await ids(legacy, "SELECT COUNT(*) / COUNT(n) FROM t")).toEqual(["integer_division"]);
        expect(await ids(legacy, "SELECT ROUND(COUNT(*) / NULLIF(COUNT(n), 0), 4) FROM t")).toEqual(["integer_division"]);
        expect(await ids(legacy, "SELECT t.id / 2 FROM t")).toEqual(["integer_division"]);
        expect(await ids(legacy, "SELECT SUM(t.n) / COUNT(*) FROM t")).toEqual(["integer_division"]);
        expect(await ids(legacy, "SELECT COALESCE(t.n, 0) / t.id FROM t")).toEqual(["integer_division"]);
    });
    it("does not flag a cast, a decimal literal, a numeric column, an interval, or a legacy query with no division", async () => {
        expect(await ids(legacy, "SELECT COUNT(*)::numeric / COUNT(n) FROM t")).toEqual([]);
        expect(await ids(legacy, "SELECT CAST(COUNT(*) AS numeric) / COUNT(n) FROM t")).toEqual([]);
        expect(await ids(legacy, "SELECT t.id / 2.0 FROM t")).toEqual([]);
        expect(await ids(legacy, "SELECT t.amount / t.id FROM t")).toEqual([]);
        expect(await ids(legacy, "SELECT EXTRACT(EPOCH FROM (t.ts - t.ts)) / 86400 FROM t")).toEqual([]);
        expect(await ids("SELECT 1 FROM t", "SELECT COUNT(*) / COUNT(n) FROM t")).toEqual([]);
    });
});

describe("null_in_concatenation", () => {
    const legacy = "SELECT a || b FROM t";
    it("flags a nullable column in ||, on either side", async () => {
        expect(await ids(legacy, "SELECT t.name || ' <' || t.s || '>' FROM t")).toEqual(["null_in_concatenation"]);
        expect(await ids(legacy, "SELECT t.s || t.name FROM t")).toEqual(["null_in_concatenation"]);
    });
    it("does not flag COALESCE, CONCAT, a NOT NULL column, literals, or a legacy query without ||", async () => {
        expect(await ids(legacy, "SELECT t.name || COALESCE(t.s, '') FROM t")).toEqual([]);
        expect(await ids(legacy, "SELECT CONCAT(t.name, t.s) FROM t")).toEqual([]);
        expect(await ids(legacy, "SELECT t.name || ' ' || t.name FROM t")).toEqual([]);
        expect(await ids("SELECT a FROM t", "SELECT t.name || t.s FROM t")).toEqual([]);
    });
});

describe("average_ignores_nulls", () => {
    it("flags AVG without the substitution the legacy AVG(NVL(...)) had", async () => {
        const legacy = "SELECT AVG(NVL(v, 0)) FROM u";
        expect(await ids(legacy, "SELECT AVG(u.v) FROM u")).toEqual(["average_ignores_nulls"]);
        expect(await ids(legacy, "SELECT AVG(COALESCE(u.v, 0)) FROM u")).toEqual([]);
        expect(await ids("SELECT AVG(v) FROM u", "SELECT AVG(u.v) FROM u")).toEqual([]);
    });
});

describe("timestamp_vs_date_boundary", () => {
    const legacy = "SELECT 1 FROM t WHERE TRUNC(ts) <= TO_DATE('2026-03-31', 'YYYY-MM-DD')";
    it("flags <=, = and BETWEEN against a DATE literal on a timestamp column when the legacy query truncated", async () => {
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.ts <= DATE '2026-03-31'")).toEqual(["timestamp_vs_date_boundary"]);
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.ts = DATE '2026-03-31'")).toEqual(["timestamp_vs_date_boundary"]);
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.ts BETWEEN DATE '2026-03-01' AND DATE '2026-03-31'")).toEqual(["timestamp_vs_date_boundary"]);
    });
    it("does not flag a half-open range, a cast, a date column, a TIMESTAMP literal, or a legacy query with no TRUNC", async () => {
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.ts >= DATE '2026-03-01' AND t.ts < DATE '2026-04-01'")).toEqual([]);
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.ts::date <= DATE '2026-03-31'")).toEqual([]);
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.d <= DATE '2026-03-31'")).toEqual([]);
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.ts < TIMESTAMP '2026-04-01 00:00:00'")).toEqual([]);
        expect(await ids("SELECT 1 FROM t WHERE ts <= TO_DATE('2026-03-31', 'YYYY-MM-DD')", "SELECT 1 FROM t WHERE t.ts <= DATE '2026-03-31'")).toEqual([]);
    });
});

describe("month_arithmetic_without_month_end_rule", () => {
    const legacy = "SELECT ADD_MONTHS(d, 6) FROM t";
    it("flags INTERVAL month arithmetic when the legacy query used ADD_MONTHS and nothing handles month ends", async () => {
        expect(await ids(legacy, "SELECT (t.d + INTERVAL '6 months')::date FROM t")).toEqual(["month_arithmetic_without_month_end_rule"]);
        expect(await ids(legacy, "SELECT t.d + INTERVAL '1 year' FROM t")).toEqual(["month_arithmetic_without_month_end_rule"]);
    });
    it("does not flag when the month-end rule is there, the interval is in days, or the legacy query had no ADD_MONTHS", async () => {
        expect(await ids(legacy, "SELECT CASE WHEN t.d = (date_trunc('month', t.d) + INTERVAL '1 month - 1 day')::date THEN (date_trunc('month', t.d + INTERVAL '6 months') + INTERVAL '1 month - 1 day')::date ELSE (t.d + INTERVAL '6 months')::date END FROM t")).toEqual([]);
        expect(await ids(legacy, "SELECT t.d + INTERVAL '7 days' FROM t")).toEqual([]);
        expect(await ids("SELECT d + 30 FROM t", "SELECT t.d + INTERVAL '6 months' FROM t")).toEqual([]);
    });
});

describe("interval_result", () => {
    it("flags a result column PostgreSQL typed as an interval", async () => {
        expect(await ids("SELECT a - b FROM t", "SELECT t.ts - t.ts AS gap FROM t", [{ name: "gap", typeOid: 1186 }])).toEqual(["interval_result"]);
        expect(await ids("SELECT a - b FROM t", "SELECT 1 AS gap FROM t", [{ name: "gap", typeOid: 23 }])).toEqual([]);
    });
});

describe("fitted_to_a_literal (blocking)", () => {
    const legacy = "SELECT ROUND(AVG(x), 2) FROM t WHERE s = 'AC' AND n > 0";
    it("flags a comparison with a value the legacy query does not contain, as blocking", async () => {
        const [finding] = await analyzeCandidate({ legacySql: legacy, sql: "SELECT 1 FROM t WHERE t.id = 7", schema });
        expect(finding).toMatchObject({ id: "fitted_to_a_literal", severity: "blocking" });
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.s = 'ZZ'")).toEqual(["fitted_to_a_literal"]);
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.id <= 4")).toEqual(["fitted_to_a_literal"]);
        expect(await ids(legacy, "SELECT 1 FROM t WHERE 4 >= t.id")).toEqual(["fitted_to_a_literal"]);
        expect(await ids(legacy, "SELECT CASE WHEN t.id = 2 THEN 1 ELSE 0 END FROM t")).toEqual(["fitted_to_a_literal"]);
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.d = DATE '2026-02-28'")).toEqual(["fitted_to_a_literal"]);
    });
    it("does not flag a value the legacy query has, an inequality on a non-key column, or a number that merely appears elsewhere in it", async () => {
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.s = 'AC'")).toEqual([]);
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.n > 0")).toEqual([]);
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.n >= 5")).toEqual([]);
        expect(await ids(legacy, "SELECT 1 FROM t WHERE t.d >= DATE '2026-04-01'")).toEqual([]);
        expect(await ids("SELECT 1 FROM t WHERE t.id = 3", "SELECT 1 FROM t WHERE t.id = 3")).toEqual([]);
        expect(await ids(legacy, "SELECT t.id = t.n FROM t")).toEqual([]);
    });
});

describe("what it cannot read", () => {
    it("says so instead of saying nothing", async () => {
        const findings = await analyzeCandidate({ legacySql: "SELECT 1", sql: "SELEKT nonsense (", schema });
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ id: "unanalyzed", severity: "warning" });
    });
    it("reports one finding per distinct construct, not per mention", async () => {
        const findings = await analyzeCandidate({ legacySql: "SELECT a || b FROM t", sql: "SELECT t.s || 'a', t.s || 'b' FROM t", schema });
        expect(findings.filter((finding) => finding.id === "null_in_concatenation")).toHaveLength(1);
    });
});
