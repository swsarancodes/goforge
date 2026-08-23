import { z } from "zod";

const identifier = z.string().trim().min(1).max(128);

const normalizeEnumValue = (value: unknown) => typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : value;

const cardinalitySchema = z.preprocess(
    normalizeEnumValue,
    z.enum(["one_to_one", "one_to_many", "many_to_one", "many_to_many"]),
);

const foreignKeyActionSchema = z.preprocess(
    normalizeEnumValue,
    z.enum(["no_action", "cascade", "set_null", "set_default", "restrict"]),
);

export const aiFieldSchema = z.object({
    name: identifier,
    dataType: identifier,
    nullable: z.boolean().optional(),
    primaryKey: z.boolean().optional(),
    unique: z.boolean().optional(),
    autoIncrement: z.boolean().optional(),
    defaultValue: z.string().nullable().optional(),
    maxLength: z.number().int().positive().nullable().optional(),
    precision: z.number().int().positive().nullable().optional(),
    scale: z.number().int().nonnegative().nullable().optional(),
    unsigned: z.boolean().optional(),
    values: z.array(z.string()).max(100).optional(),
    note: z.string().max(2_000).nullable().optional(),
}).strict();

const aiFieldChangesSchema = aiFieldSchema
    .omit({ name: true, dataType: true })
    .extend({
        newName: identifier.optional(),
        dataType: identifier.optional(),
    })
    .strict();

const aiIndexSchema = z.object({
    name: identifier,
    columns: z.array(identifier).min(1).max(32),
    unique: z.boolean().optional(),
}).strict();

const aiRelationshipSchema = z.object({
    name: identifier.nullable().optional(),
    sourceTable: identifier,
    sourceColumn: identifier,
    targetTable: identifier,
    targetColumn: identifier,
    cardinality: cardinalitySchema.optional(),
    onDelete: foreignKeyActionSchema.optional(),
    onUpdate: foreignKeyActionSchema.optional(),
}).strict();

const currentRelationshipSchema = aiRelationshipSchema.extend({
    onDelete: foreignKeyActionSchema.nullable().optional(),
    onUpdate: foreignKeyActionSchema.nullable().optional(),
}).strict();

export const aiSchemaOperationSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("create_table"),
        table: z.object({
            name: identifier,
            note: z.string().max(2_000).nullable().optional(),
            fields: z.array(aiFieldSchema).min(1).max(100),
            indexes: z.array(aiIndexSchema).max(50).optional(),
        }).strict(),
    }).strict(),
    z.object({ type: z.literal("rename_table"), tableName: identifier, newName: identifier }).strict(),
    z.object({ type: z.literal("drop_table"), tableName: identifier }).strict(),
    z.object({ type: z.literal("add_column"), tableName: identifier, field: aiFieldSchema }).strict(),
    z.object({
        type: z.literal("alter_column"),
        tableName: identifier,
        columnName: identifier,
        changes: aiFieldChangesSchema,
    }).strict(),
    z.object({ type: z.literal("drop_column"), tableName: identifier, columnName: identifier }).strict(),
    z.object({ type: z.literal("add_relationship"), relationship: aiRelationshipSchema }).strict(),
    z.object({
        type: z.literal("drop_relationship"),
        sourceTable: identifier,
        sourceColumn: identifier,
        targetTable: identifier,
        targetColumn: identifier,
    }).strict(),
    z.object({ type: z.literal("add_index"), tableName: identifier, index: aiIndexSchema }).strict(),
    z.object({ type: z.literal("drop_index"), tableName: identifier, indexName: identifier }).strict(),
]);

export const aiSchemaPlanSchema = z.object({
    summary: z.string().trim().min(1).max(4_000),
    assumptions: z.array(z.string().max(1_000)).max(20).default([]),
    warnings: z.array(z.string().max(1_000)).max(20).default([]),
    clarifyingQuestions: z.array(z.string().trim().min(1).max(1_000)).max(10).default([]),
    operations: z.array(aiSchemaOperationSchema).max(100),
}).strict().superRefine((plan, context) => {
    if (plan.clarifyingQuestions.length > 0 && plan.operations.length > 0) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["operations"],
            message: "operations must be empty when clarification is required",
        });
    }
});

const currentFieldSchema = z.object({
    name: identifier,
    dataType: identifier,
    nullable: z.boolean(),
    primaryKey: z.boolean(),
    unique: z.boolean(),
    autoIncrement: z.boolean(),
    defaultValue: z.string().nullable(),
    maxLength: z.number().nullable(),
    precision: z.number().nullable(),
    scale: z.number().nullable(),
}).strict();

const currentTableSchema = z.object({
    name: identifier,
    note: z.string().nullable(),
    fields: z.array(currentFieldSchema).max(200),
    indexes: z.array(aiIndexSchema.extend({ unique: z.boolean() })).max(100),
}).strict();

export const aiSchemaPlanRequestSchema = z.object({
    prompt: z.string().trim().min(3).max(8_000),
    scope: z.enum(["database", "selected_tables"]),
    dialect: z.enum(["postgres", "mysql", "sqlite", "mariadb", "mssql", "oracle"]),
    databaseName: identifier,
    tables: z.array(currentTableSchema).max(250),
    relationships: z.array(currentRelationshipSchema).max(500),
    allowedDataTypes: z.array(identifier).min(1).max(500),
    selectedTables: z.array(identifier).max(100).optional(),
}).strict().superRefine((request, context) => {
    if (request.scope === "selected_tables" && (request.selectedTables?.length ?? 0) === 0) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["selectedTables"],
            message: "at least one table is required for selected_tables scope",
        });
    }
    const existingTables = new Set(request.tables.map((table) => table.name.toLowerCase()));
    const unknown = (request.selectedTables ?? []).filter((table) => !existingTables.has(table.toLowerCase()));
    if (unknown.length > 0) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["selectedTables"],
            message: `unknown selected table(s): ${unknown.join(", ")}`,
        });
    }
});

export type AiSchemaPlan = z.infer<typeof aiSchemaPlanSchema>;
export type AiSchemaPlanRequest = z.infer<typeof aiSchemaPlanRequestSchema>;
