import { v4 } from "uuid";
import { randomColor } from "@/lib/colors";
import { DataType } from "@/lib/schemas/data-type-schema";
import { FieldInsertType } from "@/lib/schemas/field-schema";
import { IndexInsertType } from "@/lib/schemas/index-schema";
import { Cardinality, RelationshipInsertType } from "@/lib/schemas/relationship-schema";
import { qualifiedTableName, TableInsertType } from "@/lib/schemas/table-schema";
import { extractViewDependencies, ViewInsertType } from "@/lib/schemas/view-schema";
import { SequenceInsertType } from "@/lib/schemas/sequence-schema";
import { ForeignKeyActions } from "@/lib/field";
import { CHECK_NAME_PATTERN, CheckConstraintInsertType, nextCheckName, validateCheckExpression } from "@/lib/schemas/check-constraint-schema";
import { PostgreSqlImporter, PostgreSQLType } from "./postgresql-importer";
import type {
    IntrospectionResult,
    IntrospectedColumn,
    IntrospectedTable,
} from "@/lib/live-connection-api";

export interface FromIntrospectionResult {
    tables: TableInsertType[];
    relationships: RelationshipInsertType[];
    indexes: IndexInsertType[];
    views: ViewInsertType[];
    sequences: SequenceInsertType[];
    errors: Error[];
}

const UPDATE_RULE_TO_ACTION: Record<string, ForeignKeyActions> = {
    CASCADE: ForeignKeyActions.CASCADE,
    "SET NULL": ForeignKeyActions.SET_NULL,
    "SET DEFAULT": ForeignKeyActions.SET_DEFAULT,
    RESTRICT: ForeignKeyActions.RESTRICT,
    "NO ACTION": ForeignKeyActions.NO_ACTION,
};

function toForeignKeyAction(rule: string): ForeignKeyActions {
    return UPDATE_RULE_TO_ACTION[rule] ?? ForeignKeyActions.NO_ACTION;
}

/**
 * Builds a {tables, relationships, indexes} set from a live Postgres
 * introspection result - shaped identically to BaseSqlImporter.parseSql()'s
 * output, so it can be fed straight into the existing importDatabase()
 * (via adjustTablesPositions() first, same as the paste-SQL import flow).
 */
export function fromIntrospection(result: IntrospectionResult, data_types: DataType[]): FromIntrospectionResult {
    const errors: Error[] = [];
    const importer = new PostgreSqlImporter(data_types);
    const knownEnums: PostgreSQLType[] = result.enums.map((e) => ({ name: e.name, values: e.values }));
    const enumsByName = new Map(result.enums.map((e) => [e.name, e.values]));

    const tables: TableInsertType[] = result.tables.map((table) => buildTable(table, importer, knownEnums, enumsByName, errors));
    const tableIdByName = new Map(tables.map((t) => [qualifiedTableName(t), t.id as string]));
    const fieldIdByTableAndName = new Map<string, string>();
    for (const table of tables) {
        for (const field of (table.fields ?? []) as FieldInsertType[]) {
            fieldIdByTableAndName.set(`${qualifiedTableName(table)}.${field.name}`, field.id as string);
        }
    }

    // A composite FK is reported by introspection as multiple rows sharing one
    // constraintName (one row per column pair), the same shape Postgres exposes
    // via information_schema - group them back into a single relationship, in
    // the column order they were returned.
    const foreignKeysByConstraint = new Map<string, typeof result.foreignKeys>();
    for (const fk of result.foreignKeys) {
        const key = `${fk.sourceTable}.${fk.constraintName}`;
        const group = foreignKeysByConstraint.get(key) ?? [];
        group.push(fk);
        foreignKeysByConstraint.set(key, group);
    }

    const relationships: RelationshipInsertType[] = [];
    for (const fkGroup of foreignKeysByConstraint.values()) {
        const [firstFk, ...restFks] = fkGroup;
        try {
            const relationshipId = v4();
            // Match the existing importer's convention: sourceTable/sourceField is the
            // referenced (parent) side, targetTable/targetField is the FK-holding (child) side.
            const sourceTableId = tableIdByName.get(firstFk.targetTable);
            const sourceFieldId = fieldIdByTableAndName.get(`${firstFk.targetTable}.${firstFk.targetColumn}`);
            const targetTableId = tableIdByName.get(firstFk.sourceTable);
            const targetFieldId = fieldIdByTableAndName.get(`${firstFk.sourceTable}.${firstFk.sourceColumn}`);

            if (!sourceTableId || !sourceFieldId || !targetTableId || !targetFieldId) {
                throw new Error(`Could not resolve foreign key ${firstFk.constraintName}`);
            }

            const relationshipFields = restFks.map((fk, index) => {
                const restSourceFieldId = fieldIdByTableAndName.get(`${fk.targetTable}.${fk.targetColumn}`);
                const restTargetFieldId = fieldIdByTableAndName.get(`${fk.sourceTable}.${fk.sourceColumn}`);
                if (!restSourceFieldId || !restTargetFieldId) {
                    throw new Error(`Could not resolve foreign key ${fk.constraintName}`);
                }
                return {
                    id: v4(),
                    relationshipId,
                    sourceFieldId: restSourceFieldId,
                    targetFieldId: restTargetFieldId,
                    sequence: index + 1,
                };
            });

            const targetIsUnique = isReferencedKeyUnique(
                result,
                firstFk.targetTable,
                fkGroup.map((item) => item.targetColumn),
            );

            relationships.push({
                id: relationshipId,
                name: firstFk.constraintName,
                sourceTableId,
                sourceFieldId,
                targetTableId,
                targetFieldId,
                cardinality: targetIsUnique ? Cardinality.one_to_one : Cardinality.one_to_many,
                onDelete: toForeignKeyAction(firstFk.onDelete),
                onUpdate: toForeignKeyAction(firstFk.onUpdate),
                relationshipFields: relationshipFields.length > 0 ? relationshipFields : undefined,
            } as RelationshipInsertType);
        } catch (err) {
            errors.push(err as Error);
        }
    }

    const indexes: IndexInsertType[] = [];
    for (const idx of result.indexes) {
        try {
            const tableId = tableIdByName.get(idx.tableName);
            if (!tableId) throw new Error(`Index ${idx.indexName} references unknown table ${idx.tableName}`);

            const fieldIds = idx.columns
                .map((col) => fieldIdByTableAndName.get(`${idx.tableName}.${col}`))
                .filter((id): id is string => Boolean(id));

            indexes.push({
                id: v4(),
                name: idx.indexName,
                tableId,
                unique: idx.isUnique,
                fieldIndices: fieldIds.map((fieldId) => ({ id: v4(), fieldId })),
            } as IndexInsertType);
        } catch (err) {
            errors.push(err as Error);
        }
    }

    // Some PostgreSQL drivers expose unique constraints separately from their
    // backing indexes. Add any constraint not already represented by name so a
    // live pull cannot lose a named multi-column UNIQUE constraint.
    for (const table of result.tables) {
        const tableId = tableIdByName.get(table.name);
        if (!tableId) continue;
        for (const constraint of table.uniqueConstraints) {
            const alreadyPresent = indexes.some((index) =>
                index.tableId === tableId &&
                index.name === constraint.name &&
                index.fieldIndices.length === constraint.columns.length &&
                index.fieldIndices.every((fieldIndex, index) =>
                    fieldIndex.fieldId === fieldIdByTableAndName.get(`${qualifiedTableName(table)}.${constraint.columns[index]}`)
                )
            );
            if (alreadyPresent) continue;

            const fieldIndices = constraint.columns.map((column) => fieldIdByTableAndName.get(`${qualifiedTableName(table)}.${column}`));
            if (fieldIndices.some((fieldId) => !fieldId)) {
                errors.push(new Error(`Unique constraint ${constraint.name} references an unknown column`));
                continue;
            }
            indexes.push({
                id: v4(),
                name: constraint.name,
                tableId,
                unique: true,
                fieldIndices: fieldIndices.map((fieldId) => ({ id: v4(), fieldId: fieldId as string })),
            } as IndexInsertType);
        }
    }

    const views: ViewInsertType[] = (result.views ?? []).map((view) => ({
        id: v4(),
        name: view.name,
        namespace: view.namespace ?? undefined,
        materialized: view.materialized,
        definition: view.definition,
        dependencies: JSON.stringify(extractViewDependencies(view.definition)),
    } as ViewInsertType));

    const sequences: SequenceInsertType[] = (result.sequences ?? []).map((sequence) => ({
        id: v4(),
        name: sequence.name,
        namespace: sequence.namespace ?? undefined,
        definition: sequence.definition,
    } as SequenceInsertType));

    return { tables, relationships, indexes, views, sequences, errors };
}

function isReferencedKeyUnique(result: IntrospectionResult, tableName: string, columnNames: string[]): boolean {
    const matches = (columns: string[]) =>
        columns.length === columnNames.length && columns.every((column, index) => column === columnNames[index]);

    const table = result.tables.find((t) =>
        qualifiedTableName(t) === tableName || (!tableName.includes('.') && t.name === tableName)
    );
    if (table?.uniqueConstraints.some((constraint) => matches(constraint.columns))) return true;
    if (matches(table?.primaryKeyColumns ?? [])) return true;
    return result.indexes.some(
        (index) => index.tableName === tableName && index.isUnique && matches(index.columns),
    );
}

function buildTable(
    table: IntrospectedTable,
    importer: PostgreSqlImporter,
    knownEnums: PostgreSQLType[],
    enumsByName: Map<string, string[]>,
    errors: Error[]
): TableInsertType {
    const tableId = v4();

    const fields: FieldInsertType[] = table.columns.map((column) =>
        buildField(column, table, importer, knownEnums, enumsByName, errors)
    );

    for (const pkColumn of table.primaryKeyColumns) {
        const field = fields.find((f) => f.name === pkColumn);
        if (field) {
            field.isPrimary = true;
            field.nullable = false;
        }
    }

    for (const uc of table.uniqueConstraints) {
        if (uc.columns.length === 1) {
            const field = fields.find((f) => f.name === uc.columns[0]);
            if (field) field.unique = true;
        }
    }

    const checks: CheckConstraintInsertType[] = [];
    for (const live of table.checkConstraints ?? []) {
        const problem = validateCheckExpression(live.expression);
        if (problem) {
            errors.push(new Error(`Skipped CHECK constraint "${live.name}" on ${table.name}: ${problem}`));
            continue;
        }
        let name = live.name;
        if (!CHECK_NAME_PATTERN.test(name)) {
            const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^(\d)/, "_$1");
            errors.push(new Error(`CHECK constraint name "${name}" on ${table.name} was renamed to "${sanitized}"`));
            name = sanitized;
        }
        if (checks.some((existing) => existing.name.toLowerCase() === name.toLowerCase())) name = nextCheckName(table.name, checks);
        checks.push({ id: v4(), tableId, name, expression: live.expression.trim() });
    }

    return {
        id: tableId,
        name: table.name,
        namespace: table.namespace ?? undefined,
        fields,
        checks,
        color: randomColor(),
    } as TableInsertType;
}

function buildField(
    column: IntrospectedColumn,
    table: IntrospectedTable,
    importer: PostgreSqlImporter,
    knownEnums: PostgreSQLType[],
    enumsByName: Map<string, string[]>,
    errors: Error[]
): FieldInsertType {
    const dataType: DataType | undefined = importer.resolveDataType(column.udtName, knownEnums);

    if (!dataType) {
        errors.push(new Error(`Unrecognized data type "${column.udtName}" on ${table.name}.${column.name}`));
    }

    const enumValues = enumsByName.get(column.udtName);

    return {
        id: v4(),
        name: column.name,
        typeId: dataType?.id,
        nullable: column.nullable,
        autoIncrement: column.isSerial || column.isIdentity,
        unique: false,
        isPrimary: false,
        maxLength: column.maxLength ?? undefined,
        precision: column.numericPrecision ?? undefined,
        scale: column.numericScale ?? undefined,
        defaultValue: column.isSerial ? undefined : column.defaultValue ?? undefined,
        sequence: column.ordinalPosition,
        values: enumValues ? JSON.stringify(enumValues) : undefined,
    } as FieldInsertType;
}
