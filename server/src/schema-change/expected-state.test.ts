import { describe, expect, it } from "vitest";
import { compile, facts, MIB, plan, table } from "./test-fixtures.js";
import { diffExpected, expectedState } from "./expected-state.js";

const orders = () =>
    table({
        name: "orders", rows: 5_000_000, bytes: 400 * MIB,
        columns: ["id:bigint:notnull", "customer_id:bigint:notnull", "qty:integer:notnull", "note:text"],
        indexes: [{ name: "orders_qty_idx", columns: ["qty"], scans: 3 }],
        checks: [{ name: "orders_qty_positive", definition: "CHECK ((qty > 0))", columns: ["qty"] }],
    });
const tables = () => facts(orders(), table({ name: "customers", columns: ["id:bigint:notnull"] }));

describe("expected state", () => {
    it("matches a catalog nothing changed in, and says nothing about it", () => {
        const before = tables();
        expect(diffExpected(expectedState(before.tables, before.tables), before)).toEqual([]);
    });

    it("follows the plan: a new column and index, a renamed table, a dropped table", () => {
        const runbook = compile(plan(
            { type: "add_column", tableName: "orders", field: { name: "carrier", dataType: "text" } },
            { type: "add_index", tableName: "orders", index: { name: "orders_carrier_idx", columns: ["carrier"] } },
            { type: "rename_table", tableName: "customers", newName: "clients" },
        ), tables());
        const expected = runbook.expected;
        expect(expected.tables.map((t) => t.qualified).sort()).toEqual(["public.clients", "public.orders"]);
        expect(expected.absent).toEqual(["public.customers"]);
        expect(expected.tables.find((t) => t.qualified === "public.orders")?.columns.map((c) => c.name)).toContain("carrier");
        expect(expected.tables.find((t) => t.qualified === "public.orders")?.indexes.map((i) => i.name)).toContain("orders_carrier_idx");
    });

    it("keeps the old column and its index in the model of an expand/contract type change, because the contract step does not run by default", () => {
        const runbook = compile(plan({ type: "alter_column", tableName: "orders", columnName: "qty", changes: { dataType: "bigint" } }), facts(table({ name: "orders", rows: 5_000_000, bytes: 400 * MIB, columns: ["id:bigint:notnull", "qty:integer"], indexes: [{ name: "orders_qty_idx", columns: ["qty"], scans: 3 }] })));
        const orders = runbook.expected.tables[0];
        expect(orders.columns).toEqual(expect.arrayContaining([{ name: "qty", type: "bigint", notNull: false }, { name: "qty__old", type: "integer", notNull: false }]));
        expect(orders.indexes).toEqual(expect.arrayContaining([{ name: "orders_qty_idx", columns: ["qty"], unique: false }, { name: "orders_qty_idx__old", columns: ["qty__old"], unique: false }]));
    });

    it("reports every kind of difference, in words", () => {
        const before = tables();
        const expected = expectedState(before.tables, before.tables);
        // the database as it turned out: the type changed, the index is gone and invalid ones and strangers appeared
        const actual = structuredClone(before);
        const real = actual.tables.get("public.orders")!;
        real.columns.find((column) => column.name === "qty")!.type = "bigint";
        real.columns.find((column) => column.name === "note")!.notNull = true;
        real.columns.push({ name: "stray", type: "text", typeSchema: "pg_catalog", notNull: false, default: null, generated: null, dependents: [], nullFraction: null, distinct: null });
        real.indexes = real.indexes.filter((index) => index.name !== "orders_qty_idx");
        real.indexes.push({ name: "orders_x_idx", definition: "", columns: ["note"], uses: ["note"], method: "btree", unique: false, primary: false, valid: false, partial: false, constraint: null, bytes: 0, scans: 0 });
        real.checks = [];
        actual.tables.delete("public.customers");
        const messages = diffExpected(expected, actual).map((mismatch) => mismatch.message);
        expect(messages).toEqual(expect.arrayContaining([
            "Column qty should be integer, but it is bigint.",
            "Column note should allow NULL, but it is NOT NULL.",
            "Column stray (text) exists, but the plan did not expect it.",
            "Index orders_qty_idx should exist, but it does not.",
            expect.stringMatching(/Index orders_x_idx exists but is INVALID|Index orders_x_idx exists, but the plan did not expect it/),
            "CHECK orders_qty_positive should exist, but it does not.",
            "public.customers should exist, but it does not.",
        ]));
    });

    it("says a table that should be gone still exists", () => {
        const before = tables();
        const expected = { tables: [], absent: ["public.customers"] };
        expect(diffExpected(expected, before)).toEqual([{ table: "public.customers", kind: "table", message: "public.customers should be gone, but it still exists." }]);
    });

    it("does not call a spelling of a type a difference", () => {
        const before = tables();
        const expected = expectedState(before.tables, before.tables);
        const actual = structuredClone(before);
        expected.tables.find((t) => t.qualified === "public.orders")!.columns.find((c) => c.name === "customer_id")!.type = "int8";
        expect(diffExpected(expected, actual)).toEqual([]);
    });
});
