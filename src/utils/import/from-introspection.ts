import { v4 } from "uuid";
import { randomColor } from "@/lib/colors";
import { DataType } from "@/lib/schemas/data-type-schema";
import { FieldInsertType } from "@/lib/schemas/field-schema";
import { IndexInsertType } from "@/lib/schemas/index-schema";
import { Cardinality, RelationshipInsertType } from "@/lib/schemas/relationship-schema";
import { TableInsertType } from "@/lib/schemas/table-schema";
import { ForeignKeyActions } from "@/lib/field";
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
    const tableIdByName = new Map(tables.map((t) => [t.name as string, t.id as string]));
    const fieldIdByTableAndName = new Map<string, string>();
    for (const table of tables) {
        for (const field of (table.fields ?? []) as FieldInsertType[]) {
            fieldIdByTableAndName.set(`${table.name}.${field.name}`, field.id as string);
        }
    }

    const relationships: RelationshipInsertType[] = [];
    for (const fk of result.foreignKeys) {
        try {
            // Match the existing importer's convention: sourceTable/sourceField is the
            // referenced (parent) side, targetTable/targetField is the FK-holding (child) side.
            const sourceTableId = tableIdByName.get(fk.targetTable);
            const sourceFieldId = fieldIdByTableAndName.get(`${fk.targetTable}.${fk.targetColumn}`);
            const targetTableId = tableIdByName.get(fk.sourceTable);
            const targetFieldId = fieldIdByTableAndName.get(`${fk.sourceTable}.${fk.sourceColumn}`);

            if (!sourceTableId || !sourceFieldId || !targetTableId || !targetFieldId) {
                throw new Error(`Could not resolve foreign key ${fk.constraintName}`);
            }

            const targetIsUnique = isColumnUnique(result, fk.sourceTable, fk.sourceColumn);

            relationships.push({
                id: v4(),
                name: fk.constraintName,
                sourceTableId,
                sourceFieldId,
                targetTableId,
                targetFieldId,
                cardinality: targetIsUnique ? Cardinality.one_to_one : Cardinality.one_to_many,
                onDelete: toForeignKeyAction(fk.onDelete),
                onUpdate: toForeignKeyAction(fk.onUpdate),
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

    return { tables, relationships, indexes, errors };
}

function isColumnUnique(result: IntrospectionResult, tableName: string, columnName: string): boolean {
    const table = result.tables.find((t) => t.name === tableName);
    if (table?.uniqueConstraints.some((uc) => uc.columns.length === 1 && uc.columns[0] === columnName)) {
        return true;
    }
    return result.indexes.some(
        (idx) => idx.tableName === tableName && idx.isUnique && idx.columns.length === 1 && idx.columns[0] === columnName
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

    return {
        id: tableId,
        name: table.name,
        fields,
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
