import { describe, expect, it, vi } from "vitest";
import type { ModelCall, ModelResult } from "../ai/provider.js";
import { MAX_ATTEMPTS, PlannerError, planSchemaChange, referencedTableNames, unseenExistingTables, type PlannerDeps } from "./planner.js";
import { namesToRedact, plannerInput } from "./prompt.js";
import { Redactor, findLeaks } from "./redact.js";
import { answer, facts, MIB, table } from "./test-fixtures.js";
import type { Facts } from "./facts.js";

const orders = () =>
    table({
        name: "orders",
        rows: 2_000_000,
        bytes: 300 * MIB,
        columns: ["id:bigint:notnull", "customer_id:bigint:notnull", "status:character varying(20):notnull", "shipped_at:timestamp with time zone"],
        indexes: [{ name: "orders_status_idx", columns: ["status"], scans: 7 }],
    });
const customers = () => table({ name: "customers", rows: 10_000, bytes: 2 * MIB, columns: ["id:bigint:notnull", "email:text:notnull"] });
const everything = () => facts(orders(), customers());

const modelResult = (output: unknown, extra: Partial<ModelResult> = {}): ModelResult => ({ output, model: "test-model", usage: { inputTokens: 100, outputTokens: 20 }, auditId: 1, latencyMs: 50, ...extra });
const plan = (...operations: unknown[]) => ({ summary: "done", assumptions: [], warnings: [], clarifyingQuestions: [], operations });
const addIndex = (name = "orders_shipped_idx", column = "shipped_at") => ({ type: "add_index", tableName: "public.orders", index: { name, columns: [column] } });

function deps(answers: (call: ModelCall, n: number) => unknown, base: Facts = everything(), extra: { other?: { schema: string; name: string }[] } = {}) {
    const calls: ModelCall[] = [];
    const value: PlannerDeps = {
        loadFacts: async (names) => facts(...names.flatMap((name) => (base.tables.get(name) ? [structuredClone(base.tables.get(name)!)] : []))),
        probe: async (request) => answer(request),
        wholeDatabase: async () => ({ tables: [...[...base.tables.values()].map((t) => ({ schema: t.schema, name: t.name })), ...(extra.other ?? [])] }),
        callModel: async (call) => {
            calls.push(call);
            return modelResult(answers(call, calls.length), { auditId: calls.length });
        },
    };
    return { value, calls };
}

const request = (overrides: Partial<Parameters<typeof planSchemaChange>[1]> = {}) => ({ prompt: "index orders by when they shipped", tables: ["public.orders"], redact: false, connection: { id: "c1", name: "main" }, ...overrides });

describe("planSchemaChange", () => {
    it("sends only the chosen tables, compiles what comes back and lints it", async () => {
        const { value, calls } = deps(() => plan(addIndex()), everything(), { other: [{ schema: "public", name: "audit_log" }] });
        const result = await planSchemaChange(value, request());

        expect(calls).toHaveLength(1);
        const input = calls[0].input as { tables: { name: string }[]; database: Record<string, unknown>; request: string };
        expect(input.tables.map((t) => t.name)).toEqual(["public.orders"]);
        expect(input.database).toMatchObject({ tablesShown: 1, otherTablesNotShown: 2 });
        expect(input.request).toBe("index orders by when they shipped");
        expect(calls[0].purpose).toBe("schema-plan");
        expect(calls[0].format?.name).toBe("schema_change_plan");
        expect(calls[0].context).toMatchObject({ connectionId: "c1", connectionName: "main", redacted: false });

        expect(result.runbook?.steps[0].sql).toContain("CREATE INDEX CONCURRENTLY orders_shipped_idx ON public.orders (shipped_at);");
        expect(result.lint?.violations).toEqual([]);
        expect(result).toMatchObject({ attempts: 1, model: "test-model", scope: ["public.orders"], omittedTables: 2, auditIds: [1], redacted: false });
        expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    });

    describe("an answer written to the structured-output schema", () => {
        // every key present, the ones that do not apply null: what strict mode makes the model write
        const unchanged = { newName: null, dataType: null, nullable: null, primaryKey: null, unique: null, autoIncrement: null, defaultValue: null, maxLength: null, precision: null, scale: null, unsigned: null, values: null, note: null };
        const strict = (changes: Record<string, unknown>) => plan({ type: "alter_column", tableName: "public.orders", columnName: "status", changes: { ...unchanged, dropDefault: null, ...changes } });
        const withDefault = () => facts(table({ name: "orders", rows: 100, bytes: MIB, columns: ["id:bigint:notnull", "status:character varying(20)"] }), customers());
        const withStatusDefault = () => {
            const base = withDefault();
            base.tables.get("public.orders")!.columns.find((column) => column.name === "status")!.default = "'new'::character varying";
            return base;
        };

        it("compiles 'remove the default' from dropDefault, though defaultValue is null in the answer either way", async () => {
            const { value } = deps(() => strict({ dropDefault: true }), withStatusDefault());
            const result = await planSchemaChange(value, request());
            expect(result.attempts).toBe(1);
            expect(result.runbook?.steps.map((step) => step.sql).join("\n")).toContain("ALTER COLUMN status DROP DEFAULT;");
        });

        it("compiles nothing for a change that only says what it leaves alone, instead of reading the nulls as 'remove the default'", async () => {
            const { value } = deps(() => strict({ nullable: false, dropDefault: false }), withStatusDefault());
            const result = await planSchemaChange(value, request());
            const sql = result.runbook?.steps.map((step) => step.sql).join("\n") ?? "";
            expect(sql).not.toContain("DROP DEFAULT");
            expect(sql).toMatch(/status/);
            expect(result.plan.operations[0]).toMatchObject({ type: "alter_column", changes: { nullable: false } });
            expect("defaultValue" in (result.plan.operations[0] as { changes: object }).changes).toBe(false);
        });
    });

    it("shows the model the facts it needs and nothing that is data", async () => {
        const withDefault = orders();
        withDefault.columns[2].default = "'secret-default'::text";
        withDefault.indexes[0].definition = "CREATE INDEX orders_status_idx ON orders (status) WHERE status = 'secret-predicate'";
        withDefault.checks.push({ name: "orders_chk", kind: "check", definition: "CHECK (status <> 'secret-check')", columns: ["status"], validated: true });
        const { value, calls } = deps(() => plan(addIndex()), facts(withDefault));
        await planSchemaChange(value, request());
        const text = JSON.stringify(calls[0].input);
        expect(text).not.toMatch(/secret/);
        const [orderFacts] = (calls[0].input as { tables: Record<string, unknown>[] }).tables;
        expect(orderFacts).toMatchObject({ rows: 2_000_000, dataBytes: 300 * MIB });
        expect(orderFacts.indexes).toContainEqual(expect.objectContaining({ name: "orders_status_idx", scans: 7, columns: ["status"] }));
        expect((orderFacts.columns as { name: string; hasDefault?: boolean }[]).find((c) => c.name === "status")?.hasDefault).toBe(true);
        expect(orderFacts.checkConstraints).toEqual([{ name: "orders_chk", validated: true }]);
    });

    it("returns the questions and no runbook when the model asks instead of planning", async () => {
        const { value } = deps(() => ({ ...plan(), clarifyingQuestions: ["Should deleted rows keep their old status?"] }));
        const result = await planSchemaChange(value, request());
        expect(result.runbook).toBeNull();
        expect(result.plan.clarifyingQuestions).toHaveLength(1);
    });

    it("asks once more when the answer is not a plan, naming what was wrong", async () => {
        const { value, calls } = deps((_call, n) => (n === 1 ? { summary: "x", operations: [{ type: "teleport" }] } : plan(addIndex())));
        const result = await planSchemaChange(value, request());
        expect(result.attempts).toBe(2);
        const second = calls[1].input as { previousAnswerProblems: string[]; previousAnswer: unknown };
        expect(second.previousAnswerProblems[0]).toMatch(/did not match the required format/);
        expect(second.previousAnswer).toBeDefined();
        expect(result.usage.inputTokens).toBe(200);
    });

    it("gives up with a clear error when two answers in a row are not plans", async () => {
        const { value, calls } = deps(() => ({ nonsense: true }));
        await expect(planSchemaChange(value, request())).rejects.toThrow(/not a valid plan/);
        expect(calls).toHaveLength(MAX_ATTEMPTS);
    });

    it("shows the model what the checks found, and keeps the answer with fewer errors", async () => {
        const { value, calls } = deps((_call, n) => (n === 1 ? plan(addIndex("a", "no_such_column")) : plan(addIndex("a", "shipped_at"))));
        const result = await planSchemaChange(value, request());
        expect(calls).toHaveLength(2);
        expect((calls[1].input as { previousAnswerProblems: string[] }).previousAnswerProblems[0]).toMatch(/operation 1: Column "public.orders.no_such_column" does not exist/);
        expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
        expect(result.runbook?.steps).toHaveLength(1);

        const stubborn = deps(() => plan(addIndex("a", "no_such_column")));
        const failed = await planSchemaChange(stubborn.value, request());
        expect(stubborn.calls).toHaveLength(MAX_ATTEMPTS);
        expect(failed.findings.some((f) => f.severity === "error")).toBe(true);
        expect(failed.runbook?.steps).toEqual([]);
    });

    it("does not call the model for a bad scope", async () => {
        const { value, calls } = deps(() => plan());
        await expect(planSchemaChange(value, request({ tables: ["public.nope"] }))).rejects.toMatchObject({ status: 404 });
        await expect(planSchemaChange(value, request({ tables: Array.from({ length: 101 }, (_, i) => `public.t${i}`) }))).rejects.toBeInstanceOf(PlannerError);
        expect(calls).toHaveLength(0);
    });

    it("uses the schema most of the chosen tables are in for new objects", async () => {
        const sales = table({ name: "orders", schema: "sales", columns: ["id:bigint:notnull"] });
        const { value } = deps(() => plan({ type: "create_table", table: { name: "notes", fields: [{ name: "id", dataType: "bigint" }] } }), facts(sales));
        const result = await planSchemaChange(value, request({ tables: ["sales.orders"] }));
        expect(result.runbook?.steps[0].sql).toContain("CREATE TABLE sales.notes");
    });
});

const createNotes = (...extra: unknown[]) => [
    { type: "create_table", table: { name: "notes", fields: [{ name: "id", dataType: "bigint", primaryKey: true }, { name: "customer_id", dataType: "bigint", nullable: false }] } },
    ...extra,
];
const notesToCustomers = (column = "id") => ({ type: "add_relationship", relationship: { sourceTable: "public.customers", sourceColumn: column, targetTable: "public.notes", targetColumn: "customer_id" } });

describe("choosing no tables", () => {
    it("still plans: the model is told which tables exist, and a new table is created", async () => {
        const { value, calls } = deps(() => plan(...createNotes()));
        const result = await planSchemaChange(value, request({ prompt: "add a notes table", tables: [] }));

        const input = calls[0].input as { tables: unknown[]; otherTables: string[]; database: Record<string, unknown> };
        expect(input.tables).toEqual([]);
        expect(input.otherTables).toEqual(["public.customers", "public.orders"]);
        expect(input.database).toMatchObject({ tablesShown: 0, otherTablesNotShown: 2, postgresVersion: expect.any(String) });
        expect(result.findings.filter((finding) => finding.severity === "error")).toEqual([]);
        expect(result.runbook?.steps[0].sql).toContain("CREATE TABLE public.notes");
        expect(result).toMatchObject({ scope: [], expandedTables: [], omittedTables: 2 });
    });

    it("refuses a new table whose name is already taken, even though the table was not shown", async () => {
        const { value } = deps(() => plan({ type: "create_table", table: { name: "orders", fields: [{ name: "id", dataType: "bigint" }] } }));
        const taken = { ...value, probe: async (probeRequest: Parameters<PlannerDeps["probe"]>[0]) => answer(probeRequest, { existing: ["public.orders"] }) };
        const result = await planSchemaChange(taken, request({ tables: [] }));
        expect(result.findings.some((finding) => finding.severity === "error" && /already exists/.test(finding.message))).toBe(true);
        expect(result.runbook?.steps).toEqual([]);
    });

    it("reads the existing table a new foreign key points at, and checks the key against its real columns", async () => {
        const { value, calls } = deps(() => plan(...createNotes(notesToCustomers())));
        const result = await planSchemaChange(value, request({ prompt: "add notes about a customer", tables: [] }));

        expect(calls).toHaveLength(1);
        expect(result.expandedTables).toEqual(["public.customers"]);
        expect(result.scope).toEqual(["public.customers"]);
        expect(result.findings.filter((finding) => finding.severity === "error")).toEqual([]);
        expect(result.runbook?.steps.map((step) => step.sql).join("\n")).toMatch(/FOREIGN KEY \(customer_id\) REFERENCES public\.customers \(id\)/);
    });

    it("shows the model the table it referred to when its first answer was wrong about a column", async () => {
        const { value, calls } = deps((_call, n) => (n === 1 ? plan(...createNotes(notesToCustomers("no_such_column"))) : plan(...createNotes(notesToCustomers("id")))));
        const result = await planSchemaChange(value, request({ prompt: "add notes about a customer", tables: [] }));

        expect(calls).toHaveLength(2);
        const second = calls[1].input as { tables: { name: string; columns: { name: string }[] }[]; previousAnswerProblems: string[] };
        expect(second.tables.map((table) => table.name)).toEqual(["public.customers"]);
        expect(second.tables[0].columns.map((column) => column.name)).toEqual(["id", "email"]);
        expect(second.previousAnswerProblems.join(" ")).toMatch(/no_such_column/);
        expect(result.findings.filter((finding) => finding.severity === "error")).toEqual([]);
        expect(result.expandedTables).toEqual(["public.customers"]);
    });

    it("does not go looking for a table that does not exist", async () => {
        const { value, calls } = deps(() => plan(...createNotes({ ...notesToCustomers(), relationship: { ...notesToCustomers().relationship, sourceTable: "public.ghosts" } })));
        const result = await planSchemaChange(value, request({ tables: [] }));
        expect(result.expandedTables).toEqual([]);
        expect(result.findings.some((finding) => finding.severity === "error" && /ghosts/.test(finding.message))).toBe(true);
        expect(calls.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
    });

    it("hides the names of the existing tables too when names are redacted", async () => {
        const { value, calls } = deps(() => plan(...createNotes()));
        await planSchemaChange(value, request({ prompt: "add notes next to the orders", tables: [], redact: true }));
        const sent = JSON.stringify(calls[0].input) + calls[0].instructions;
        expect(sent).not.toContain("orders");
        expect(sent).not.toContain("customers");
        expect((calls[0].input as { otherTables: string[] }).otherTables.every((name) => /^s_\d+\.t_\d+$/.test(name))).toBe(true);
    });

    it("lists at most as many existing table names as it is willing to send, and says how many it left out", async () => {
        const many = Array.from({ length: 450 }, (_, i) => ({ schema: "public", name: `t${String(i).padStart(3, "0")}` }));
        const { value, calls } = deps(() => plan(...createNotes()), facts(), { other: many });
        await planSchemaChange(value, request({ tables: [] }));
        const input = calls[0].input as { otherTables: string[]; database: Record<string, unknown> };
        expect(input.otherTables).toHaveLength(400);
        expect(input.database).toMatchObject({ otherTablesNotShown: 450, otherTablesListed: 400 });
    });
});

describe("which existing tables a plan refers to", () => {
    const parsed = (...operations: unknown[]) => plan(...operations) as unknown as Parameters<typeof referencedTableNames>[0];

    it("counts every operation's tables but not the ones the plan creates", () => {
        const names = referencedTableNames(parsed(...createNotes(notesToCustomers(), { type: "add_index", tableName: "public.orders", index: { name: "i", columns: ["id"] } }, { type: "drop_relationship", sourceTable: "public.customers", sourceColumn: "id", targetTable: "public.orders", targetColumn: "customer_id" })));
        expect(names.sort()).toEqual(["public.customers", "public.customers", "public.orders", "public.orders"].sort());
        expect(names).not.toContain("public.notes");
    });

    it("matches names the way the compiler does: bare names in the default schema, any case, or the only table of that name", () => {
        const whole = [{ schema: "public", name: "customers" }, { schema: "sales", name: "Orders" }, { schema: "sales", name: "plans" }];
        const operations = parsed({ type: "add_index", tableName: "CUSTOMERS", index: { name: "i", columns: ["a"] } }, { type: "add_index", tableName: "orders", index: { name: "j", columns: ["a"] } }, { type: "add_index", tableName: "sales.plans", index: { name: "k", columns: ["a"] } }, { type: "add_index", tableName: "ghosts", index: { name: "l", columns: ["a"] } });
        expect(unseenExistingTables(operations, new Set(), whole, "public")).toEqual(["public.customers", "sales.Orders", "sales.plans"]);
        expect(unseenExistingTables(operations, new Set(["public.customers", "sales.plans"]), whole, "public")).toEqual(["sales.Orders"]);
    });
});

describe("with names redacted", () => {
    it("sends placeholders, translates the answer back, and compiles it against the real names", async () => {
        const others = [{ schema: "public", name: "payroll_runs" }];
        let redactedPrompt = "";
        const { value, calls } = deps(
            (call) => {
                const input = call.input as { request: string; tables: { name: string; columns: { name: string }[]; indexes: { name: string }[] }[] };
                redactedPrompt = input.request;
                const orderTable = input.tables.find((t) => t.columns.length === 4)!;
                const shipped = orderTable.columns.find((c) => c.name.startsWith("c_") && orderTable.columns.indexOf(c) === orderTable.columns.length - 1)!;
                return plan({ type: "add_index", tableName: orderTable.name, index: { name: "idx_new", columns: [shipped.name] } });
            },
            everything(),
            { other: others },
        );
        const result = await planSchemaChange(value, request({ prompt: "index the orders by shipped_at, and keep payroll_runs out of it", redact: true }));

        const sent = JSON.stringify(calls[0].input) + calls[0].instructions;
        for (const real of ["orders", "customers", "shipped_at", "customer_id", "orders_status_idx", "payroll_runs", "email"]) expect(sent, real).not.toContain(real);
        expect(redactedPrompt).toMatch(/index the t_\d+ by c_\d+, and keep t_\d+ out of it/);
        expect(calls[0].context?.redacted).toBe(true);

        // the plan the person sees and the runbook use the real names
        expect(result.redacted).toBe(true);
        expect(result.plan.operations[0]).toMatchObject({ type: "add_index", tableName: "public.orders", index: { name: "idx_new", columns: ["shipped_at"] } });
        expect(result.runbook?.steps[0].sql).toContain("CREATE INDEX CONCURRENTLY idx_new ON public.orders (shipped_at);");
    });

    it("hides custom type names but keeps the types a model needs", () => {
        const withEnum = orders();
        withEnum.columns.push({ name: "mood", type: "sentiment_kind", typeSchema: "public", notNull: false, default: null, generated: null, nullFraction: null, distinct: null });
        const f = facts(withEnum);
        const redactor = new Redactor(namesToRedact(f));
        const text = JSON.stringify(plannerInput({ prompt: "x", facts: f, omittedTables: 0, redactor }));
        expect(text).not.toContain("sentiment_kind");
        expect(text).toContain("character varying(20)");
        expect(text).toContain("timestamp with time zone");
        expect(findLeaks(text, namesToRedact(f).map((e) => e.name))).toEqual([]);
    });

    it("refuses to send, rather than send a name, when redaction missed one", async () => {
        const f = facts(orders());
        // a name the redactor was not told about, placed where the prompt builder copies text through unmasked
        const { value, calls } = deps(() => plan(), f);
        const original = value.wholeDatabase;
        value.wholeDatabase = original;
        const redactorSpy = vi.spyOn(Redactor.prototype, "id").mockImplementation((name: string) => (name === "shipped_at" ? "shipped_at" : name === "status" ? "c_9" : `x_${name.length}`));
        await expect(planSchemaChange(value, request({ redact: true }))).rejects.toThrow(/Name redaction left/);
        expect(calls).toHaveLength(0);
        redactorSpy.mockRestore();
    });
});
