import { describe, expect, it } from "vitest";
import { compile, facts, MIB, plan, table } from "./test-fixtures.js";
import type { Runbook } from "./runbook.js";

const orders = (overrides: Partial<Parameters<typeof table>[0]> = {}) =>
    table({
        name: "orders", rows: 5_000_000, bytes: 400 * MIB,
        columns: ["id:bigint:notnull", "customer_id:bigint:notnull", "email:text", "qty:integer:notnull", "total:numeric(12,2)"],
        ...overrides,
    });
const errors = (runbook: Runbook) => runbook.findings.filter((finding) => finding.severity === "error").map((finding) => finding.code);
const sql = (runbook: Runbook) => runbook.steps.map((step) => step.sql).join("\n");

describe("add_unique", () => {
    it("builds the unique index without blocking writes, then attaches it as the constraint", () => {
        const runbook = compile(plan({ type: "add_unique", tableName: "orders", columns: ["email"] }), facts(orders()));
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps.map((step) => step.title)).toEqual(["Build a unique index on public.orders(email)", "Attach the index as a unique constraint on public.orders(email)"]);
        expect(sql(runbook)).toContain("CREATE UNIQUE INDEX CONCURRENTLY orders_email_key ON public.orders (email);");
        expect(sql(runbook)).toContain("ADD CONSTRAINT orders_email_key UNIQUE USING INDEX orders_email_key;");
        expect(runbook.expected.tables[0].uniques).toEqual([{ name: "orders_email_key", columns: ["email"] }]);
    });

    it("uses the name it is given, for the constraint and its index", () => {
        const runbook = compile(plan({ type: "add_unique", tableName: "orders", constraintName: "orders_one_email", columns: ["customer_id", "email"] }), facts(orders()));
        expect(errors(runbook)).toEqual([]);
        expect(sql(runbook)).toContain("CREATE UNIQUE INDEX CONCURRENTLY orders_one_email ON public.orders (customer_id, email);");
        expect(sql(runbook)).toContain("ADD CONSTRAINT orders_one_email UNIQUE USING INDEX orders_one_email;");
        expect(compile(plan({ type: "add_unique", tableName: "orders", constraintName: "orders_pkey", columns: ["email"] }), facts(orders())).findings.map((finding) => finding.code)).toContain("name-taken");
    });

    it("says so when the columns are already unique, and refuses unknown or repeated columns", () => {
        expect(compile(plan({ type: "add_unique", tableName: "orders", columns: ["id"] }), facts(orders())).steps).toHaveLength(0);
        expect(compile(plan({ type: "add_unique", tableName: "orders", columns: ["id"] }), facts(orders())).findings.map((finding) => finding.code)).toContain("no-change");
        expect(errors(compile(plan({ type: "add_unique", tableName: "orders", columns: ["nope"] }), facts(orders())))).toEqual(["unknown-column"]);
        expect(errors(compile(plan({ type: "add_unique", tableName: "orders", columns: ["email", "EMAIL"] }), facts(orders())))).toEqual(["duplicate-column"]);
    });
});

describe("add_check", () => {
    const add = (expression: string, extra: Record<string, unknown> = {}, rows = 5_000_000) => compile(plan({ type: "add_check", tableName: "orders", expression, ...extra }), facts(orders({ rows, bytes: rows === 0 ? 0 : 400 * MIB })));

    it("adds it NOT VALID, then validates without blocking writes", () => {
        const runbook = add("qty > 0");
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps.map((step) => [step.lock, step.work])).toEqual([["ACCESS EXCLUSIVE", "metadata"], ["SHARE UPDATE EXCLUSIVE", "scan"]]);
        expect(sql(runbook)).toContain("ADD CONSTRAINT orders_check CHECK (qty > 0) NOT VALID;");
        expect(sql(runbook)).toContain("VALIDATE CONSTRAINT orders_check;");
        expect(runbook.expected.tables[0].checks).toEqual([{ name: "orders_check", validated: true }]);
    });

    it("is one step on an empty table, and takes the name it is given", () => {
        const runbook = add("qty > 0", { constraintName: "orders_qty_positive" }, 0);
        expect(runbook.steps).toHaveLength(1);
        expect(sql(runbook)).toContain("ADD CONSTRAINT orders_qty_positive CHECK (qty > 0);");
    });

    it("refuses what is not one plain boolean expression", () => {
        for (const expression of ["qty > 0; DROP TABLE orders", "qty > 0 -- comment", "(SELECT 1) = 1", "qty > 0)) OR ((1=1"]) {
            expect(errors(add(expression)), expression).toEqual(["bad-check"]);
        }
    });

    it("asks the database, and reports what it says", () => {
        const runbook = compile(plan({ type: "add_check", tableName: "orders", expression: "no_such > 0" }), facts(orders()), { rejectedChecks: { "no_such > 0": 'column "no_such" does not exist' } });
        expect(errors(runbook)).toEqual(["bad-check"]);
        expect(runbook.findings.find((finding) => finding.code === "bad-check")?.message).toContain('column "no_such" does not exist');
    });

    it("allows immutable functions only", () => {
        expect(errors(add("lower(email) = email"))).toEqual([]);
        expect(errors(add("random() < 2"))).toEqual(["bad-check"]);
        expect(errors(add("shipped_at < now()"))).toEqual(["bad-check"]);
        expect(add("shipped_at < now()").findings.find((finding) => finding.code === "bad-check")?.message).toContain("not immutable");
        expect(add("mystery(email)").findings.find((finding) => finding.code === "bad-check")?.message).toContain("which PostgreSQL does not have");
    });

    it("is known to later steps: dropping a column it uses takes it along, and says so", () => {
        const runbook = compile(plan({ type: "add_check", tableName: "orders", expression: "qty > 0 AND total >= 0" }, { type: "drop_column", tableName: "orders", columnName: "total" }), facts(orders()));
        expect(errors(runbook)).toEqual([]);
        const drop = runbook.steps.find((step) => step.title.startsWith("Drop column"));
        expect(drop?.notes.join(" ")).toContain("CHECK constraint dropped with it: orders_check.");
        expect(runbook.expected.tables[0].checks).toEqual([]);
    });
});

describe("drop_constraint", () => {
    const withConstraints = () =>
        orders({
            uniques: [{ name: "orders_email_key", columns: ["email"] }],
            indexes: [{ name: "orders_email_key", columns: ["email"], unique: true, constraint: "orders_email_key", scans: 7 }],
            checks: [{ name: "orders_qty_positive", definition: "CHECK ((qty > 0))", columns: ["qty"] }],
            foreignKeys: [{ name: "orders_customer_fk", columns: ["customer_id"], ref: "customers", refColumns: ["id"] }],
        });
    const customers = () => table({ name: "customers", columns: ["id:bigint:notnull"] });
    const drop = (constraintName: string, ...others: ReturnType<typeof table>[]) => compile(plan({ type: "drop_constraint", tableName: "orders", constraintName }), facts(withConstraints(), customers(), ...others));

    it("drops a check, and tells how to put it back", () => {
        const runbook = drop("orders_qty_positive");
        expect(errors(runbook)).toEqual([]);
        expect(sql(runbook)).toContain("ALTER TABLE public.orders DROP CONSTRAINT orders_qty_positive;");
        expect(runbook.steps[0].notes.join(" ")).toContain("ADD CONSTRAINT orders_qty_positive CHECK ((qty > 0));");
        expect(runbook.expected.tables.find((t) => t.qualified === "public.orders")?.checks).toEqual([]);
    });

    it("drops a unique constraint with its index, and says the index is in use", () => {
        const runbook = drop("orders_email_key");
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps[0].notes.join(" ")).toMatch(/scanned 7 times/);
        const orders_ = runbook.expected.tables.find((t) => t.qualified === "public.orders")!;
        expect(orders_.uniques).toEqual([]);
        expect(orders_.indexes.map((index) => index.name)).not.toContain("orders_email_key");
    });

    it("refuses a unique key that another table's foreign key points at", () => {
        const child = table({ name: "emails", columns: ["id:bigint:notnull", "address:text"], foreignKeys: [{ name: "emails_fk", columns: ["address"], ref: "orders", refColumns: ["email"] }] });
        expect(errors(drop("orders_email_key", child))).toEqual(["referenced"]);
    });

    it("refuses the primary key, a foreign key, and a name that is not there", () => {
        expect(errors(drop("orders_pkey"))).toEqual(["primary-key-constraint"]);
        expect(errors(drop("orders_customer_fk"))).toEqual(["foreign-key-constraint"]);
        expect(errors(drop("nothing_here"))).toEqual(["unknown-constraint"]);
    });
});

describe("add_primary_key", () => {
    const heap = (overrides: Partial<Parameters<typeof table>[0]> = {}) =>
        table({ name: "events", rows: 5_000_000, bytes: 400 * MIB, columns: ["event_id:bigint", "kind:text", "at:timestamp with time zone:notnull"], primaryKey: [], ...overrides });
    const add = (operation: Record<string, unknown>, ...tables: ReturnType<typeof table>[]) => compile(plan({ type: "add_primary_key", tableName: "events", ...operation }), facts(...(tables.length ? tables : [heap()])));

    it("makes the columns NOT NULL first, builds a unique index without blocking writes, then attaches it", () => {
        const runbook = add({ columns: ["event_id"] });
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps.map((step) => step.title)).toEqual([
            "Add a NOT VALID check that public.events.event_id is not null",
            "Validate that no row of public.events.event_id is null",
            "Set public.events.event_id NOT NULL",
            "Drop the helper check on public.events.event_id",
            "Build a unique index for the primary key of public.events(event_id)",
            "Make the index the primary key of public.events",
        ]);
        expect(sql(runbook)).toContain("CREATE UNIQUE INDEX CONCURRENTLY events_pkey ON public.events (event_id);");
        expect(sql(runbook)).toContain("ADD CONSTRAINT events_pkey PRIMARY KEY USING INDEX events_pkey;");
        const expected = runbook.expected.tables[0];
        expect(expected.primaryKey).toEqual(["event_id"]);
        expect(expected.columns.find((column) => column.name === "event_id")?.notNull).toBe(true);
    });

    it("skips the NOT NULL steps for columns that already are, and covers several columns", () => {
        const runbook = add({ constraintName: "events_pk", columns: ["at", "event_id"] });
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps.some((step) => step.title.includes("public.events.at is not null"))).toBe(false);
        expect(sql(runbook)).toContain("CREATE UNIQUE INDEX CONCURRENTLY events_pk ON public.events (at, event_id);");
        expect(runbook.expected.tables[0].primaryKey).toEqual(["at", "event_id"]);
    });

    it("is one step on a table the plan creates", () => {
        const runbook = compile(plan({ type: "create_table", table: { name: "audit", fields: [{ name: "id", dataType: "bigint" }, { name: "note", dataType: "text" }] } }, { type: "add_primary_key", tableName: "audit", columns: ["id"] }), facts());
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps.map((step) => step.sql).join("\n")).toContain("ADD CONSTRAINT audit_pkey PRIMARY KEY (id);");
    });

    it("lets a later foreign key point at the new key", () => {
        const child = table({ name: "event_notes", rows: 10, columns: ["id:bigint:notnull", "event_id:bigint"] });
        const runbook = compile(plan({ type: "add_primary_key", tableName: "events", columns: ["event_id"] }, { type: "add_relationship", relationship: { sourceTable: "events", sourceColumn: "event_id", targetTable: "event_notes", targetColumn: "event_id" } }), facts(heap(), child));
        expect(errors(runbook)).toEqual([]);
    });

    it("refuses a table that has a key, a partitioned table, and columns or names that are wrong", () => {
        expect(errors(add({ columns: ["id"] }, table({ name: "events", columns: ["id:bigint:notnull"] })))).toEqual(["has-primary-key"]);
        expect(errors(add({ columns: ["event_id"] }, heap({ partitions: ["public.events_1"] })))).toEqual(["unsupported"]);
        expect(errors(add({ columns: ["nope"] }))).toEqual(["unknown-column"]);
        expect(errors(add({ columns: ["event_id", "EVENT_ID"] }))).toEqual(["duplicate-column"]);
        expect(add({ constraintName: "events_idx", columns: ["event_id"] }, heap({ indexes: [{ name: "events_idx", columns: ["kind"] }] })).findings.map((finding) => finding.code)).toContain("name-taken");
    });
});
