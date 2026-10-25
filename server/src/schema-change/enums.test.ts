import { describe, expect, it } from "vitest";
import { compile, facts, MIB, plan, table } from "./test-fixtures.js";
import type { Runbook } from "./runbook.js";

const errors = (runbook: Runbook) => runbook.findings.filter((finding) => finding.severity === "error").map((finding) => finding.code);
const orders = () => table({ name: "orders", rows: 5_000_000, bytes: 400 * MIB, columns: ["id:bigint:notnull", "note:text"] });
const mood = { "public.mood": { labels: ["sad", "ok", "happy"] } };

describe("create_enum", () => {
    it("creates the type in one step that locks nothing, with the labels quoted, and says how to undo it", () => {
        const runbook = compile(plan({ type: "create_enum", typeName: "mood", values: ["sad", "it's fine", "happy"] }), facts());
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps).toHaveLength(1);
        expect(runbook.steps[0]).toMatchObject({ lock: "none", work: "none", risk: "low", undo: "DROP TYPE public.mood;" });
        expect(runbook.steps[0].sql).toContain("CREATE TYPE public.mood AS ENUM ('sad', 'it''s fine', 'happy');");
    });

    it("refuses a name that is taken by a type or by a table, repeated labels and labels that are too long", () => {
        expect(compile(plan({ type: "create_enum", typeName: "mood", values: ["a"] }), facts(), { enums: mood }).findings.map((finding) => finding.code)).toContain("name-taken");
        expect(compile(plan({ type: "create_enum", typeName: "orders", values: ["a"] }), facts(orders()), { existing: ["public.orders"] }).findings.map((finding) => finding.code)).toContain("name-taken");
        expect(errors(compile(plan({ type: "create_enum", typeName: "mood", values: ["a", "b", "a"] }), facts()))).toEqual(["duplicate-value"]);
        expect(errors(compile(plan({ type: "create_enum", typeName: "mood", values: ["é".repeat(40)] }), facts()))).toEqual(["name-too-long"]);
        expect(errors(compile(plan({ type: "create_enum", typeName: "nope.mood", values: ["a"] }), facts(), { missingSchemas: ["nope"] }))).toEqual(["unknown-schema"]);
    });

    it("can be used by a column later in the same plan, whose default has to be one of its labels", () => {
        const ok = compile(plan({ type: "create_enum", typeName: "status_kind", values: ["new", "open"] }, { type: "add_column", tableName: "orders", field: { name: "kind", dataType: "status_kind", nullable: false, defaultValue: "'new'" } }), facts(orders()));
        expect(errors(ok)).toEqual([]);
        expect(ok.steps.map((step) => step.sql).join("\n")).toMatch(/ADD COLUMN kind status_kind (NOT NULL DEFAULT 'new'|DEFAULT 'new' NOT NULL)/);
        const wrongDefault = compile(plan({ type: "create_enum", typeName: "status_kind", values: ["new", "open"] }, { type: "add_column", tableName: "orders", field: { name: "kind", dataType: "status_kind", defaultValue: "'closed'" } }), facts(orders()));
        expect(errors(wrongDefault)).toEqual(["bad-default"]);
        expect(wrongDefault.findings.find((finding) => finding.code === "bad-default")?.message).toContain("'new', 'open'");
        const array = compile(plan({ type: "create_enum", typeName: "status_kind", values: ["new"] }, { type: "add_column", tableName: "orders", field: { name: "kinds", dataType: "public.status_kind[]" } }), facts(orders()));
        expect(errors(array)).toEqual([]);
        // without the create_enum the same column is refused: the database has no such type
        expect(errors(compile(plan({ type: "add_column", tableName: "orders", field: { name: "kind", dataType: "status_kind" } }), facts(orders()), { unknownTypes: ["status_kind"] }))).toEqual(["unknown-type"]);
    });
});

describe("add_enum_value", () => {
    const add = (operation: Record<string, unknown>, enums = mood) => compile(plan({ type: "add_enum_value", typeName: "mood", ...operation }), facts(), { enums });

    it("adds the label at the end, before or after another, without locking any table", () => {
        const end = add({ value: "ecstatic" });
        expect(errors(end)).toEqual([]);
        expect(end.steps[0]).toMatchObject({ lock: "none", work: "none" });
        expect(end.steps[0].sql).toContain("ALTER TYPE public.mood ADD VALUE IF NOT EXISTS 'ecstatic';");
        expect(add({ value: "meh", before: "ok" }).steps[0].sql).toContain("ADD VALUE IF NOT EXISTS 'meh' BEFORE 'ok';");
        expect(add({ value: "fine", after: "ok" }).steps[0].sql).toContain("ADD VALUE IF NOT EXISTS 'fine' AFTER 'ok';");
        expect(end.steps[0].notes.join(" ")).toMatch(/never be removed/);
    });

    it("says so when the label is there, and refuses an unknown type, a type that is not an enum, an unknown neighbour and both positions", () => {
        const present = add({ value: "ok" });
        expect(present.steps).toHaveLength(0);
        expect(present.findings.map((finding) => finding.code)).toContain("no-change");
        expect(errors(add({ value: "x" }, {}))).toEqual(["unknown-type"]);
        expect(errors(add({ value: "x" }, { "public.mood": { kind: "c", labels: [] } }))).toEqual(["not-an-enum"]);
        expect(errors(add({ value: "x", before: "nothing" }))).toEqual(["unknown-value"]);
        expect(errors(add({ value: "x", before: "ok", after: "sad" }))).toEqual(["bad-position"]);
    });

    it("sees the labels an earlier step of the same plan added", () => {
        const runbook = compile(plan({ type: "add_enum_value", typeName: "mood", value: "ecstatic" }, { type: "add_enum_value", typeName: "mood", value: "ecstatic" }, { type: "add_enum_value", typeName: "mood", value: "calm", after: "ecstatic" }), facts(), { enums: mood });
        expect(errors(runbook)).toEqual([]);
        expect(runbook.steps).toHaveLength(2);
        expect(runbook.findings.map((finding) => finding.code)).toContain("no-change");
        expect(runbook.steps[1].sql).toContain("'calm' AFTER 'ecstatic'");
    });
});
