import { describe, expect, it } from "vitest";
import { z } from "zod";
import { modernizeQueryResultSchema } from "./modernize-query.js";
import { buildResponseSchema } from "./openai.js";
import { aiSchemaPlanModelSchema, aiSchemaPlanSchema } from "./schema-plan.js";
import { fromModelPlan, normalizePlanOutput } from "./plan-normalize.js";
import { forModel, stripNulls } from "./structured.js";

type Json = Record<string, any>;
/** Keywords strict mode does not take (a property may still be called maxLength: those have an object, not a number, after them). */
const LIMIT_KEYWORDS = /"(minLength|maxLength|minItems|maxItems|minimum|maximum|exclusiveMinimum|exclusiveMaximum)":\d|"default":|"pattern":|"format":/;
const jsonOf = (schema: z.ZodTypeAny): Json => buildResponseSchema("answer", forModel(schema)).schema as Json;

/** Every object in the schema, wherever it is nested. */
function objectsIn(node: unknown, found: Json[] = []): Json[] {
    if (Array.isArray(node)) node.forEach((item) => objectsIn(item, found));
    else if (node && typeof node === "object") {
        if ((node as Json).type === "object" && (node as Json).properties) found.push(node as Json);
        Object.values(node).forEach((child) => objectsIn(child, found));
    }
    return found;
}

describe("forModel", () => {
    it("keeps keys, makes optional and defaulted fields part of the answer that may be null, and drops limits and refinements", () => {
        const validator = z
            .object({
                sql: z.string().trim().min(1).max(100),
                count: z.number().int().positive(),
                ratio: z.number().min(0),
                flag: z.boolean().optional(),
                note: z.string().nullable().optional(),
                tags: z.array(z.string().max(5)).min(1).max(3).default([]),
                kind: z.enum(["a", "b"]),
                list: z.preprocess((value) => value, z.array(z.string())),
                free: z.string().catch(""),
            })
            .strict()
            .superRefine(() => undefined);

        const schema = jsonOf(validator);
        expect(schema.required.sort()).toEqual(["count", "flag", "free", "kind", "list", "note", "ratio", "sql", "tags"]);
        expect(schema.additionalProperties).toBe(false);
        expect(schema.properties.count.type).toBe("integer");
        expect(schema.properties.ratio.type).toBe("number");
        expect(JSON.stringify(schema)).not.toMatch(LIMIT_KEYWORDS);
        // optional -> may be null, once (not wrapped twice)
        expect(JSON.stringify(schema.properties.flag)).toMatch(/null|nullable/);
        expect(JSON.stringify(schema.properties.note).match(/null|nullable/g)?.length).toBeGreaterThan(0);
    });

    it("follows unions and nested objects", () => {
        const validator = z.object({ ops: z.array(z.discriminatedUnion("type", [z.object({ type: z.literal("a"), x: z.string().optional() }), z.object({ type: z.literal("b"), y: z.number() })])) });
        const schema = jsonOf(validator);
        const variants = schema.properties.ops.items.anyOf as Json[];
        expect(variants).toHaveLength(2);
        for (const variant of variants) {
            expect(variant.additionalProperties).toBe(false);
            expect([...variant.required].sort()).toEqual(Object.keys(variant.properties).sort());
        }
    });

    it("says which kind of field it cannot describe", () => {
        expect(() => forModel(z.object({ a: z.map(z.string(), z.string()) }))).toThrow(/ZodMap/);
        expect(() => forModel(z.object({ a: z.record(z.string()) }))).toThrow(/ZodRecord/);
    });
});

describe("the schemas the model is given", () => {
    const validators: [string, z.ZodTypeAny][] = [
        ["modernize_query", modernizeQueryResultSchema],
        ["schema_change_plan", aiSchemaPlanModelSchema],
        ["ping", z.object({ ok: z.boolean() })],
    ];

    it.each(validators)("%s is accepted by the SDK's strict mode and has every property required and no open objects", (name, validator) => {
        const built = buildResponseSchema(name, forModel(validator));
        expect(built.name).toBe(name);
        const schema = built.schema as Json;
        expect(schema.type).toBe("object");
        expect(schema.$schema).toBeUndefined();
        const objects = objectsIn(schema);
        expect(objects.length).toBeGreaterThan(0);
        for (const object of objects) {
            expect(object.additionalProperties).toBe(false);
            expect([...object.required].sort()).toEqual(Object.keys(object.properties).sort());
        }
        expect(JSON.stringify(schema)).not.toMatch(LIMIT_KEYWORDS);
    });

    it("the plan schema stays well inside what strict mode allows", () => {
        const schema = jsonOf(aiSchemaPlanModelSchema);
        const properties = objectsIn(schema).reduce((total, object) => total + Object.keys(object.properties).length, 0);
        expect(properties).toBeLessThan(500);
        expect(JSON.stringify(schema).length).toBeLessThan(60_000);
        const operations = schema.properties.operations.items.anyOf as Json[];
        expect(operations.map((operation) => operation.properties.type.const).sort()).toEqual(["add_check", "add_column", "add_index", "add_relationship", "add_unique", "alter_column", "create_table", "drop_column", "drop_constraint", "drop_index", "drop_relationship", "drop_table", "rename_table"]);
    });

    it("the model's plan schema has the same top-level keys as the plan validator", () => {
        const validatorKeys = Object.keys((forModel(aiSchemaPlanSchema) as z.AnyZodObject).shape).sort();
        expect(Object.keys(aiSchemaPlanModelSchema.shape).sort()).toEqual(validatorKeys);
    });
});

describe("stripNulls", () => {
    it("removes null properties at any depth and leaves everything else, including nulls that are list items", () => {
        expect(stripNulls({ a: null, b: { c: null, d: 1 }, e: [{ f: null, g: "x" }], h: [null], i: false, j: "" })).toEqual({ b: { d: 1 }, e: [{ g: "x" }], h: [null], i: false, j: "" });
        expect(stripNulls("text")).toBe("text");
        expect(stripNulls(null)).toBeNull();
    });
});

describe("an answer written to the plan schema", () => {
    // every key present, the ones that do not apply null: what strict mode makes the model write
    const field = { name: "status", dataType: "text", nullable: null, primaryKey: null, unique: null, autoIncrement: null, defaultValue: "'new'", maxLength: null, precision: null, scale: null, unsigned: null, values: null, note: null };
    const unchanged = { newName: null, dataType: null, nullable: null, primaryKey: null, unique: null, autoIncrement: null, defaultValue: null, maxLength: null, precision: null, scale: null, unsigned: null, values: null, note: null };
    const strictPlan = (changes: Json) => ({
        summary: "Do it.",
        assumptions: [],
        warnings: [],
        clarifyingQuestions: [],
        operations: [
            { type: "add_column", tableName: "public.orders", field },
            { type: "alter_column", tableName: "public.orders", columnName: "status", changes: { ...unchanged, dropDefault: null, ...changes } },
        ],
    });

    it("validates once its nulls are removed, and nothing is left that the validator would reject", () => {
        const parsed = aiSchemaPlanSchema.safeParse(normalizePlanOutput(strictPlan({ nullable: false })));
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.operations[0]).toMatchObject({ type: "add_column", field: { name: "status", defaultValue: "'new'" } });
            expect(parsed.data.operations[1]).toMatchObject({ type: "alter_column", changes: { nullable: false } });
            expect("defaultValue" in (parsed.data.operations[1] as Json).changes).toBe(false);
            expect("dropDefault" in (parsed.data.operations[1] as Json).changes).toBe(false);
        }
    });

    it("keeps 'leave the default alone' and 'remove the default' apart, though both have a null defaultValue", () => {
        const left = fromModelPlan(strictPlan({ dropDefault: false })) as Json;
        expect(left.operations[1].changes).not.toHaveProperty("defaultValue");
        const dropped = fromModelPlan(strictPlan({ dropDefault: true })) as Json;
        expect(dropped.operations[1].changes.defaultValue).toBeNull();
        const parsed = aiSchemaPlanSchema.safeParse(normalizePlanOutput(strictPlan({ dropDefault: true })));
        expect(parsed.success && (parsed.data.operations[1] as Json).changes.defaultValue).toBeNull();
    });

    it("still reads an answer from a model that was not given the schema, where a null defaultValue means remove the default", () => {
        const legacy = { summary: "x", operations: [{ type: "alter_column", tableName: "public.t", columnName: "c", changes: { defaultValue: null, nullable: true } }] };
        const parsed = aiSchemaPlanSchema.safeParse(normalizePlanOutput(legacy));
        expect(parsed.success).toBe(true);
        expect(parsed.success && (parsed.data.operations[0] as Json).changes).toEqual({ defaultValue: null, nullable: true });
    });

    it("keeps the clarifying-question answer: no operations", () => {
        const asking = { summary: "Need more.", assumptions: [], warnings: [], clarifyingQuestions: ["Which table?"], operations: [] };
        const parsed = aiSchemaPlanSchema.safeParse(normalizePlanOutput(asking));
        expect(parsed.success && parsed.data.clarifyingQuestions).toEqual(["Which table?"]);
    });
});
