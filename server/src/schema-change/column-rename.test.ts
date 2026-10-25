import { describe, expect, it } from "vitest";
import { compile, facts, MIB, plan, table } from "./test-fixtures.js";
import type { Runbook } from "./runbook.js";

const orders = (overrides: Partial<Parameters<typeof table>[0]> = {}) =>
    table({
        name: "orders", rows: 5_000_000, bytes: 400 * MIB,
        columns: ["id:bigint:notnull", "status:character varying(20):notnull", "note:text"],
        indexes: [{ name: "orders_status_idx", columns: ["status"], scans: 9 }, { name: "orders_open_idx", columns: ["status"], partial: true }],
        ...overrides,
    });
const rename = (column: string, newName: string, extra: Record<string, unknown> = {}, tables = [orders()], options: Parameters<typeof compile>[2] = {}) =>
    compile(plan({ type: "alter_column", tableName: "orders", columnName: column, changes: { newName, ...extra } }), facts(...tables), options);
const errors = (runbook: Runbook) => runbook.findings.filter((finding) => finding.severity === "error").map((finding) => finding.code);

describe("renaming a column and keeping the old name working", () => {
    it("adds the new column, keeps the two in step, copies the data and the index, and leaves the old column for a last step", () => {
        const runbook = rename("status", "state");
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps.filter((step) => !step.optional).map((step) => step.title)).toEqual([
            "Expand: add state (character varying(20)) next to public.orders.status",
            "Expand: keep state and status in step",
            "Expand: copy status into state",
            "Check that state matches status",
            "Expand: build the copy of index orders_status_idx on state",
            "Add a NOT VALID check that public.orders.state is not null",
            "Validate that no row of public.orders.state is null",
            "Set public.orders.state NOT NULL",
            "Drop the helper check on public.orders.state",
        ]);
        const sync = { ...runbook.steps[1], sql: runbook.steps[1].sql.replace(/\s+/g, " ") };
        expect(sync.sql).toContain("CREATE OR REPLACE FUNCTION public.orders_status_state__sync()");
        expect(sync.sql).toContain("IF NEW.state IS NOT NULL THEN NEW.status := NEW.state; ELSE NEW.state := NEW.status; END IF;");
        expect(sync.sql).toContain("ELSIF NEW.status IS DISTINCT FROM OLD.status THEN NEW.state := NEW.status;");
        expect(sync.sql).toContain("ELSIF NEW.state IS DISTINCT FROM OLD.state THEN NEW.status := NEW.state;");
        expect(sync.sql).toContain("CREATE TRIGGER orders_status_state__sync BEFORE INSERT OR UPDATE OF status, state ON public.orders FOR EACH ROW EXECUTE FUNCTION public.orders_status_state__sync();");
        expect(runbook.steps.some((step) => step.sql.includes("CREATE INDEX CONCURRENTLY orders_state_idx ON public.orders (state);"))).toBe(true);
        const contract = runbook.steps.find((step) => step.optional)!;
        expect(contract).toMatchObject({ destructive: true, breaksClients: true });
        expect(contract.sql).toContain("DROP TRIGGER orders_status_state__sync ON public.orders;");
        expect(contract.sql).toContain("ALTER TABLE public.orders DROP COLUMN status;");
        expect(runbook.steps.every((step) => !step.breaksClients || step.optional)).toBe(true);
        expect(runbook.findings.map((finding) => finding.code)).toContain("index-not-copied");
    });

    it("expects both columns and the copied index after the steps that run by default", () => {
        const expected = rename("status", "state").expected.tables[0];
        expect(expected.columns).toEqual(expect.arrayContaining([{ name: "status", type: "character varying(20)", notNull: true }, { name: "state", type: "character varying(20)", notNull: true }]));
        expect(expected.indexes.map((index) => index.name)).toEqual(expect.arrayContaining(["orders_status_idx", "orders_state_idx"]));
    });

    it("gives the new column the old default only in the last step", () => {
        const withDefault = orders();
        withDefault.columns[1].default = "'new'::character varying";
        const runbook = rename("status", "state", {}, [withDefault]);
        expect(runbook.steps.filter((step) => !step.optional).some((step) => step.sql.includes("SET DEFAULT"))).toBe(false);
        expect(runbook.steps.find((step) => step.optional)?.sql).toContain("ALTER TABLE public.orders ALTER COLUMN state SET DEFAULT 'new'::character varying;");
    });

    it("renames directly when compatColumns is off, and for a table the plan creates", () => {
        const direct = rename("status", "state", {}, [orders()], { settings: { compatColumns: false } });
        expect(direct.steps).toHaveLength(1);
        expect(direct.steps[0]).toMatchObject({ breaksClients: true });
        expect(direct.steps[0].sql).toContain("RENAME COLUMN status TO state;");
        const created = compile(plan({ type: "create_table", table: { name: "audit", fields: [{ name: "id", dataType: "bigint", primaryKey: true }, { name: "kind", dataType: "text" }] } }, { type: "alter_column", tableName: "audit", columnName: "kind", changes: { newName: "category" } }), facts());
        expect(errors(created)).toEqual([]);
        expect(created.steps.some((step) => step.sql.includes("RENAME COLUMN kind TO category;"))).toBe(true);
    });

    it("refuses a column in a key, a foreign key or a check, one a view uses, a generated one, a partitioned table, other changes in the same operation and a name that is taken", () => {
        expect(errors(rename("id", "order_id"))).toEqual(["unsupported"]);
        const fk = orders({ foreignKeys: [{ name: "orders_note_fk", columns: ["note"], ref: "notes", refColumns: ["id"] }] });
        expect(errors(rename("note", "memo", {}, [fk, table({ name: "notes", columns: ["id:text:notnull"] })]))).toEqual(["unsupported"]);
        expect(errors(rename("status", "state", {}, [orders({ checks: [{ name: "orders_status_ck", definition: "CHECK ((status <> ''))", columns: ["status"] }] })]))).toEqual(["unsupported"]);
        expect(errors(rename("status", "state", {}, [orders({ dependents: [{ column: "status", kind: "view", description: "view public.open_orders", external: true }] })]))).toEqual(["dependents"]);
        const generated = orders();
        generated.columns[2].generated = "stored";
        expect(errors(rename("note", "memo", {}, [generated]))).toEqual(["unsupported"]);
        expect(errors(rename("status", "state", {}, [orders({ partitions: ["public.orders_1"] })]))).toEqual(["unsupported"]);
        expect(errors(rename("status", "state", { nullable: true }))).toEqual(["unsupported"]);
        expect(errors(rename("status", "note"))).toEqual(["column-exists"]);
    });
});
