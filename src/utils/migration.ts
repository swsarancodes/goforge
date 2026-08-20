import { DatabaseType } from "@/lib/schemas/database-schema";
import { FieldType } from "@/lib/schemas/field-schema";
import { RelationshipType } from "@/lib/schemas/relationship-schema";
import { TableType } from "@/lib/schemas/table-schema";
import { decomposeManyToMany, getDefaultRelationshipName } from "./relationship";
import _ from "lodash";
import { DBDiffOperation } from "./database";
import { DataType } from "@/lib/schemas/data-type-schema";
import { IndexType } from "@/lib/schemas/index-schema";
import { FieldIndexType } from "@/lib/schemas/field_index-schema";
import { DatabaseDialect } from "@/lib/database";


export const prepareForMigration = (db: DatabaseType) => {

    let database = _.cloneDeep(db);

    database.tables = database.tables.map((table: any) => {
        delete table.sequence;
        table.fields = table.fields.map((field: any) => {
            delete field.sequence;
            delete field.note;
            return field;
        })
        return table;
    });

    database.relationships = database.relationships.map((relationship: RelationshipType) => {

        if (relationship.name)
            return relationship;

        relationship.sourceTable = database.tables.find((table: TableType) => table.id == relationship.sourceTableId) as TableType;
        relationship.targetTable = database.tables.find((table: TableType) => table.id == relationship.targetTableId) as TableType;

        relationship.sourceField = relationship.sourceTable.fields.find((field: FieldType) => field.id == relationship.sourceFieldId) as FieldType;
        relationship.targetField = relationship.targetTable.fields.find((field: FieldType) => field.id == relationship.targetFieldId) as FieldType;

        relationship.name = getDefaultRelationshipName(relationship)
        return relationship;
    });

    database = decomposeManyToMany(database);

    return database;
}

// enrich a database operations is : 
// - adding the type to the fields . 
// - adding  sourceField , targetField , sourceTable , targetTable to the relationships 
export const optimizeOps = (operations: DBDiffOperation[], currentDatabase: DatabaseType, previousDatabase: DatabaseType, data_types: DataType[]): DBDiffOperation[] => {
    let ops: DBDiffOperation[] = [];



    const schemaOperations = operations.filter((operation: DBDiffOperation) => (operation.type != "UPDATE_FIELD_INDICES") && !(
        operation.type == "UPDATE_FIELD" && operation.changes.isPrimary !== undefined && Object.keys(operation.changes).length == 1
    ));

 

    for (let index = 0; index < schemaOperations.length; index++) {

        const operation: DBDiffOperation = _.cloneDeep(schemaOperations[index]);

        if (operation.type == "UPDATE_NUM_TABLES")
            continue;
        if (operation.type == "RENAME_DATABASE")
            continue;

 

        if (operation.type == "CREATE_TABLE") {
            operation.table.fields = Object.values(operation.table.fields).map((field: FieldType) => ({
                ...field,
                type: data_types.find((type: DataType) => type.id == field.typeId)
            })) as FieldType[];

            operation.table.indices = Object.values(operation.table.indices).map((indice: IndexType) => ({
                ...indice,
                fieldIndices: Object.values(indice.fieldIndices),

            }))
            operation.table.indices = operation.table.indices.map((index: IndexType) => ({
                ...index,
                fields: index.fieldIndices.map((fieldIndex: FieldIndexType) => operation.table.fields.find((field: FieldType) => field.id == fieldIndex.fieldId)) as FieldType[]
            }))
        }

        if (operation.type == "CREATE_RELATIONSHIP") {

            // try to get the sourceTable from the previous database 
            let sourceTable: TableType | undefined = previousDatabase.tables.find((table: TableType) => table.id == operation.relationship.sourceTableId);
            if (!sourceTable) {
                // if the source table is not found that mean it's a new table created in this migration 
                // so we need to get it from the currentDatabase 
                sourceTable = currentDatabase.tables.find((table: TableType) => table.id == operation.relationship.sourceTableId) as TableType;
            }

            let sourceField: FieldType | undefined = sourceTable.fields.find((field: FieldType) => field.id == operation.relationship.sourceFieldId);
            if (!sourceField) {
                // if the source field is not found , then it could be a new field created in this new migration  
                // so what we need to do it is we need to get it from the current Database , 
                const currentSourceTable: TableType = currentDatabase.tables.find((table: TableType) => table.id == operation.relationship.sourceTableId) as TableType;
                sourceField = currentSourceTable.fields.find((field: FieldType) => field.id == operation.relationship.sourceFieldId);
            }

            // now we do the same thing for the target table and field . 
            let targetTable: TableType | undefined = previousDatabase.tables.find((table: TableType) => table.id == operation.relationship.targetTableId) as TableType;
            // if not found , the target table culd be a new table created in this migration 
            if (!targetTable) {
                targetTable = currentDatabase.tables.find((table: TableType) => table.id == operation.relationship.targetTableId) as TableType;
            }
            let targetField: FieldType | undefined = targetTable.fields.find((field: FieldType) => field.id == operation.relationship.targetFieldId);
            if (!targetField) {
                // it can be a new field , so we need to get it from the current migration . 
                const currentTargetTable: TableType = currentDatabase.tables.find((table: TableType) => table.id == operation.relationship.targetTableId) as TableType;
                targetField = currentTargetTable.fields.find((field: FieldType) => field.id == operation.relationship.targetFieldId) as FieldType
            }
            operation.relationship.sourceTable = sourceTable;
            operation.relationship.targetTable = targetTable;

            operation.relationship.sourceField = sourceField as FieldType;
            operation.relationship.targetField = targetField as FieldType;
        }

        // For everything below: the entity being changed/removed lives in previousDatabase
        // (the pre-change / live-DB state); newly created entities only exist in currentDatabase.
        const findTable = (tableId: string): TableType | undefined =>
            previousDatabase.tables.find((table: TableType) => table.id == tableId) ??
            currentDatabase.tables.find((table: TableType) => table.id == tableId);

        if (operation.type == "CREATE_FIELD") {
            operation.table = findTable(operation.tableId);
            operation.field = {
                ...operation.field,
                type: data_types.find((type: DataType) => type.id == operation.field.typeId),
            } as FieldType;
        }

        if (operation.type == "DELETE_FIELD" || operation.type == "UPDATE_FIELD") {
            const table = previousDatabase.tables.find((t: TableType) => t.id == operation.tableId);
            operation.table = table ?? findTable(operation.tableId);
            const rawField = table?.fields.find((f: FieldType) => f.id == operation.fieldId);
            operation.field = rawField
                ? { ...rawField, type: data_types.find((type: DataType) => type.id == rawField.typeId) ?? rawField.type }
                : undefined;

            // updateFieldAst() reads changes.type (not just changes.typeId) to know the new
            // data type - the raw json-patch diff only ever carries typeId, so resolve it here.
            if (operation.type == "UPDATE_FIELD" && operation.changes.typeId) {
                (operation.changes as Partial<FieldType>).type = data_types.find((type: DataType) => type.id == operation.changes.typeId);
            }
        }

        if (operation.type == "DELETE_TABLE" || operation.type == "UPDATE_TABLE") {
            operation.table = previousDatabase.tables.find((t: TableType) => t.id == operation.tableId) ?? findTable(operation.tableId);
        }

        if (operation.type == "CREATE_INDEX") {
            // Table name must still be the pre-rename one (UPDATE_TABLE runs last, so the
            // table hasn't been renamed yet at this point in execution) - but column names
            // must reflect currentDatabase, since any UPDATE_FIELD rename on this table
            // already ran (UPDATE_FIELD is ordered before CREATE_INDEX).
            operation.table = findTable(operation.tableId);
            const currentTable = currentDatabase.tables.find((t: TableType) => t.id == operation.tableId);
            const fieldIndices = Object.values(operation.index.fieldIndices ?? {}) as FieldIndexType[];
            operation.index = {
                ...operation.index,
                fieldIndices,
                fields: fieldIndices
                    .map((fi: FieldIndexType) => currentTable?.fields.find((f: FieldType) => f.id == fi.fieldId))
                    .filter(Boolean) as FieldType[],
            };
        }

        if (operation.type == "DELETE_INDEX") {
            const table = previousDatabase.tables.find((t: TableType) => t.id == operation.tableId);
            operation.table = table ?? findTable(operation.tableId);
            operation.index = table?.indices.find((idx: IndexType) => idx.id == operation.indexId);
        }

        ops.push(operation)
    }

    ops = orderOperations(ops)

    return ops;
}

 
const orderOperations = (ops: DBDiffOperation[]): DBDiffOperation[] => {
    const OPERATION_ORDER = [
        // Drops/deletes first, so a dropped index/column never collides with a same-named create.
        'DELETE_INDEX',
        'DELETE_RELATIONSHIP',
        'DELETE_FIELD',
        'DELETE_TABLE',
        // Structural creates
        'CREATE_TABLE',
        'CREATE_FIELD',
        // In-place column alters (may include a column rename) - must run before any
        // index/relationship/table-rename statement that references the column, since
        // those come later and would otherwise refer to a name that no longer exists.
        'UPDATE_FIELD',
        // Relationships/indexes need their tables and columns to exist first
        'CREATE_RELATIONSHIP',
        'CREATE_INDEX',
        // Table rename runs dead last - every other statement above still needs the
        // table's original name to resolve; renaming any earlier breaks all of them.
        'UPDATE_TABLE',
    ];
    return [...ops].sort(
        (a, b) =>
            OPERATION_ORDER.indexOf(a.type) - OPERATION_ORDER.indexOf(b.type)
    );
}







