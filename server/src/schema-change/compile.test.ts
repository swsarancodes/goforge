import { describe, expect, it } from "vitest";
import { compile, facts, GIB, MIB, plan, table } from "./test-fixtures.js";
import { lintSteps } from "./lint.js";
import { discoverProbes } from "./compile.js";
import type { Runbook, RunbookStep } from "./runbook.js";

const orders = (overrides: Partial<Parameters<typeof table>[0]> = {}) =>
    table({
        name: "orders",
        rows: 5_000_000,
        bytes: 400 * MIB,
        columns: ["id:bigint:notnull", "customer_id:bigint:notnull", "status:character varying(20):notnull", "total:numeric(12,2)", "qty:integer:notnull", "shipped_at:timestamp with time zone", "ref:text"],
        indexes: [{ name: "orders_status_idx", columns: ["status"], scans: 12 }, { name: "orders_qty_idx", columns: ["qty"], scans: 0 }],
        ...overrides,
    });
const customers = () => table({ name: "customers", rows: 100_000, bytes: 20 * MIB, columns: ["id:bigint:notnull", "email:text:notnull"] });

const sql = (runbook: Runbook) => runbook.steps.map((step) => step.sql).join("\n");
const errors = (runbook: Runbook) => runbook.findings.filter((finding) => finding.severity === "error").map((finding) => finding.code);
const titles = (runbook: Runbook) => runbook.steps.map((step) => step.title);

describe("index builds", () => {
    it("builds on an existing table without blocking writes, and says how to clean up after a failure", () => {
        const runbook = compile(plan({ type: "add_index", tableName: "orders", index: { name: "orders_customer_idx", columns: ["customer_id"] } }), facts(orders()));
        expect(errors(runbook)).toEqual([]);
        const [step] = runbook.steps;
        expect(step.sql).toContain("CREATE INDEX CONCURRENTLY orders_customer_idx ON public.orders (customer_id);");
        expect(step.sql).toContain("SET lock_timeout = 0;");
        expect(step).toMatchObject({ lock: "SHARE UPDATE EXCLUSIVE", work: "index-build", risk: "low", destructive: false });
        expect(step.notes.join(" ")).toMatch(/INVALID index/);
        expect(step.undo).toBe("DROP INDEX CONCURRENTLY public.orders_customer_idx;");
    });

    it("uses a plain CREATE INDEX on a table the same plan creates", () => {
        const runbook = compile(
            plan(
                { type: "create_table", table: { name: "events", fields: [{ name: "id", dataType: "bigint", primaryKey: true }, { name: "at", dataType: "timestamptz" }] } },
                { type: "add_index", tableName: "events", index: { name: "events_at_idx", columns: ["at"] } },
            ),
            facts(),
        );
        expect(errors(runbook)).toEqual([]);
        expect(sql(runbook)).toContain("CREATE INDEX events_at_idx ON public.events (at);");
        expect(sql(runbook)).not.toContain("CONCURRENTLY");
    });

    it("builds a partitioned table's index partition by partition", () => {
        const partitioned = table({ name: "events", rows: 9_000_000, bytes: 3 * GIB, columns: ["id:bigint:notnull", "at:timestamp with time zone"], partitions: ["public.events_2026_01", "public.events_2026_02"] });
        const runbook = compile(plan({ type: "add_index", tableName: "events", index: { name: "events_at_idx", columns: ["at"] } }), facts(partitioned));
        expect(errors(runbook)).toEqual([]);
        const text = runbook.steps[0].sql;
        expect(text).toContain("CREATE INDEX events_at_idx ON ONLY public.events (at);");
        expect(text).toContain("CREATE INDEX CONCURRENTLY events_2026_01_at_idx ON public.events_2026_01 (at);");
        expect(text).toContain("ALTER INDEX public.events_at_idx ATTACH PARTITION public.events_2026_01_at_idx;");
        expect(text).toContain("ATTACH PARTITION public.events_2026_02_at_idx;");
    });

    it("warns about an index that already exists or is already covered, and refuses a name that is taken", () => {
        const duplicate = compile(plan({ type: "add_index", tableName: "orders", index: { name: "orders_status_2", columns: ["status"] } }), facts(orders()));
        expect(duplicate.findings.map((f) => f.code)).toContain("duplicate-index");

        const covered = compile(
            plan({ type: "add_index", tableName: "orders", index: { name: "orders_cust", columns: ["customer_id"] } }),
            facts(orders({ indexes: [{ name: "orders_cust_status", columns: ["customer_id", "status"] }] })),
        );
        expect(covered.findings.map((f) => f.code)).toContain("covered-index");

        const taken = compile(plan({ type: "add_index", tableName: "orders", index: { name: "orders_qty_idx", columns: ["customer_id"] } }), facts(orders()));
        expect(errors(taken)).toEqual(["name-taken"]);
        expect(taken.uncompiled).toEqual([0]);

        const existingElsewhere = compile(plan({ type: "add_index", tableName: "orders", index: { name: "somewhere_else", columns: ["customer_id"] } }), facts(orders()), { existing: ["public.somewhere_else"] });
        expect(errors(existingElsewhere)).toEqual(["name-taken"]);
    });

    it("drops an index without a lock, keeps its definition for undoing, and warns when it was used", () => {
        const runbook = compile(plan({ type: "drop_index", tableName: "orders", indexName: "orders_status_idx" }), facts(orders()));
        expect(runbook.steps[0].sql).toContain("DROP INDEX CONCURRENTLY public.orders_status_idx;");
        expect(runbook.findings.find((f) => f.code === "used-index")?.message).toMatch(/scanned 12 times/);
        expect(errors(compile(plan({ type: "drop_index", tableName: "orders", indexName: "orders_pkey" }), facts(orders())))).toEqual(["constraint-index"]);
    });
});

describe("foreign keys", () => {
    const child = () => table({ name: "order_items", rows: 20_000_000, bytes: 2 * GIB, columns: ["id:bigint:notnull", "order_id:bigint", "sku:text"] });
    const relationship = { type: "add_relationship", relationship: { sourceTable: "orders", sourceColumn: "id", targetTable: "order_items", targetColumn: "order_id", onDelete: "cascade" } };

    it("adds the key NOT VALID, validates it separately, and suggests the index on the child column", () => {
        const runbook = compile(plan(relationship), facts(orders(), child()));
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps.map((s) => [s.lock, s.work])).toEqual([["SHARE ROW EXCLUSIVE", "metadata"], ["SHARE UPDATE EXCLUSIVE", "scan"], ["SHARE UPDATE EXCLUSIVE", "index-build"]]);
        expect(runbook.steps[0].sql).toContain("ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders (id) ON DELETE CASCADE NOT VALID;");
        expect(runbook.steps[0].alsoLocks).toEqual(["public.orders"]);
        expect(runbook.steps[1].sql).toContain("VALIDATE CONSTRAINT order_items_order_id_fkey;");
        expect(runbook.steps[1].notes.join(" ")).toMatch(/LEFT JOIN/);
        expect(runbook.steps[2].sql).toContain("CREATE INDEX CONCURRENTLY order_items_order_id_idx ON public.order_items (order_id);");
        expect(runbook.steps[2].notes[0]).toMatch(/Recommended, not required/);
    });

    it("skips the index step when the column is already indexed", () => {
        const indexed = table({ name: "order_items", rows: 20_000_000, bytes: 2 * GIB, columns: ["id:bigint:notnull", "order_id:bigint"], indexes: [{ name: "oi_order", columns: ["order_id"] }] });
        expect(compile(plan(relationship), facts(orders(), indexed)).steps).toHaveLength(2);
    });

    it("adds the key in one step when the child table is empty or new", () => {
        const empty = table({ name: "order_items", rows: 0, bytes: 0, columns: ["id:bigint:notnull", "order_id:bigint"] });
        const runbook = compile(plan(relationship), facts(orders(), empty));
        expect(runbook.steps[0].sql).not.toContain("NOT VALID");
        expect(runbook.steps[0].sql).toContain("ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY");
    });

    it("refuses mismatched types, a parent column that isn't unique, and a key that exists", () => {
        const wrongType = table({ name: "order_items", rows: 10, columns: ["id:bigint:notnull", "order_id:text"] });
        expect(errors(compile(plan(relationship), facts(orders(), wrongType)))).toEqual(["type-mismatch"]);

        const notUnique = { type: "add_relationship", relationship: { sourceTable: "orders", sourceColumn: "customer_id", targetTable: "order_items", targetColumn: "order_id" } };
        expect(errors(compile(plan(notUnique), facts(orders(), child())))).toEqual(["not-unique"]);

        const existing = table({ name: "order_items", rows: 10, columns: ["id:bigint:notnull", "order_id:bigint"], foreignKeys: [{ columns: ["order_id"], ref: "orders", refColumns: ["id"] }] });
        expect(errors(compile(plan(relationship), facts(orders(), existing)))).toEqual(["relationship-exists"]);
    });

    it("drops a key by the name the database has for it, and says the other table is locked too", () => {
        const withKey = table({ name: "order_items", rows: 10_000_000, bytes: GIB, columns: ["id:bigint:notnull", "order_id:bigint"], foreignKeys: [{ name: "order_items_fk", columns: ["order_id"], ref: "orders", refColumns: ["id"] }] });
        const runbook = compile(plan({ type: "drop_relationship", sourceTable: "orders", sourceColumn: "id", targetTable: "order_items", targetColumn: "order_id" }), facts(orders(), withKey));
        expect(runbook.steps[0].sql).toContain("DROP CONSTRAINT order_items_fk;");
        expect(runbook.steps[0]).toMatchObject({ lock: "ACCESS EXCLUSIVE", alsoLocks: ["public.orders"] });
        expect(runbook.steps[0].undo).toContain("NOT VALID");
    });
});

describe("NOT NULL", () => {
    const op = { type: "alter_column", tableName: "orders", columnName: "ref", changes: { nullable: false } };

    it("goes through a validated CHECK on a table of this size", () => {
        const runbook = compile(plan(op), facts(orders()));
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps.map((s) => s.sql.split("\n").at(-1))).toEqual([
            "ALTER TABLE public.orders ADD CONSTRAINT orders_ref_not_null CHECK (ref IS NOT NULL) NOT VALID;",
            "ALTER TABLE public.orders VALIDATE CONSTRAINT orders_ref_not_null;",
            "ALTER TABLE public.orders ALTER COLUMN ref SET NOT NULL;",
            "ALTER TABLE public.orders DROP CONSTRAINT orders_ref_not_null;",
        ]);
        expect(runbook.steps[1]).toMatchObject({ lock: "SHARE UPDATE EXCLUSIVE", work: "scan", risk: "low" });
    });

    it("is a single statement on a small table", () => {
        const runbook = compile(plan(op), facts(orders({ bytes: 2 * MIB, rows: 1000 })));
        expect(runbook.steps).toHaveLength(1);
        expect(runbook.steps[0].sql).toContain("ALTER TABLE public.orders ALTER COLUMN ref SET NOT NULL;");
    });

    it("warns when the statistics say there are NULLs", () => {
        const withNulls = orders();
        withNulls.columns.find((c) => c.name === "ref")!.nullFraction = 0.25;
        const runbook = compile(plan(op), facts(withNulls));
        expect(runbook.findings.find((f) => f.code === "has-nulls")?.message).toMatch(/25\.0%/);
    });

    it("refuses to make a primary key column nullable", () => {
        expect(errors(compile(plan({ type: "alter_column", tableName: "orders", columnName: "id", changes: { nullable: true } }), facts(orders())))).toEqual(["primary-key-column"]);
    });
});

describe("type changes", () => {
    const change = (changes: Record<string, unknown>, column = "status") => plan({ type: "alter_column", tableName: "orders", columnName: column, changes });

    it("changes the catalog only when PostgreSQL only has to", () => {
        const runbook = compile(change({ dataType: "varchar", maxLength: 50 }), facts(orders()));
        expect(runbook.steps).toHaveLength(1);
        expect(runbook.steps[0]).toMatchObject({ work: "metadata", lock: "ACCESS EXCLUSIVE", risk: "low" });
        expect(runbook.steps[0].sql).toContain("ALTER COLUMN status TYPE varchar(50);");
        expect(runbook.steps[0].undo).toContain("TYPE character varying(20)");
    });

    it("rewrites a small table in place, and says so", () => {
        const runbook = compile(change({ dataType: "bigint" }, "qty"), facts(orders({ bytes: 2 * MIB, rows: 1000 })));
        expect(runbook.steps).toHaveLength(1);
        expect(runbook.steps[0]).toMatchObject({ work: "rewrite", risk: "medium" });
        expect(runbook.findings.map((f) => f.code)).toContain("rewrite");
    });

    it("uses expand and contract on a large table: copy in batches, keep in step, swap atomically, drop later", () => {
        const runbook = compile(change({ dataType: "bigint" }, "qty"), facts(orders({ bytes: 5 * GIB })));
        expect(errors(runbook)).toEqual([]);
        expect(titles(runbook)).toEqual([
            "Expand: add qty__new (bigint) next to public.orders.qty",
            "Expand: keep qty__new in step with qty",
            "Expand: copy qty into qty__new",
            "Check that qty__new matches qty",
            "Expand: build the copy of index orders_qty_idx on qty__new",
            "Add a NOT VALID check that public.orders.qty__new is not null",
            "Validate that no row of public.orders.qty__new is null",
            "Set public.orders.qty__new NOT NULL",
            "Drop the helper check on public.orders.qty__new",
            "Swap: qty__new becomes qty",
            "Contract: drop the old column qty__old and the sync function",
        ]);
        const text = sql(runbook);
        expect(text).toContain("ADD COLUMN qty__new bigint;");
        expect(text).toContain("CREATE TRIGGER orders_qty__sync BEFORE INSERT OR UPDATE OF qty ON public.orders FOR EACH ROW");
        expect(text).toContain("DO $backfill$");
        expect(text).toContain("qty__new = qty::bigint");
        expect(text).toContain("CREATE INDEX CONCURRENTLY orders_qty_idx__new ON public.orders (qty__new);");
        expect(text).toContain("ALTER INDEX public.orders_qty_idx__new RENAME TO orders_qty_idx;");
        const swap = runbook.steps.find((s) => s.title.startsWith("Swap"));
        expect(swap?.sql).toContain("DO $swap$");
        expect(swap?.sql).toContain("SET LOCAL lock_timeout = '5s';");
        expect(swap?.sql).toContain("RENAME COLUMN qty TO qty__old;");
        const contract = runbook.steps.at(-1);
        expect(contract).toMatchObject({ optional: true, destructive: true });
        expect(contract?.sql).toContain("DROP COLUMN qty__old");
        // nothing rewrites the table and no step is high risk; the brief ACCESS EXCLUSIVE steps and the sustained backfill are "medium" on a table this size
        expect(runbook.steps.filter((s) => s.work === "rewrite")).toEqual([]);
        expect(runbook.steps.filter((s) => s.risk === "high" && !s.optional)).toEqual([]);
        expect(runbook.steps.find((s) => s.work === "backfill")?.risk).toBe("medium");
        expect(runbook.findings.find((f) => f.code === "rewrite")?.message).toMatch(/expand\/contract/);
    });

    it("won't change the type of a key column or a column in a foreign key on a large table, or under a view", () => {
        expect(errors(compile(change({ dataType: "text" }, "id"), facts(orders({ bytes: 5 * GIB }))))).toEqual(["unsupported"]);
        const withView = orders({ bytes: 5 * GIB, views: ["public.open_orders"] });
        expect(errors(compile(change({ dataType: "bigint" }, "qty"), facts(withView)))).toEqual(["dependent-views"]);
        const keyed = orders({ bytes: 5 * GIB, foreignKeys: [{ columns: ["qty"], ref: "customers", refColumns: ["id"] }] });
        expect(errors(compile(change({ dataType: "bigint" }, "qty"), facts(keyed, customers())))).toEqual(["unsupported"]);
    });

    it("needs a key to batch on, and uses pages on PostgreSQL 14+ when there is none", () => {
        const keyless = orders({ bytes: 5 * GIB, primaryKey: [], indexes: [] });
        keyless.indexes = [];
        const runbook = compile(change({ dataType: "bigint" }, "qty"), facts(keyless));
        expect(errors(runbook)).toEqual([]);
        expect(sql(runbook)).toContain("ctid >=");
        const old = facts(keyless);
        old.serverVersionNum = 130000;
        expect(errors(compile(change({ dataType: "bigint" }, "qty"), old))).toEqual(["unsupported"]);
    });

    it("does nothing, and says so, when the type is already what was asked for", () => {
        const runbook = compile(change({ dataType: "integer" }, "qty"), facts(orders()));
        expect(runbook.steps).toEqual([]);
        expect(runbook.findings.map((f) => f.code)).toEqual(["no-change"]);
    });
});

describe("add_column", () => {
    const add = (field: Record<string, unknown>) => plan({ type: "add_column", tableName: "orders", field: { name: "extra", dataType: "text", ...field } });

    it("adds a nullable column as a catalog-only change", () => {
        const runbook = compile(add({}), facts(orders()));
        expect(runbook.steps).toHaveLength(1);
        expect(runbook.steps[0]).toMatchObject({ work: "metadata", risk: "low" });
        expect(runbook.steps[0].undo).toBe("ALTER TABLE public.orders DROP COLUMN extra;");
    });

    it("refuses NOT NULL without a default on a table that has rows", () => {
        expect(errors(compile(add({ nullable: false }), facts(orders())))).toEqual(["not-null-needs-default"]);
        expect(errors(compile(add({ nullable: false }), facts(orders({ rows: 0, bytes: 0 }))))).toEqual([]);
    });

    it("stores a constant default without rewriting", () => {
        const runbook = compile(add({ dataType: "integer", nullable: false, defaultValue: "0" }), facts(orders()));
        expect(runbook.steps).toHaveLength(1);
        expect(runbook.steps[0].sql).toContain("ADD COLUMN extra integer NOT NULL DEFAULT 0;");
        expect(runbook.steps[0].work).toBe("metadata");
    });

    it("fills a volatile default in batches on a table of this size instead of rewriting it", () => {
        const runbook = compile(add({ dataType: "uuid", nullable: false, defaultValue: "gen_random_uuid()" }), facts(orders()));
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps.map((s) => s.work)).toEqual(["metadata", "metadata", "backfill", "metadata", "scan", "metadata", "metadata"]);
        expect(runbook.steps[0].sql).toContain("ADD COLUMN extra uuid;");
        expect(runbook.steps[1].sql).toContain("SET DEFAULT gen_random_uuid();");
        expect(runbook.steps[2].sql).toContain("extra = gen_random_uuid()");
    });

    it("rewrites a small table for a volatile default, as one step", () => {
        const runbook = compile(add({ dataType: "uuid", defaultValue: "gen_random_uuid()" }), facts(orders({ bytes: MIB, rows: 100 })));
        expect(runbook.steps).toHaveLength(1);
        expect(runbook.steps[0].work).toBe("rewrite");
    });

    it("rewrites for an identity column and warns when the table is not small", () => {
        const runbook = compile(add({ dataType: "bigint", autoIncrement: true }), facts(orders()));
        expect(runbook.steps[0]).toMatchObject({ work: "rewrite", risk: "high" });
        expect(runbook.findings.map((f) => f.code)).toContain("rewrite");
    });

    it("makes a unique column through a concurrent unique index and a constraint", () => {
        const runbook = compile(add({ unique: true }), facts(orders()));
        expect(runbook.steps.map((s) => s.sql.split("\n").at(-2) ?? "")).toBeTruthy();
        expect(sql(runbook)).toContain("CREATE UNIQUE INDEX CONCURRENTLY orders_extra_key ON public.orders (extra);");
        expect(sql(runbook)).toContain("ADD CONSTRAINT orders_extra_key UNIQUE USING INDEX orders_extra_key;");
        expect(errors(compile(add({ unique: true, defaultValue: "'x'" }), facts(orders())))).toEqual(["unique-with-default"]);
    });

    it("does not trust a row estimate of zero for a table that holds data", () => {
        const stale = orders({ rows: 0 });
        expect(errors(compile(add({ nullable: false }), facts(stale)))).toEqual(["not-null-needs-default"]);
    });

    it("refuses a new name PostgreSQL would cut short", () => {
        const long = "x".repeat(64);
        expect(errors(compile(add({ name: long }), facts(orders())))).toEqual(["name-too-long"]);
        expect(errors(compile(plan({ type: "add_index", tableName: "orders", index: { name: long, columns: ["total"] } }), facts(orders())))).toEqual(["name-too-long"]);
        expect(errors(compile(add({ name: "x".repeat(63) }), facts(orders())))).toEqual([]);
    });

    it("refuses what it can't compile safely", () => {
        expect(errors(compile(add({ primaryKey: true }), facts(orders())))).toEqual(["unsupported"]);
        expect(errors(compile(add({ name: "status" }), facts(orders())))).toEqual(["column-exists"]);
        expect(errors(compile(add({ dataType: "nonsense" }), facts(orders()), { unknownTypes: ["nonsense"] }))).toEqual(["unknown-type"]);
        expect(errors(compile(add({ dataType: "integer", autoIncrement: true, defaultValue: "1" }), facts(orders())))).toEqual(["bad-default"]);
        expect(errors(compile(add({ dataType: "text", autoIncrement: true }), facts(orders())))).toEqual(["bad-identity"]);
    });

    it("never lets a default carry a second statement or a function nobody has", () => {
        expect(errors(compile(add({ defaultValue: "'x'; DROP TABLE orders" }), facts(orders())))).toEqual(["bad-default"]);
        expect(errors(compile(add({ defaultValue: "(SELECT 1)" }), facts(orders())))).toEqual(["bad-default"]);
        expect(errors(compile(add({ defaultValue: "made_up_function()" }), facts(orders())))).toEqual(["bad-default"]);
        expect(errors(compile(add({ defaultValue: "'x'" }), facts(orders()), { rejectedDefaults: { "'x'": "invalid input" } }))).toEqual(["bad-default"]);
        expect(errors(compile(add({ defaultValue: "'a;b'" }), facts(orders())))).toEqual([]);
    });
});

describe("tables, renames and drops", () => {
    it("creates a table with its key, unique columns, identity and indexes", () => {
        const runbook = compile(
            plan({
                type: "create_table",
                table: {
                    name: "support.tickets",
                    fields: [
                        { name: "id", dataType: "bigint", primaryKey: true, autoIncrement: true },
                        { name: "code", dataType: "varchar", maxLength: 12, unique: true, nullable: false },
                        { name: "opened_at", dataType: "timestamptz", nullable: false, defaultValue: "now()" },
                    ],
                    indexes: [{ name: "tickets_opened_idx", columns: ["opened_at"] }],
                },
            }),
            facts(),
        );
        expect(errors(runbook)).toEqual([]);
        const text = runbook.steps[0].sql;
        expect(text).toContain("CREATE TABLE support.tickets (");
        expect(text).toContain("id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL");
        expect(text).toContain("code varchar(12) NOT NULL");
        expect(text).toContain("opened_at timestamptz NOT NULL DEFAULT now()");
        expect(text).toContain("CONSTRAINT tickets_pkey PRIMARY KEY (id)");
        expect(text).toContain("CONSTRAINT tickets_code_key UNIQUE (code)");
        expect(text).toContain("CREATE INDEX tickets_opened_idx ON support.tickets (opened_at);");
        expect(runbook.steps[0]).toMatchObject({ lock: "none", risk: "low", undo: "DROP TABLE support.tickets;" });
    });

    it("refuses a table that exists, a schema that doesn't, and a column listed twice", () => {
        const field = { name: "id", dataType: "bigint" };
        expect(errors(compile(plan({ type: "create_table", table: { name: "orders", fields: [field] } }), facts(orders())))).toEqual(["table-exists"]);
        expect(errors(compile(plan({ type: "create_table", table: { name: "nope.t", fields: [field] } }), facts(), { missingSchemas: ["nope"] }))).toEqual(["unknown-schema"]);
        expect(errors(compile(plan({ type: "create_table", table: { name: "t", fields: [field, { name: "ID", dataType: "bigint" }] } }), facts()))).toEqual(["column-exists"]);
    });

    it("renames a table and says it breaks callers; later steps see the new name", () => {
        const runbook = compile(plan({ type: "rename_table", tableName: "orders", newName: "sales_orders" }, { type: "add_column", tableName: "sales_orders", field: { name: "x", dataType: "text" } }), facts(orders()));
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps[0]).toMatchObject({ breaksClients: true, lock: "ACCESS EXCLUSIVE" });
        expect(runbook.steps[1].sql).toContain("ALTER TABLE public.sales_orders ADD COLUMN x text;");
    });

    it("marks drops as destructive and high risk when the table holds data, without CASCADE", () => {
        const runbook = compile(plan({ type: "drop_table", tableName: "orders" }, { type: "drop_column", tableName: "customers", columnName: "email" }), facts(orders(), customers()));
        expect(runbook.steps.map((s) => [s.destructive, s.risk])).toEqual([[true, "high"], [true, "high"]]);
        expect(sql(runbook)).not.toContain("CASCADE");
        const empty = compile(plan({ type: "drop_table", tableName: "orders" }), facts(orders({ rows: 0, bytes: 0 })));
        expect(empty.steps[0].risk).toBe("low");
    });

    it("refuses to drop what other objects need", () => {
        const child = table({ name: "order_items", rows: 5, columns: ["id:bigint:notnull", "order_id:bigint"], foreignKeys: [{ columns: ["order_id"], ref: "orders", refColumns: ["id"] }] });
        expect(errors(compile(plan({ type: "drop_table", tableName: "orders" }), facts(orders(), child)))).toEqual(["referenced"]);
        expect(errors(compile(plan({ type: "drop_table", tableName: "orders" }), facts(orders({ views: ["public.v"] }))))).toEqual(["dependent-views"]);
        expect(errors(compile(plan({ type: "drop_column", tableName: "orders", columnName: "id" }), facts(orders())))).toEqual(["primary-key-column"]);
        expect(errors(compile(plan({ type: "drop_column", tableName: "orders", columnName: "id" }), facts(orders({ primaryKey: [] }), child)))).toEqual(["referenced"]);
    });

    it("drops only the CHECK constraints that use the dropped column, not ones whose text merely contains its name", () => {
        // `a` is a prefix of `aa` and of the text of aa's check; the later type change must still see that check
        const wide = table({
            name: "wide", rows: 5_000_000, bytes: 400 * MIB,
            columns: ["id:bigint:notnull", "a:integer", "aa:integer", "b:integer"],
            checks: [
                { name: "wide_aa_positive", definition: "CHECK ((aa > 0))", columns: ["aa"] },
                { name: "wide_a_b_order", definition: "CHECK ((a < b))", columns: ["a", "b"] },
            ],
        });
        const runbook = compile(plan({ type: "drop_column", tableName: "wide", columnName: "a" }, { type: "alter_column", tableName: "wide", columnName: "aa", changes: { dataType: "bigint" } }), facts(wide));
        expect(runbook.steps[0].title).toBe("Drop column public.wide.a");
        expect(runbook.steps[0].notes.join(" ")).toMatch(/CHECK constraints? dropped with it: wide_a_b_order\b/);
        expect(runbook.steps[0].notes.join(" ")).not.toMatch(/wide_aa_positive/);
        // aa's check survived the drop, so the online type change that cannot carry it is refused
        expect(errors(runbook)).toEqual(["unsupported"]);
        expect(runbook.findings.find((finding) => finding.code === "unsupported")?.message).toContain("wide_aa_positive");
    });

    it("lists the indexes a dropped column takes with it, including partial, expression and INCLUDE ones", () => {
        const events = table({
            name: "events", rows: 2_000_000, bytes: 200 * MIB,
            columns: ["id:bigint:notnull", "status:text", "deleted_at:timestamp with time zone", "payload:text"],
            indexes: [
                { name: "events_live_idx", columns: ["status"], uses: ["status", "deleted_at"], partial: true, scans: 5 },
                { name: "events_lower_status_idx", columns: [null], uses: ["status"], scans: 0 },
                { name: "events_status_cover_idx", columns: ["id"], uses: ["id", "payload"], scans: 0 },
            ],
        });
        const dropped = (name: string) => compile(plan({ type: "drop_column", tableName: "events", columnName: name }), facts(events)).steps[0].notes.join(" ");
        expect(dropped("deleted_at")).toMatch(/Indexes dropped with it: events_live_idx \(used 5 times\)/);
        expect(dropped("status")).toMatch(/events_live_idx.*events_lower_status_idx|events_lower_status_idx.*events_live_idx/);
        expect(dropped("payload")).toMatch(/events_status_cover_idx/);
    });

    it("does not copy an index that only mentions the column in a predicate or expression when a type change swaps the column", () => {
        const events = table({
            name: "events", rows: 5_000_000, bytes: 400 * MIB,
            columns: ["id:bigint:notnull", "amount:integer", "kind:text"],
            indexes: [{ name: "events_big_idx", columns: ["kind"], uses: ["kind", "amount"], partial: true, scans: 3 }],
        });
        const runbook = compile(plan({ type: "alter_column", tableName: "events", columnName: "amount", changes: { dataType: "bigint" } }), facts(events));
        expect(errors(runbook)).toEqual([]);
        expect(runbook.findings.map((finding) => finding.code)).toContain("index-not-copied");
        expect(sql(runbook)).not.toContain("events_big_idx__new");
    });

    describe("objects that depend on a column", () => {
        const sales = () =>
            table({
                name: "sales", rows: 5_000_000, bytes: 400 * MIB,
                columns: ["id:bigint:notnull", "price:numeric", "qty:integer", "total:numeric", "note:text", "region:text"],
                dependents: [
                    { column: "price", kind: "view", description: "view public.priced", external: true },
                    { column: "price", kind: "generated-column", description: "generated column total" },
                    { column: "qty", kind: "generated-column", description: "generated column total" },
                    { column: "note", kind: "trigger", description: "trigger sales_note on table sales" },
                    { column: "region", kind: "policy", description: "policy eu_only on table sales" },
                    { column: "qty", kind: "statistics", description: "statistics object sales_stats", blocks: false },
                    { column: "id", kind: "sequence", description: "sequence sales_id_seq", blocks: false },
                ],
            });
        const drop = (columnName: string) => compile(plan({ type: "drop_column", tableName: "sales", columnName }), facts(sales()));
        const change = (columnName: string, dataType: string) => compile(plan({ type: "alter_column", tableName: "sales", columnName, changes: { dataType } }), facts(sales()));

        it("refuses to drop a column that a view, generated column, trigger or policy uses, and names them", () => {
            for (const [column, named] of [["price", "view public.priced, generated column total"], ["qty", "generated column total"], ["note", "trigger sales_note on table sales"], ["region", "policy eu_only on table sales"]] as const) {
                const runbook = drop(column);
                expect(errors(runbook), column).toEqual(["dependents"]);
                expect(runbook.findings.find((finding) => finding.code === "dependents")?.message, column).toContain(named);
                expect(runbook.steps, column).toHaveLength(0);
            }
        });

        it("drops a column whose dependents go with it, and says what else is removed", () => {
            const runbook = drop("id");
            // id is the primary key here, so use a column that is not
            expect(errors(runbook)).toEqual(["primary-key-column"]);
            const plain = compile(plan({ type: "drop_column", tableName: "sales", columnName: "total" }), facts(sales()));
            expect(errors(plain)).toEqual([]);
            const withStats = table({ name: "s2", columns: ["id:bigint:notnull", "qty:integer"], dependents: [{ column: "qty", kind: "statistics", description: "statistics object s2_stats", blocks: false }] });
            const dropped = compile(plan({ type: "drop_column", tableName: "s2", columnName: "qty" }), facts(withStats));
            expect(errors(dropped)).toEqual([]);
            expect(dropped.steps[0].notes.join(" ")).toContain("Also removed with it: statistics object s2_stats.");
        });

        it("refuses a type change on a column they use, instead of swapping the column from under them", () => {
            for (const [column, to] of [["price", "numeric(12,2)"], ["qty", "bigint"], ["note", "varchar(50)"], ["region", "varchar(50)"]] as const) {
                const runbook = change(column, to);
                expect(errors(runbook), column).toEqual(["dependents"]);
                expect(runbook.steps, column).toHaveLength(0);
            }
            // a column nothing uses is unaffected
            expect(errors(compile(plan({ type: "alter_column", tableName: "sales", columnName: "total", changes: { dataType: "numeric(12,2)" } }), facts(sales())))).toEqual([]);
        });

        it("refuses to drop a table that a function or another table's policy needs, without CASCADE", () => {
            const parent = table({
                name: "parent", columns: ["id:bigint:notnull"],
                dependents: [
                    { kind: "function", description: "function count_parent()", external: true },
                    { kind: "policy", description: "policy child_visible on table child", external: true },
                    { kind: "publication", description: "publication of table parent in publication pub", blocks: false },
                ],
            });
            const runbook = compile(plan({ type: "drop_table", tableName: "parent" }), facts(parent));
            expect(errors(runbook)).toEqual(["dependents"]);
            expect(runbook.findings.find((finding) => finding.code === "dependents")?.message).toContain("function count_parent(), policy child_visible on table child");
        });
    });

    it("applies a drop of the key and then of the table in the order given", () => {
        const child = table({ name: "order_items", rows: 5, columns: ["id:bigint:notnull", "order_id:bigint"], foreignKeys: [{ name: "oi_fk", columns: ["order_id"], ref: "orders", refColumns: ["id"] }] });
        const runbook = compile(
            plan({ type: "drop_relationship", sourceTable: "orders", sourceColumn: "id", targetTable: "order_items", targetColumn: "order_id" }, { type: "drop_table", tableName: "orders" }),
            facts(orders(), child),
        );
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps).toHaveLength(2);
    });
});

describe("names", () => {
    it("resolves schema-qualified, case-insensitive and bare names, and reports ambiguity", () => {
        const a = table({ name: "items", schema: "sales", columns: ["id:bigint:notnull"] });
        const b = table({ name: "items", schema: "stock", columns: ["id:bigint:notnull"] });
        const both = facts(a, b);
        expect(errors(compile(plan({ type: "add_column", tableName: "items", field: { name: "x", dataType: "text" } }), both))).toEqual(["ambiguous-table"]);
        expect(errors(compile(plan({ type: "add_column", tableName: "SALES.Items", field: { name: "x", dataType: "text" } }), both))).toEqual([]);
        expect(errors(compile(plan({ type: "add_column", tableName: "missing", field: { name: "x", dataType: "text" } }), both))).toEqual(["unknown-table"]);
        expect(errors(compile(plan({ type: "add_column", tableName: "items", field: { name: "x", dataType: "text" } }), both, { settings: { defaultSchema: "stock" } }))).toEqual([]);
    });

    it("quotes names that need it and nothing else", () => {
        const odd = table({ name: "Order Items", columns: ["id:bigint:notnull", "select:text"] });
        const runbook = compile(plan({ type: "add_column", tableName: "Order Items", field: { name: "from", dataType: "text" } }), facts(odd));
        expect(runbook.steps[0].sql).toContain('ALTER TABLE public."Order Items" ADD COLUMN "from" text;');
    });
});

describe("a plan as a whole", () => {
    it("keeps compiling the other operations when one is refused, and says which was", () => {
        const runbook = compile(
            plan({ type: "add_column", tableName: "orders", field: { name: "must", dataType: "text", nullable: false } }, { type: "add_column", tableName: "orders", field: { name: "fine", dataType: "text" } }),
            facts(orders()),
        );
        expect(runbook.uncompiled).toEqual([0]);
        expect(runbook.steps).toHaveLength(1);
        expect(runbook.steps[0].operation).toBe(1);
        expect(runbook.findings[0]).toMatchObject({ severity: "error", operation: 0, table: "public.orders" });
    });

    it("leaves a refused operation's partial work and name claims behind", () => {
        const runbook = compile(
            plan(
                { type: "add_index", tableName: "orders", index: { name: "dup_name", columns: ["customer_id"] } },
                { type: "add_index", tableName: "orders", index: { name: "dup_name", columns: ["total"] } },
            ),
            facts(orders()),
        );
        expect(runbook.steps).toHaveLength(1);
        expect(errors(runbook)).toEqual(["name-taken"]);
    });

    it("sets a lock timeout on every step that takes a strong lock, and none on the concurrent ones", () => {
        const runbook = compile(
            plan(
                { type: "add_column", tableName: "orders", field: { name: "a", dataType: "text" } },
                { type: "add_index", tableName: "orders", index: { name: "orders_total_idx", columns: ["total"] } },
            ),
            facts(orders()),
            { settings: { lockTimeoutSeconds: 3 } },
        );
        expect(runbook.steps[0].sql).toMatch(/^SET lock_timeout = '3s';/);
        expect(runbook.steps[1].sql).toMatch(/^SET lock_timeout = 0;/);
    });

    it("renders one script: a header, a block per step, the optional ones as comments, and a clean-up", () => {
        const runbook = compile(plan({ type: "alter_column", tableName: "orders", columnName: "qty", changes: { dataType: "bigint" } }), facts(orders({ bytes: 5 * GIB })));
        const script = runbook.script;
        expect(script).toMatch(/^-- GoForge runbook: \d+ steps \(\d+ to run now\) for PostgreSQL 16\.0\./);
        expect(script).toContain("-- ── Step 1 of ");
        expect(script).toContain("[NOT RUN BY DEFAULT]");
        expect(script).toContain("-- ALTER TABLE public.orders DROP COLUMN qty__old;");
        expect(script).not.toMatch(/^ALTER TABLE public.orders DROP COLUMN qty__old/m);
        expect(script.trimEnd().endsWith("RESET statement_timeout;")).toBe(true);
        expect(script).toContain("each statement run on its own (no transaction)");
    });

    it("says what it needs from the database before compiling", () => {
        const request = discoverProbes({
            plan: plan(
                { type: "add_column", tableName: "orders", field: { name: "u", dataType: "uuid", defaultValue: "gen_random_uuid()" } },
                { type: "alter_column", tableName: "orders", columnName: "qty", changes: { dataType: "bigint" } },
                { type: "add_index", tableName: "orders", index: { name: "ix", columns: ["total"] } },
            ),
            facts: facts(orders()),
        });
        expect(request.types).toContain("uuid");
        expect(request.typeChanges).toEqual([{ from: "integer", to: "bigint" }]);
        expect(request.functions).toEqual(["gen_random_uuid"]);
        expect(request.defaults).toEqual([{ expression: "gen_random_uuid()", type: "uuid" }]);
        expect(request.relations).toContainEqual({ schema: "public", name: "ix" });
    });

    it("warns about servers older than PostgreSQL 12", () => {
        const old = facts(orders());
        old.serverVersionNum = 110005;
        old.serverVersion = "11.5";
        expect(compile(plan({ type: "add_column", tableName: "orders", field: { name: "a", dataType: "text" } }), old).findings.map((f) => f.code)).toContain("old-server");
    });
});

describe("lint", () => {
    const step = (sqlText: string, extra: Partial<RunbookStep> = {}): RunbookStep => ({
        id: 1, operation: 0, title: "t", sql: sqlText, lock: "ACCESS EXCLUSIVE", alsoLocks: [], work: "metadata", risk: "low", reason: "", table: "public.orders", sizeClass: "large",
        tableBytes: 5 * GIB, tableRows: 1, notes: [], destructive: false, breaksClients: false, optional: false, ...extra,
    });
    const rules = (...steps: RunbookStep[]) => lintSteps(steps).violations.map((v) => v.rule);

    it("passes everything the compiler produces", () => {
        const operations = [
            { type: "add_index", tableName: "orders", index: { name: "ix1", columns: ["customer_id"] } },
            { type: "add_column", tableName: "orders", field: { name: "u", dataType: "uuid", nullable: false, defaultValue: "gen_random_uuid()" } },
            { type: "alter_column", tableName: "orders", columnName: "ref", changes: { nullable: false } },
            { type: "alter_column", tableName: "orders", columnName: "qty", changes: { dataType: "bigint" } },
            { type: "alter_column", tableName: "orders", columnName: "status", changes: { dataType: "varchar", maxLength: 60, unique: false } },
            { type: "add_relationship", relationship: { sourceTable: "customers", sourceColumn: "id", targetTable: "orders", targetColumn: "customer_id" } },
            { type: "drop_index", tableName: "orders", indexName: "orders_status_idx" },
        ];
        for (const operation of operations) {
            const runbook = compile(plan(operation), facts(orders({ bytes: 5 * GIB }), customers()));
            expect(lintSteps(runbook.steps).violations, JSON.stringify(operation)).toEqual([]);
        }
    });

    it("catches the plain statements it exists to catch", () => {
        const naive = (text: string, extra?: Partial<RunbookStep>) => rules(step(`SET lock_timeout = '5s';\n${text}`, extra));
        expect(naive("CREATE INDEX ix ON public.orders (a);")).toEqual(["index-not-concurrent"]);
        expect(naive("DROP INDEX public.ix;")).toEqual(["drop-index-not-concurrent"]);
        expect(naive("ALTER TABLE public.orders ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES public.c (id);")).toEqual(["foreign-key-validated-inline"]);
        expect(naive("ALTER TABLE public.orders ADD CONSTRAINT c CHECK (a > 0);")).toEqual(["check-validated-inline"]);
        expect(naive("ALTER TABLE public.orders ALTER COLUMN a SET NOT NULL;")).toEqual(["set-not-null-direct"]);
        expect(naive("ALTER TABLE public.orders ALTER COLUMN a TYPE bigint;", { work: "rewrite" })).toEqual(["type-change-rewrites"]);
        expect(naive("UPDATE public.orders SET a = 1;")).toEqual(["unbatched-write"]);
        expect(naive("DROP TABLE public.orders CASCADE;")).toEqual(["cascade"]);
        expect(naive("BEGIN;")).toEqual(["transaction-control"]);
        expect(naive("DO $$ BEGIN CREATE INDEX CONCURRENTLY ix ON t (a); END $$;")).toEqual(["concurrently-in-do"]);
        expect(rules(step("ALTER TABLE public.orders ADD COLUMN a text;"))).toEqual(["no-lock-timeout"]);
        expect(rules(step("SET lock_timeout = 0;\nALTER TABLE public.orders ADD COLUMN a text;"))).toEqual(["no-lock-timeout"]);
    });

    it("lets the same statements through on a small or new table, and in comments and strings", () => {
        expect(rules(step("SET lock_timeout = '5s';\nCREATE INDEX ix ON public.orders (a);", { sizeClass: "small" }))).toEqual([]);
        expect(rules(step("ALTER TABLE public.t ADD COLUMN a text;", { sizeClass: "new" }))).toEqual([]);
        expect(rules(step("SET lock_timeout = '5s';\n-- CREATE INDEX ix ON t (a);\nSELECT 'DROP TABLE x CASCADE';"))).toEqual([]);
        expect(rules(step("-- DROP TABLE x CASCADE;", { optional: true }))).toEqual([]);
    });

    it("accepts SET NOT NULL only after a validated CHECK on the same column", () => {
        const prelude = "SET lock_timeout = '5s';\n";
        const added = step(`${prelude}ALTER TABLE public.orders ADD CONSTRAINT c1 CHECK (a IS NOT NULL) NOT VALID;`, { id: 1 });
        const validated = step(`${prelude}ALTER TABLE public.orders VALIDATE CONSTRAINT c1;`, { id: 2 });
        const set = step(`${prelude}ALTER TABLE public.orders ALTER COLUMN a SET NOT NULL;`, { id: 3 });
        expect(rules(added, validated, set)).toEqual([]);
        expect(rules(added, set)).toEqual(["set-not-null-direct"]);
        expect(rules(added, validated, step(`${prelude}ALTER TABLE public.orders ALTER COLUMN b SET NOT NULL;`))).toEqual(["set-not-null-direct"]);
    });
});
