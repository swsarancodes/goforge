import { describe, expect, it } from "vitest";
import { applyMapping } from "./mapping-apply";
import { parseMapping } from "./mapping";

const mapping = parseMapping(`source_table,source_column,target_table,target_column
CUST_MST,CUST_ID,customers,customer_id
CUST_MST,CUST_NM,customers,customer_name
POLCY_HDR,POLCY_ID,policies,policy_id
POLCY_HDR,CUST_ID,policies,customer_id
POLCY_HDR,ANNL_PREM,policies,annual_premium
`);

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("applyMapping", () => {
    it("renames tables and columns, and keeps a lone column's legacy name as the output name", () => {
        const { sql, issues } = applyMapping("SELECT c.CUST_ID, c.CUST_NM FROM CUST_MST c JOIN POLCY_HDR p ON p.CUST_ID = c.CUST_ID ORDER BY c.CUST_ID", mapping);
        expect(issues).toEqual([]);
        expect(flat(sql)).toBe("SELECT c.customer_id AS CUST_ID, c.customer_name AS CUST_NM FROM customers c JOIN policies p ON p.customer_id = c.customer_id ORDER BY c.customer_id");
    });

    it("does not alias an expression or a column that already has an alias, and does not rename an alias", () => {
        const { sql } = applyMapping("SELECT SUM(p.ANNL_PREM) AS CUST_ID, p.ANNL_PREM AS total, c.CUST_NM || 'x' FROM CUST_MST c, POLCY_HDR p", mapping);
        expect(flat(sql)).toBe("SELECT SUM(p.annual_premium) AS CUST_ID, p.annual_premium AS total, c.customer_name || 'x' FROM customers c, policies p");
    });

    it("leaves function names, literals and comments alone", () => {
        const { sql } = applyMapping("SELECT COUNT(p.POLCY_ID) /* CUST_ID */ FROM POLCY_HDR p WHERE 'CUST_ID' = 'x' -- CUST_NM\n AND 1 = 1", mapping);
        expect(sql).toContain("COUNT(p.policy_id)");
        expect(sql).toContain("/* CUST_ID */");
        expect(sql).toContain("'CUST_ID'");
        expect(sql).toContain("-- CUST_NM");
    });

    it("aliases inside a subquery and after a UNION, and leaves SELECT * alone", () => {
        const { sql } = applyMapping("SELECT * FROM (SELECT c.CUST_ID FROM CUST_MST c UNION ALL SELECT p.CUST_ID FROM POLCY_HDR p)", mapping);
        expect(flat(sql)).toBe("SELECT * FROM (SELECT c.customer_id AS CUST_ID FROM customers c UNION ALL SELECT p.customer_id AS CUST_ID FROM policies p)");
    });

    it("does not guess when one legacy name maps to different target names", () => {
        const ambiguous = parseMapping("source_table,source_column,target_table,target_column\nA,X,a,x1\nB,X,b,x2\n");
        const { sql, issues } = applyMapping("SELECT X FROM A", ambiguous);
        expect(issues[0]).toMatch(/X maps to different columns/);
        expect(sql).toBe("SELECT X FROM A");
    });

    it("reports a query it cannot read instead of throwing", () => {
        const { issues } = applyMapping("SELECT (a FROM t", mapping);
        expect(issues[0]).toMatch(/could not be read/);
    });
});
