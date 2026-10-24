import { stripNulls } from "./structured.js";

/** Models name the parts of an operation in different ways; this folds the common variants into the shape the plan schema expects. */

const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const copyDefined = (source: Record<string, unknown>, keys: string[]) => Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
);

const normalizeOperation = (value: unknown): unknown => {
    const operation = asRecord(value);
    const type = typeof operation.type === "string"
        ? operation.type.trim().toLowerCase().replace(/[\s-]+/g, "_")
        : operation.type;
    const tableName = operation.tableName ?? operation.table;
    const fieldKeys = [
        "dataType", "nullable", "primaryKey", "unique", "autoIncrement", "defaultValue",
        "maxLength", "precision", "scale", "unsigned", "values", "note",
    ];
    const columnName = operation.columnName ?? operation.column ?? operation.name;

    switch (type) {
        case "add_column": {
            const fieldValue = asRecord(operation.field);
            return {
                type,
                tableName,
                field: {
                    name: fieldValue.name ?? columnName,
                    ...copyDefined(operation, fieldKeys),
                    ...fieldValue,
                },
            };
        }
        case "alter_column": {
            const changes = asRecord(operation.changes);
            return {
                type,
                tableName,
                columnName,
                changes: {
                    ...copyDefined(operation, ["newName", ...fieldKeys]),
                    ...changes,
                },
            };
        }
        case "drop_column":
            return { type, tableName, columnName };
        case "rename_table":
            return { type, tableName, newName: operation.newName ?? operation.name };
        case "drop_table":
            return { type, tableName };
        case "create_table": {
            const table = asRecord(operation.table);
            return {
                type,
                table: {
                    name: table.name ?? operation.tableName ?? operation.name,
                    ...copyDefined(operation, ["note", "fields", "indexes"]),
                    ...table,
                },
            };
        }
        case "add_index": {
            const index = asRecord(operation.index);
            return {
                type,
                tableName,
                index: {
                    name: index.name ?? operation.indexName ?? operation.name,
                    columns: index.columns ?? operation.columns,
                    ...(index.unique !== undefined || operation.unique !== undefined
                        ? { unique: index.unique ?? operation.unique }
                        : {}),
                },
            };
        }
        case "drop_index":
            return { type, tableName, indexName: operation.indexName ?? operation.name };
        case "add_relationship":
            return {
                type,
                relationship: {
                    ...copyDefined(operation, [
                        "name", "sourceTable", "sourceColumn", "targetTable", "targetColumn",
                        "cardinality", "onDelete", "onUpdate",
                    ]),
                    ...asRecord(operation.relationship),
                },
            };
        case "drop_relationship":
            return {
                type,
                ...copyDefined(operation, ["sourceTable", "sourceColumn", "targetTable", "targetColumn"]),
            };
        default:
            return value;
    }
};

/**
 * An answer written to the structured-output schema carries every key, the ones that do not apply as null. They are removed so the
 * plan validator sees what it would have seen had they been left out, and `dropDefault` becomes what the validator calls it. An answer
 * not written to that schema (an older model, plain JSON mode) has no `dropDefault` and keeps a null `defaultValue` as it is: there it
 * means "remove the default".
 */
export function fromModelPlan(value: unknown): unknown {
    const plan = asRecord(value);
    if (!Array.isArray(plan.operations)) return stripNulls(value);
    const operations = plan.operations.map((operation) => {
        const record = asRecord(operation);
        const changes = asRecord(record.changes);
        if (record.type !== "alter_column" || Object.keys(changes).length === 0) return stripNulls(operation);
        const { dropDefault, ...rest } = changes;
        const cleaned = asRecord(stripNulls(rest));
        if ("dropDefault" in changes) {
            if (dropDefault === true) cleaned.defaultValue = null;
        } else if (rest.defaultValue === null) cleaned.defaultValue = null;
        return { ...asRecord(stripNulls({ ...record, changes: undefined })), changes: cleaned };
    });
    return { ...asRecord(stripNulls({ ...plan, operations: undefined })), operations };
}

/**
 * A strict structured answer has to put something in every key, and a model that has no default to give often writes "" (an empty
 * string is not a default: a text default is written '' with quotes). A blank default means none was given, so it is removed rather
 * than refused as "the default is empty".
 */
const withoutBlankDefault = (value: unknown): Record<string, unknown> => {
    const record = { ...asRecord(value) };
    if (typeof record.defaultValue === "string" && record.defaultValue.trim() === "") delete record.defaultValue;
    return record;
};

export function dropBlankDefaults(operation: unknown): unknown {
    const record = asRecord(operation);
    switch (record.type) {
        case "add_column":
            return { ...record, field: withoutBlankDefault(record.field) };
        case "alter_column":
            return { ...record, changes: withoutBlankDefault(record.changes) };
        case "create_table": {
            const table = asRecord(record.table);
            return { ...record, table: { ...table, ...(Array.isArray(table.fields) ? { fields: table.fields.map(withoutBlankDefault) } : {}) } };
        }
        default:
            return operation;
    }
}

export function normalizePlanOutput(raw: unknown): unknown {
    const plan = asRecord(fromModelPlan(raw));
    return {
        summary: plan.summary,
        assumptions: plan.assumptions ?? [],
        warnings: plan.warnings ?? [],
        clarifyingQuestions: plan.clarifyingQuestions ?? plan.clarifying_questions ?? plan.questions ?? [],
        operations: Array.isArray(plan.operations) ? plan.operations.map(normalizeOperation).map(dropBlankDefaults) : [],
    };
}

