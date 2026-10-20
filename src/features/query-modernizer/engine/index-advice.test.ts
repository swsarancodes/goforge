import { describe, expect, it } from "vitest";
import type { SchemaContext } from "../types";
import { adviseIndexes } from "./index-advice";

const schema: SchemaContext = {
    tables: [
        { name: "orders", columns: [{ name: "id", type: "integer", isPrimary: true }, { name: "customer_id", type: "integer" }, { name: "status", type: "text" }, { name: "placed", type: "date" }], indexes: [["placed"]] },
        { name: "customers", columns: [{ name: "id", type: "integer", isPrimary: true }, { name: "email", type: "text", isUnique: true }, { name: "region", type: "text" }] },
    ],
};

describe("index advice", () => {
    it("suggests an index for the columns a query filters on, equality first", () => {
        const advice = adviseIndexes("SELECT * FROM orders WHERE status = 'open' AND customer_id = 5 AND placed > DATE '2024-01-01'", schema);
        expect(advice.recommendations).toHaveLength(1);
        expect(advice.recommendations[0]).toMatchObject({ tableName: "orders", columns: ["status", "customer_id", "placed"], ddl: "CREATE INDEX idx_orders_status_customer_id_placed ON orders (status, customer_id, placed);" });
        expect(advice.recommendations[0].reason).toContain("status, customer_id compared with =");
    });

    it("suggests indexes for join columns that no index starts with", () => {
        const advice = adviseIndexes("SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id", schema);
        expect(advice.recommendations.map((r) => r.ddl)).toEqual(["CREATE INDEX idx_orders_customer_id ON orders (customer_id);"]);
    });

    it("doesn't suggest what already exists, primary keys, or unique columns", () => {
        expect(adviseIndexes("SELECT * FROM orders WHERE placed > DATE '2024-01-01'", schema).recommendations).toEqual([]);
        expect(adviseIndexes("SELECT * FROM orders WHERE id = 5", schema).recommendations).toEqual([]);
        expect(adviseIndexes("SELECT * FROM customers WHERE email = 'a@b.c'", schema).recommendations).toEqual([]);
    });

    it("skips LIKE with a leading wildcard and says when a function hides the column", () => {
        expect(adviseIndexes("SELECT * FROM customers WHERE region LIKE '%east'", schema).recommendations).toEqual([]);
        const advice = adviseIndexes("SELECT * FROM orders WHERE EXTRACT(YEAR FROM placed) = 2024", schema);
        expect(advice.notes[0]).toMatch(/placed/);
        expect(advice.notes[0]).toMatch(/can't be used/);
    });

    it("sees through aliases and subqueries, and says nothing without tables", () => {
        expect(adviseIndexes("SELECT * FROM customers c WHERE c.id IN (SELECT o.customer_id FROM orders o WHERE o.status = 'x')", schema).recommendations.map((r) => r.tableName)).toEqual(["orders"]);
        expect(adviseIndexes("SELECT * FROM orders WHERE status = 'x'", undefined).recommendations).toEqual([]);
        expect(adviseIndexes("not sql at all (", schema)).toEqual({ recommendations: [], notes: [] });
    });
});
