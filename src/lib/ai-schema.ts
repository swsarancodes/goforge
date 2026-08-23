import { v4 } from "uuid";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { DataType } from "@/lib/schemas/data-type-schema";
import { FieldType } from "@/lib/schemas/field-schema";
import { FieldIndexType } from "@/lib/schemas/field_index-schema";
import { IndexType } from "@/lib/schemas/index-schema";
import { Cardinality, RelationshipType } from "@/lib/schemas/relationship-schema";
import { TableType } from "@/lib/schemas/table-schema";
import { ForeignKeyActions } from "@/lib/field";

export interface AiFieldSpec {
    name: string;
    dataType: string;
    nullable?: boolean;
    primaryKey?: boolean;
    unique?: boolean;
    autoIncrement?: boolean;
    defaultValue?: string | null;
    maxLength?: number | null;
    precision?: number | null;
    scale?: number | null;
    unsigned?: boolean;
    values?: string[];
    note?: string | null;
}

export interface AiIndexSpec {
    name: string;
    columns: string[];
    unique?: boolean;
}

export interface AiRelationshipSpec {
    name?: string | null;
    sourceTable: string;
    sourceColumn: string;
    targetTable: string;
    targetColumn: string;
    cardinality?: Cardinality;
    onDelete?: ForeignKeyActions;
    onUpdate?: ForeignKeyActions;
}

export type AiSchemaOperation =
    | { type: "create_table"; table: { name: string; note?: string | null; fields: AiFieldSpec[]; indexes?: AiIndexSpec[] } }
    | { type: "rename_table"; tableName: string; newName: string }
    | { type: "drop_table"; tableName: string }
    | { type: "add_column"; tableName: string; field: AiFieldSpec }
    | { type: "alter_column"; tableName: string; columnName: string; changes: Partial<Omit<AiFieldSpec, "name">> & { newName?: string } }
    | { type: "drop_column"; tableName: string; columnName: string }
    | { type: "add_relationship"; relationship: AiRelationshipSpec }
    | { type: "drop_relationship"; sourceTable: string; sourceColumn: string; targetTable: string; targetColumn: string }
    | { type: "add_index"; tableName: string; index: AiIndexSpec }
    | { type: "drop_index"; tableName: string; indexName: string };

export interface AiSchemaPlan {
    summary: string;
    assumptions: string[];
    warnings: string[];
    operations: AiSchemaOperation[];
}

export interface AiSchemaPlanResponse {
    plan: AiSchemaPlan;
    model: string;
}

export interface AiSchemaContext {
    prompt: string;
    dialect: DatabaseType["dialect"];
    databaseName: string;
    tables: Array<{
        name: string;
        note: string | null;
        fields: Array<{
            name: string;
            dataType: string;
            nullable: boolean;
            primaryKey: boolean;
            unique: boolean;
            autoIncrement: boolean;
            defaultValue: string | null;
            maxLength: number | null;
            precision: number | null;
            scale: number | null;
        }>;
        indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
    }>;
    relationships: AiRelationshipSpec[];
    allowedDataTypes: string[];
    selectedTables?: string[];
}

export class AiPlanValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AiPlanValidationError";
    }
}

const normalizeName = (name: string) => name.trim().toLocaleLowerCase();

const parseStringArray = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    if (typeof value !== "string" || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
};

export function buildAiSchemaContext(
    prompt: string,
    database: DatabaseType,
    dataTypes: DataType[],
    selectedTables: string[] = [],
): AiSchemaContext {
    const tableById = new Map(database.tables.map((table) => [table.id, table]));

    return {
        prompt,
        dialect: database.dialect,
        databaseName: database.name,
        tables: database.tables.map((table) => ({
            name: table.name,
            note: table.note ?? null,
            fields: table.fields.map((field) => ({
                name: field.name,
                dataType: field.type?.name ?? dataTypes.find((type) => type.id === field.typeId)?.name ?? "unknown",
                nullable: field.nullable ?? true,
                primaryKey: field.isPrimary ?? false,
                unique: field.unique ?? false,
                autoIncrement: field.autoIncrement ?? false,
                defaultValue: field.defaultValue ?? null,
                maxLength: field.maxLength ?? null,
                precision: field.precision ?? null,
                scale: field.scale ?? null,
            })),
            indexes: table.indices.map((index) => ({
                name: index.name,
                columns: index.fieldIndices
                    .map((fieldIndex) => table.fields.find((field) => field.id === fieldIndex.fieldId)?.name)
                    .filter((name): name is string => Boolean(name)),
                unique: index.unique ?? false,
            })),
        })),
        relationships: database.relationships.map((relationship) => {
            const sourceTable = tableById.get(relationship.sourceTableId);
            const targetTable = tableById.get(relationship.targetTableId);
            return {
                name: relationship.name,
                sourceTable: sourceTable?.name ?? relationship.sourceTable?.name ?? relationship.sourceTableId,
                sourceColumn: sourceTable?.fields.find((field) => field.id === relationship.sourceFieldId)?.name
                    ?? relationship.sourceField?.name
                    ?? relationship.sourceFieldId,
                targetTable: targetTable?.name ?? relationship.targetTable?.name ?? relationship.targetTableId,
                targetColumn: targetTable?.fields.find((field) => field.id === relationship.targetFieldId)?.name
                    ?? relationship.targetField?.name
                    ?? relationship.targetFieldId,
                cardinality: relationship.cardinality as Cardinality,
                ...(relationship.onDelete ? { onDelete: relationship.onDelete as ForeignKeyActions } : {}),
                ...(relationship.onUpdate ? { onUpdate: relationship.onUpdate as ForeignKeyActions } : {}),
            };
        }),
        allowedDataTypes: [...new Set(dataTypes.map((type) => type.name).filter((name): name is string => Boolean(name)))],
        selectedTables,
    };
}

function resolveDataType(name: string, dataTypes: DataType[]): DataType {
    const normalized = normalizeName(name).replace(/\s*\(.+\)$/, "");
    const match = dataTypes.find((type) => {
        if (type.name && normalizeName(type.name) === normalized) return true;
        return parseStringArray(type.synonyms).some((synonym) => normalizeName(synonym) === normalized);
    });

    if (!match) throw new AiPlanValidationError(`Unsupported data type "${name}" for this database dialect.`);
    return match;
}

function findTable(database: DatabaseType, name: string): TableType {
    const table = database.tables.find((candidate) => normalizeName(candidate.name) === normalizeName(name));
    if (!table) throw new AiPlanValidationError(`Table "${name}" does not exist.`);
    return table;
}

function findField(table: TableType, name: string): FieldType {
    const field = table.fields.find((candidate) => normalizeName(candidate.name) === normalizeName(name));
    if (!field) throw new AiPlanValidationError(`Column "${table.name}.${name}" does not exist.`);
    return field;
}

function makeField(spec: AiFieldSpec, tableId: string, sequence: number, dataTypes: DataType[]): FieldType {
    const type = resolveDataType(spec.dataType, dataTypes);
    return {
        id: v4(),
        tableId,
        name: spec.name,
        typeId: type.id,
        type,
        nullable: spec.nullable ?? !spec.primaryKey,
        isPrimary: spec.primaryKey ?? false,
        unique: spec.unique ?? false,
        autoIncrement: spec.autoIncrement ?? false,
        defaultValue: spec.defaultValue ?? null,
        maxLength: spec.maxLength ?? null,
        precision: spec.precision ?? null,
        scale: spec.scale ?? null,
        unsigned: spec.unsigned ?? false,
        zeroFill: false,
        isForeign: false,
        charset: null,
        collate: null,
        values: spec.values ? JSON.stringify(spec.values) : null,
        note: spec.note ?? null,
        sequence,
    } as FieldType;
}

function makeIndex(spec: AiIndexSpec, table: TableType): IndexType {
    if (table.indices.some((index) => normalizeName(index.name) === normalizeName(spec.name))) {
        throw new AiPlanValidationError(`Index "${table.name}.${spec.name}" already exists.`);
    }
    const indexId = v4();
    const fields = spec.columns.map((column) => findField(table, column));
    const fieldIndices = fields.map((field) => ({ id: v4(), indexId, fieldId: field.id }) as FieldIndexType);
    return {
        id: indexId,
        tableId: table.id,
        name: spec.name,
        unique: spec.unique ?? false,
        createdAt: new Date().toISOString(),
        fields,
        fieldIndices,
    } as IndexType;
}

function refreshRelationshipReferences(database: DatabaseType): void {
    database.relationships = database.relationships.map((relationship) => {
        const sourceTable = database.tables.find((table) => table.id === relationship.sourceTableId);
        const targetTable = database.tables.find((table) => table.id === relationship.targetTableId);
        const sourceField = sourceTable?.fields.find((field) => field.id === relationship.sourceFieldId);
        const targetField = targetTable?.fields.find((field) => field.id === relationship.targetFieldId);
        if (!sourceTable || !targetTable || !sourceField || !targetField) {
            throw new AiPlanValidationError(`Relationship "${relationship.name ?? relationship.id}" references a missing table or column.`);
        }
        return { ...relationship, sourceTable, targetTable, sourceField, targetField };
    });
}

export function applyAiSchemaPlan(
    currentDatabase: DatabaseType,
    plan: AiSchemaPlan,
    dataTypes: DataType[],
): { database: DatabaseType; warnings: string[] } {
    const database = structuredClone(currentDatabase);
    const warnings = [...plan.warnings];

    for (const operation of plan.operations) {
        switch (operation.type) {
            case "create_table": {
                if (database.tables.some((table) => normalizeName(table.name) === normalizeName(operation.table.name))) {
                    throw new AiPlanValidationError(`Table "${operation.table.name}" already exists.`);
                }
                const tableId = v4();
                const maxX = database.tables.reduce((max, table) => Math.max(max, (table.posX ?? 0) + (table.width ?? 260)), 0);
                const table = {
                    id: tableId,
                    databaseId: database.id,
                    name: operation.table.name,
                    note: operation.table.note ?? null,
                    posX: maxX + 80,
                    posY: (database.tables.length % 4) * 220,
                    color: null,
                    width: null,
                    sequence: database.tables.length,
                    createdAt: new Date().toISOString(),
                    fields: operation.table.fields.map((field, index) => makeField(field, tableId, index, dataTypes)),
                    indices: [],
                } as TableType;
                table.indices = (operation.table.indexes ?? []).map((index) => makeIndex(index, table));
                database.tables.push(table);
                break;
            }
            case "rename_table": {
                if (database.tables.some((table) => normalizeName(table.name) === normalizeName(operation.newName))) {
                    throw new AiPlanValidationError(`Table "${operation.newName}" already exists.`);
                }
                findTable(database, operation.tableName).name = operation.newName;
                break;
            }
            case "drop_table": {
                const table = findTable(database, operation.tableName);
                database.tables = database.tables.filter((candidate) => candidate.id !== table.id);
                const removedRelationships = database.relationships.filter(
                    (relationship) => relationship.sourceTableId === table.id || relationship.targetTableId === table.id,
                ).length;
                database.relationships = database.relationships.filter(
                    (relationship) => relationship.sourceTableId !== table.id && relationship.targetTableId !== table.id,
                );
                warnings.push(`Dropping table "${table.name}" also removes ${removedRelationships} relationship(s).`);
                break;
            }
            case "add_column": {
                const table = findTable(database, operation.tableName);
                if (table.fields.some((field) => normalizeName(field.name) === normalizeName(operation.field.name))) {
                    throw new AiPlanValidationError(`Column "${table.name}.${operation.field.name}" already exists.`);
                }
                table.fields.push(makeField(operation.field, table.id, table.fields.length, dataTypes));
                break;
            }
            case "alter_column": {
                const table = findTable(database, operation.tableName);
                const field = findField(table, operation.columnName);
                if (operation.changes.newName) {
                    const conflict = table.fields.some(
                        (candidate) => candidate.id !== field.id && normalizeName(candidate.name) === normalizeName(operation.changes.newName as string),
                    );
                    if (conflict) throw new AiPlanValidationError(`Column "${table.name}.${operation.changes.newName}" already exists.`);
                    field.name = operation.changes.newName;
                }
                if (operation.changes.dataType) {
                    const type = resolveDataType(operation.changes.dataType, dataTypes);
                    field.typeId = type.id;
                    field.type = type;
                }
                if (operation.changes.nullable !== undefined) field.nullable = operation.changes.nullable;
                if (operation.changes.primaryKey !== undefined) field.isPrimary = operation.changes.primaryKey;
                if (operation.changes.unique !== undefined) field.unique = operation.changes.unique;
                if (operation.changes.autoIncrement !== undefined) field.autoIncrement = operation.changes.autoIncrement;
                if (operation.changes.defaultValue !== undefined) field.defaultValue = operation.changes.defaultValue;
                if (operation.changes.maxLength !== undefined) field.maxLength = operation.changes.maxLength;
                if (operation.changes.precision !== undefined) field.precision = operation.changes.precision;
                if (operation.changes.scale !== undefined) field.scale = operation.changes.scale;
                if (operation.changes.unsigned !== undefined) field.unsigned = operation.changes.unsigned;
                if (operation.changes.values !== undefined) field.values = JSON.stringify(operation.changes.values);
                if (operation.changes.note !== undefined) field.note = operation.changes.note;
                break;
            }
            case "drop_column": {
                const table = findTable(database, operation.tableName);
                const field = findField(table, operation.columnName);
                table.fields = table.fields.filter((candidate) => candidate.id !== field.id);
                table.indices = table.indices
                    .map((index) => ({
                        ...index,
                        fields: index.fields?.filter((candidate) => candidate.id !== field.id),
                        fieldIndices: index.fieldIndices.filter((fieldIndex) => fieldIndex.fieldId !== field.id),
                    }))
                    .filter((index) => index.fieldIndices.length > 0);
                const removedRelationships = database.relationships.filter(
                    (relationship) => relationship.sourceFieldId === field.id || relationship.targetFieldId === field.id,
                ).length;
                database.relationships = database.relationships.filter(
                    (relationship) => relationship.sourceFieldId !== field.id && relationship.targetFieldId !== field.id,
                );
                warnings.push(`Dropping column "${table.name}.${field.name}" also removes ${removedRelationships} relationship(s).`);
                break;
            }
            case "add_relationship": {
                const sourceTable = findTable(database, operation.relationship.sourceTable);
                const targetTable = findTable(database, operation.relationship.targetTable);
                const sourceField = findField(sourceTable, operation.relationship.sourceColumn);
                const targetField = findField(targetTable, operation.relationship.targetColumn);
                if (sourceField.typeId !== targetField.typeId) {
                    throw new AiPlanValidationError(
                        `Relationship columns "${sourceTable.name}.${sourceField.name}" and "${targetTable.name}.${targetField.name}" must use the same data type.`,
                    );
                }
                const duplicate = database.relationships.some(
                    (relationship) => relationship.sourceFieldId === sourceField.id && relationship.targetFieldId === targetField.id,
                );
                if (duplicate) throw new AiPlanValidationError("That relationship already exists.");
                database.relationships.push({
                    id: v4(),
                    name: operation.relationship.name ?? null,
                    databaseId: database.id,
                    sourceTableId: sourceTable.id,
                    sourceFieldId: sourceField.id,
                    targetTableId: targetTable.id,
                    targetFieldId: targetField.id,
                    sourceTable,
                    sourceField,
                    targetTable,
                    targetField,
                    cardinality: operation.relationship.cardinality ?? Cardinality.one_to_many,
                    onDelete: operation.relationship.onDelete ?? ForeignKeyActions.NO_ACTION,
                    onUpdate: operation.relationship.onUpdate ?? ForeignKeyActions.NO_ACTION,
                    sourceAliasName: null,
                    targetAliasName: null,
                    createdAt: new Date().toISOString(),
                } as RelationshipType);
                break;
            }
            case "drop_relationship": {
                const sourceTable = findTable(database, operation.sourceTable);
                const targetTable = findTable(database, operation.targetTable);
                const sourceField = findField(sourceTable, operation.sourceColumn);
                const targetField = findField(targetTable, operation.targetColumn);
                const before = database.relationships.length;
                database.relationships = database.relationships.filter(
                    (relationship) => !(relationship.sourceFieldId === sourceField.id && relationship.targetFieldId === targetField.id),
                );
                if (database.relationships.length === before) throw new AiPlanValidationError("The relationship to drop does not exist.");
                break;
            }
            case "add_index": {
                const table = findTable(database, operation.tableName);
                table.indices.push(makeIndex(operation.index, table));
                break;
            }
            case "drop_index": {
                const table = findTable(database, operation.tableName);
                const before = table.indices.length;
                table.indices = table.indices.filter((index) => normalizeName(index.name) !== normalizeName(operation.indexName));
                if (table.indices.length === before) throw new AiPlanValidationError(`Index "${table.name}.${operation.indexName}" does not exist.`);
                break;
            }
        }
    }

    database.numOfTables = database.tables.length;
    refreshRelationshipReferences(database);
    return { database, warnings: [...new Set(warnings)] };
}

export function describeAiOperation(operation: AiSchemaOperation): string {
    switch (operation.type) {
        case "create_table": return `Create table ${operation.table.name}`;
        case "rename_table": return `Rename table ${operation.tableName} to ${operation.newName}`;
        case "drop_table": return `Drop table ${operation.tableName}`;
        case "add_column": return `Add ${operation.tableName}.${operation.field.name}`;
        case "alter_column": return `Alter ${operation.tableName}.${operation.columnName}`;
        case "drop_column": return `Drop ${operation.tableName}.${operation.columnName}`;
        case "add_relationship": return `Relate ${operation.relationship.sourceTable}.${operation.relationship.sourceColumn} to ${operation.relationship.targetTable}.${operation.relationship.targetColumn}`;
        case "drop_relationship": return `Drop relationship ${operation.sourceTable}.${operation.sourceColumn} → ${operation.targetTable}.${operation.targetColumn}`;
        case "add_index": return `Add index ${operation.tableName}.${operation.index.name}`;
        case "drop_index": return `Drop index ${operation.tableName}.${operation.indexName}`;
    }
}

export function isDestructiveAiOperation(operation: AiSchemaOperation): boolean {
    return operation.type === "drop_table" || operation.type === "drop_column" || operation.type === "drop_relationship" || operation.type === "drop_index";
}
