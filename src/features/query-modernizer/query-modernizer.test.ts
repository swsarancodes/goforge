import { describe, it, expect } from "vitest";
import { modernizeQuery } from "./orchestrator";
import { ENTERPRISE_SAMPLE_QUERIES } from "./samples";
import { ModernizeRequest } from "./types";

describe("Multi-Agent Query Modernizer", () => {
    it("successfully modernizes Oracle ERP hierarchical query to PostgreSQL Recursive CTE", async () => {
        const oracleSample = ENTERPRISE_SAMPLE_QUERIES.find(s => s.id === "oracle-hr-hierarchy")!;
        const request: ModernizeRequest = {
            legacySql: oracleSample.legacySql,
            sourceDialect: "oracle",
            targetDialect: "postgresql",
            schemaContext: {
                tables: [
                    { name: "emp_mstr", columns: [{ name: "emp_id", type: "integer", isPrimary: true }, { name: "manager_id", type: "integer" }] },
                    { name: "dept_mstr", columns: [{ name: "dept_id", type: "integer", isPrimary: true }] }
                ]
            }
        };

        const result = await modernizeQuery(request);

        // 1. Verify CTE generated
        expect(result.optimizedSql).toContain("WITH RECURSIVE employee_hierarchy AS");
        expect(result.optimizedSql).toContain("UNION ALL");

        // 2. Verify functions converted
        expect(result.optimizedSql).toContain("COALESCE(");
        expect(result.optimizedSql).not.toContain("NVL(");
        expect(result.optimizedSql).toContain("CASE h.status");
        expect(result.optimizedSql).not.toContain("DECODE(");
        expect(result.optimizedSql).toContain("CURRENT_TIMESTAMP");
        expect(result.optimizedSql).not.toContain("SYSDATE");

        // 3. Verify all 5 agents executed
        expect(result.agentTraces).toHaveLength(5);
        expect(result.agentTraces.map(t => t.agentId)).toEqual(["mapper", "transpiler", "validator", "optimizer", "judge"]);

        // 4. Verify Index Recommendations generated
        expect(result.indexRecommendations.length).toBeGreaterThan(0);
        expect(result.indexRecommendations.some(idx => idx.tableName === "emp_mstr")).toBe(true);

        // 5. Verify Judge certification
        expect(result.confidenceScore).toBeGreaterThanOrEqual(85);
        expect(result.riskLevel).toBe("medium"); // complex recursive CTE
    });

    it("successfully modernizes T-SQL query with CROSS APPLY, TOP, and non-SARGable dates", async () => {
        const mssqlSample = ENTERPRISE_SAMPLE_QUERIES.find(s => s.id === "mssql-sales-reporting")!;
        const request: ModernizeRequest = {
            legacySql: mssqlSample.legacySql,
            sourceDialect: "mssql",
            targetDialect: "postgresql",
            schemaContext: {
                tables: [
                    { name: "customers", columns: [{ name: "customerid", type: "integer", isPrimary: true }] },
                    { name: "orders", columns: [{ name: "orderid", type: "integer", isPrimary: true }, { name: "customerid", type: "integer" }, { name: "orderdate", type: "timestamp" }] }
                ]
            }
        };

        const result = await modernizeQuery(request);

        // 1. Verify CROSS APPLY converted to CROSS JOIN LATERAL
        expect(result.optimizedSql).toContain("CROSS JOIN LATERAL");
        expect(result.optimizedSql).not.toContain("CROSS APPLY");

        // 2. Verify TOP converted to LIMIT
        expect(result.optimizedSql).toContain("LIMIT 50");
        expect(result.optimizedSql).not.toContain("TOP (50)");

        // 3. Verify non-SARGable YEAR() rewritten to range scan
        expect(result.optimizedSql).toContain("OrderDate >= '2024-01-01' AND OrderDate < '2025-01-01'");

        // 4. Verify brackets stripped
        expect(result.optimizedSql).not.toContain("[CustomerID]");

        // 5. Verify Index Recommendation for Orders
        const orderIdx = result.indexRecommendations.find(r => r.tableName === "orders");
        expect(orderIdx).toBeDefined();
        expect(orderIdx?.columns).toContain("customer_id");
        expect(orderIdx?.columns).toContain("order_date");
    });

    it("successfully rewrites hazardous NOT IN subquery to NULL-safe NOT EXISTS and comma joins to ANSI JOINs", async () => {
        const financeSample = ENTERPRISE_SAMPLE_QUERIES.find(s => s.id === "finance-billing-antipatterns")!;
        const request: ModernizeRequest = {
            legacySql: financeSample.legacySql,
            sourceDialect: "mysql",
            targetDialect: "postgresql",
        };

        const result = await modernizeQuery(request);

        // 1. NOT IN replaced with NOT EXISTS
        expect(result.optimizedSql).toContain("NOT EXISTS");
        expect(result.optimizedSql).not.toContain("acc.id NOT IN");

        // 2. IFNULL converted to COALESCE
        expect(result.optimizedSql).toContain("COALESCE(acc.credit_limit, 5000.00)");
        expect(result.optimizedSql).not.toContain("IFNULL(");

        // 3. Comma join converted to INNER JOIN
        expect(result.optimizedSql).toContain("billing_accounts acc\nINNER JOIN invoices t ON acc.id = t.account_id");

        // 4. Index recommendation for past due invoices
        const invIdx = result.indexRecommendations.find(r => r.tableName === "invoices");
        expect(invIdx).toBeDefined();
        expect(invIdx?.columns).toContain("account_id");
        expect(invIdx?.columns).toContain("status");
    });
});
