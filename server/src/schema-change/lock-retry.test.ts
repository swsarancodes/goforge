import { describe, expect, it } from "vitest";
import { compile, facts, MIB, plan, table } from "./test-fixtures.js";
import { lintSteps } from "./lint.js";
import { canRetry, unwrapLockRetry, withLockRetry } from "./lock-retry.js";

const orders = () => table({ name: "orders", rows: 5_000_000, bytes: 400 * MIB, columns: ["id:bigint:notnull", "status:character varying(20):notnull", "qty:integer:notnull", "ref:text"], indexes: [{ name: "orders_qty_idx", columns: ["qty"], scans: 0 }] });
const addColumn = (settings?: { lockTimeoutSeconds?: number; lockAttempts?: number }) => compile(plan({ type: "add_column", tableName: "orders", field: { name: "note", dataType: "text" } }), facts(orders()), { settings });

describe("lock retry", () => {
    it("wraps a step that takes a strong lock on an existing table, and keeps the statement readable inside", () => {
        const runbook = addColumn();
        const [step] = runbook.steps;
        expect(step.sql).toMatch(/^SET lock_timeout = '2s';\nDO \$retry\$/);
        expect(step.sql).toContain("SET LOCAL lock_timeout = '2s';");
        expect(step.sql).toContain("IF attempt >= 8 THEN");
        expect(step.sql).toContain("to_regclass('public.orders')");
        expect(step.sql).toContain("ERRCODE = 'lock_not_available'");
        expect(unwrapLockRetry(step.sql)).toEqual({ wrapped: true, sql: "SET lock_timeout = '2s';\nALTER TABLE public.orders ADD COLUMN note text;" });
    });

    it("follows the settings, and does not wrap when attempts is 1", () => {
        expect(addColumn({ lockTimeoutSeconds: 3, lockAttempts: 4 }).steps[0].sql).toMatch(/SET LOCAL lock_timeout = '3s';[\s\S]*attempt >= 4/);
        const once = addColumn({ lockAttempts: 1 }).steps[0].sql;
        expect(once).toBe("SET lock_timeout = '2s';\nALTER TABLE public.orders ADD COLUMN note text;");
        expect(unwrapLockRetry(once).wrapped).toBe(false);
    });

    it("leaves alone what cannot or should not be retried: concurrent builds, batched backfills and new tables", () => {
        const concurrent = compile(plan({ type: "add_index", tableName: "orders", index: { name: "orders_ref_idx", columns: ["ref"] } }), facts(orders()));
        expect(concurrent.steps[0].sql).not.toContain("$retry$");
        const created = compile(plan({ type: "create_table", table: { name: "events", fields: [{ name: "id", dataType: "bigint", primaryKey: true }] } }), facts());
        expect(created.steps.every((step) => !step.sql.includes("$retry$"))).toBe(true);
        const notNull = compile(plan({ type: "alter_column", tableName: "orders", columnName: "ref", changes: { nullable: false } }), facts(orders()));
        const backfill = notNull.steps.filter((step) => step.work === "backfill");
        expect(backfill.every((step) => !step.sql.includes("$retry$"))).toBe(true);
        const dropped = compile(plan({ type: "drop_column", tableName: "orders", columnName: "ref" }), facts(orders()));
        expect(dropped.steps.some((step) => step.sql.includes("$retry$"))).toBe(true);
    });

    it("never wraps SQL that manages its own transaction or cannot run in a block", () => {
        for (const sql of ["CREATE INDEX CONCURRENTLY i ON t (a);", "VACUUM t;", "COMMIT;", "CALL p();", "DO $$ BEGIN NULL; END $$;", "SELECT 1; -- $retry$"]) expect(canRetry(sql), sql).toBe(false);
        expect(canRetry("ALTER TABLE t ADD COLUMN a int;")).toBe(true);
    });

    it("quotes the table names it looks at when it gives up", () => {
        const sql = withLockRetry("ALTER TABLE x DROP COLUMN y;", { lockTimeoutSeconds: 1, attempts: 2, tables: ['public."Odd ""Name"', "billing.invoices"] });
        expect(sql).toContain(`to_regclass('public."Odd ""Name"')::oid, to_regclass('billing.invoices')::oid`);
    });

    it("is still checked by the lint on the statements inside the block", () => {
        const swap = compile(plan({ type: "alter_column", tableName: "orders", columnName: "qty", changes: { dataType: "bigint" } }), facts(orders()));
        expect(swap.steps.some((step) => step.sql.includes("$retry$"))).toBe(true);
        expect(lintSteps(swap.steps).violations).toEqual([]);
        // a hand-edited step that does something risky inside the block is still caught
        const risky = { ...addColumn().steps[0], sql: withLockRetry("ALTER TABLE public.orders ADD CONSTRAINT c CHECK (qty > 0);", { lockTimeoutSeconds: 2, attempts: 8, tables: ["public.orders"] }) };
        expect(lintSteps([risky]).violations.map((violation) => violation.rule)).toEqual(["check-validated-inline"]);
    });
});
