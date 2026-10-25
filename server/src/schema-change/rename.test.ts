import { describe, expect, it } from "vitest";
import { compile, facts, MIB, plan, table } from "./test-fixtures.js";
import type { Runbook } from "./runbook.js";

const orders = (overrides: Partial<Parameters<typeof table>[0]> = {}) =>
    table({
        name: "orders", rows: 5_000_000, bytes: 400 * MIB,
        columns: ["id:bigint:notnull", "customer_id:bigint:notnull", "qty:integer:notnull"],
        privileges: [
            { grantee: "app", privilege: "SELECT" }, { grantee: "app", privilege: "INSERT" }, { grantee: "app", privilege: "UPDATE" },
            { grantee: "reporting", privilege: "SELECT", grantable: true },
            { grantee: "PUBLIC", privilege: "SELECT" },
            { grantee: "owner_role", privilege: "SELECT", owner: true }, { grantee: "owner_role", privilege: "TRUNCATE", owner: true },
            { grantee: "etl", privilege: "TRUNCATE" },
        ],
        ...overrides,
    });
const rename = (options: Parameters<typeof compile>[2] = {}, ...tables: ReturnType<typeof table>[]) => compile(plan({ type: "rename_table", tableName: "orders", newName: "sales_orders" }), facts(orders(), ...tables), options);
const errors = (runbook: Runbook) => runbook.findings.filter((finding) => finding.severity === "error").map((finding) => finding.code);

describe("renaming a table without breaking its callers", () => {
    it("renames it and leaves a view under the old name, in one step, with the old grants", () => {
        const runbook = rename();
        expect(errors(runbook)).toEqual([]);
        const [step, contract] = runbook.steps;
        expect(step.title).toBe("Rename table public.orders to sales_orders, and keep orders working as a view");
        expect(step.breaksClients).toBe(false);
        const statements = step.sql.replace(/^[\s\S]*?DO \$retry\$[\s\S]*?-- goforge:retry-begin\n/, "").split("-- goforge:retry-end")[0].split("\n").map((line) => line.trim()).filter(Boolean);
        expect(statements).toEqual([
            "ALTER TABLE public.orders RENAME TO sales_orders;",
            "CREATE VIEW public.orders WITH (security_invoker = true) AS SELECT * FROM public.sales_orders;",
            "GRANT SELECT, INSERT, UPDATE ON public.orders TO app;",
            "GRANT SELECT ON public.orders TO reporting WITH GRANT OPTION;",
            "GRANT SELECT ON public.orders TO PUBLIC;",
        ]);
        expect(step.notes.join(" ")).toMatch(/Grants of TRUNCATE are not copied/);
        expect(step.notes.join(" ")).toMatch(/security_invoker/);
        expect(step.undo).toContain("DROP VIEW public.orders;\nALTER TABLE public.sales_orders RENAME TO orders;");
        expect(contract).toMatchObject({ optional: true, breaksClients: true });
        expect(contract.sql).toContain("DROP VIEW public.orders;");
    });

    it("wraps the rename and the view in the lock retry, so they are retried and stay one transaction", () => {
        const step = rename().steps[0];
        expect(step.sql).toContain("DO $retry$");
        expect(step.sql.indexOf("RENAME TO sales_orders")).toBeLessThan(step.sql.indexOf("CREATE VIEW"));
    });

    it("leaves out security_invoker before PostgreSQL 15, where it does not exist", () => {
        const old = facts(orders());
        old.serverVersionNum = 140000;
        const runbook = compile(plan({ type: "rename_table", tableName: "orders", newName: "sales_orders" }), old);
        expect(runbook.steps[0].sql).toContain("CREATE VIEW public.orders AS SELECT * FROM public.sales_orders;");
        expect(runbook.steps[0].sql).not.toContain("security_invoker");
    });

    it("refuses before PostgreSQL 15 when the table has row-level security, because the view would run as its owner", () => {
        const old = facts(orders({ rowSecurity: true }));
        old.serverVersionNum = 140000;
        const runbook = compile(plan({ type: "rename_table", tableName: "orders", newName: "sales_orders" }), old);
        expect(errors(runbook)).toEqual(["unsupported"]);
        expect(runbook.findings.find((finding) => finding.code === "unsupported")?.message).toMatch(/row-level security/);
        // from 15 the view runs with the caller's rights, so it is fine
        expect(errors(compile(plan({ type: "rename_table", tableName: "orders", newName: "sales_orders" }), facts(orders({ rowSecurity: true }))))).toEqual([]);
    });

    it("renames directly when compatibility views are off, and for a table the plan itself creates", () => {
        const direct = rename({ settings: { compatViews: false } });
        expect(direct.steps).toHaveLength(1);
        expect(direct.steps[0]).toMatchObject({ breaksClients: true });
        expect(direct.steps[0].sql).not.toContain("CREATE VIEW");
        const created = compile(plan({ type: "create_table", table: { name: "events", fields: [{ name: "id", dataType: "bigint", primaryKey: true }] } }, { type: "rename_table", tableName: "events", newName: "audit_events" }), facts());
        expect(errors(created)).toEqual([]);
        expect(created.steps.every((step) => !step.sql.includes("CREATE VIEW"))).toBe(true);
    });

    it("tells later steps that a view now depends on the columns, and expects the old name as a view", () => {
        const runbook = compile(plan({ type: "rename_table", tableName: "orders", newName: "sales_orders" }, { type: "alter_column", tableName: "sales_orders", columnName: "qty", changes: { dataType: "bigint" } }), facts(orders()));
        expect(errors(runbook)).toEqual(["dependents"]);
        expect(runbook.findings.find((finding) => finding.code === "dependents")?.message).toContain("view public.orders");
        const ok = rename();
        expect(ok.expected.tables.find((t) => t.qualified === "public.sales_orders")?.views).toEqual(["public.orders"]);
        expect(ok.expected.absent).toEqual(["public.orders"]);
    });

    it("refuses to create something else under the old name in the same plan", () => {
        const runbook = compile(plan({ type: "rename_table", tableName: "orders", newName: "sales_orders" }, { type: "create_table", table: { name: "orders", fields: [{ name: "id", dataType: "bigint", primaryKey: true }] } }), facts(orders()));
        expect(errors(runbook)).toEqual(["name-taken"]);
    });
});
