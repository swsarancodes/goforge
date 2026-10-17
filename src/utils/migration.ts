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
import { sortViewsTopologically, ViewType } from "@/lib/schemas/view-schema";
import { SequenceType } from "@/lib/schemas/sequence-schema";
import { CheckConstraintType, checkConstraintValues } from "@/lib/schemas/check-constraint-schema";


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

// null, undefined, "" and false all mean "not set" for the optional columns, so a diff that only
// swaps one for another is not a schema change.
const unset = (value: unknown) => value === undefined || value === null || value === "" || value === false;
const differs = (left: unknown, right: unknown) => JSON.stringify(unset(left) ? null : left) !== JSON.stringify(unset(right) ? null : right);
const hasRealChange = (existing: any, changes: Record<string, unknown>, ignored: ReadonlySet<string>) =>
    Object.keys(changes).some((key) => !ignored.has(key) && differs(existing?.[key], changes[key]));

const IGNORED_TABLE_KEYS = new Set(["posX", "posY", "width", "color", "createdAt", "sequence", "note", "databaseId"]);
const IGNORED_FIELD_KEYS = new Set(["sequence", "note", "createdAt", "isForeign", "type", "tableId"]);
const IGNORED_RELATIONSHIP_KEYS = new Set(["sourceAliasName", "targetAliasName", "createdAt", "databaseId", "sourceTable", "targetTable", "sourceField", "targetField", "relationshipFields"]);
const IGNORED_INDEX_KEYS = new Set(["createdAt", "tableId", "fieldIndices", "fields"]);
const IGNORED_VIEW_KEYS = new Set(["note", "dependencies", "createdAt", "databaseId"]);
const IGNORED_SEQUENCE_KEYS = new Set(["note", "createdAt", "databaseId"]);
const IGNORED_CHECK_KEYS = new Set(["createdAt", "tableId"]);

/**
 * True when an operation changes the schema itself, as opposed to layout, notes or
 * bookkeeping. A renderer that cannot produce SQL for such an operation would silently leave
 * a hole in the script, which is exactly what a migration must never do.
 */
export const isSchemaOperation = (operation: DBDiffOperation): boolean => {
    switch (operation.type) {
        case "RENAME_DATABASE":
        case "UPDATE_NUM_TABLES":
            return false;
        case "UPDATE_TABLE":
            return hasRealChange(operation.table, operation.changes as any, IGNORED_TABLE_KEYS);
        case "UPDATE_FIELD":
            return hasRealChange(operation.field, operation.changes as any, IGNORED_FIELD_KEYS);
        case "UPDATE_INDEX":
            return false; // rewritten to drop + create by optimizeOps
        case "UPDATE_FIELD_INDICES":
            return false; // rewritten to drop + create by optimizeOps
        case "UPDATE_RELATIONSHIP":
        case "UPDATE_RELATIONSHIP_FIELDS":
            return false; // rewritten to drop + create by optimizeOps
        case "UPDATE_VIEW":
            return hasRealChange(operation.view, operation.changes as any, IGNORED_VIEW_KEYS);
        case "UPDATE_SEQUENCE":
            return hasRealChange(operation.sequence, operation.changes as any, IGNORED_SEQUENCE_KEYS);
        case "UPDATE_CHECK":
            return hasRealChange(operation.check, operation.changes as any, IGNORED_CHECK_KEYS);
        case "CREATE_RELATIONSHIP":
            return operation.relationship.cardinality !== "many_to_many";
        case "DELETE_RELATIONSHIP":
            return operation.relationship?.cardinality !== "many_to_many";
        default:
            return true;
    }
};

/**
 * Relationship and index edits are not in-place changes in SQL: the constraint or index is
 * dropped and created again. Rewrite them that way up front so every renderer sees only
 * creates and drops, and nothing about a constraint change is silently lost.
 */
const rewriteConstraintUpdates = (operations: DBDiffOperation[], currentDatabase: DatabaseType, previousDatabase: DatabaseType): DBDiffOperation[] => {
    const kept: DBDiffOperation[] = [];
    const relationshipsToRecreate = new Set<string>();
    const indexesToRecreate = new Map<string, string>(); // index id -> table id

    const previousIndex = (tableId: string, indexId: string) =>
        previousDatabase.tables.find((table: TableType) => table.id == tableId)?.indices?.find((index: IndexType) => index.id == indexId);
    const currentIndex = (tableId: string, indexId: string) =>
        currentDatabase.tables.find((table: TableType) => table.id == tableId)?.indices?.find((index: IndexType) => index.id == indexId);

    for (const operation of operations) {
        if (operation.type == "UPDATE_RELATIONSHIP") {
            const previous = previousDatabase.relationships.find((relationship: RelationshipType) => relationship.id == operation.relationshipId);
            if (previous && hasRealChange(previous, operation.changes as any, IGNORED_RELATIONSHIP_KEYS)) relationshipsToRecreate.add(operation.relationshipId);
            continue;
        }
        if (operation.type == "UPDATE_RELATIONSHIP_FIELDS") {
            if (operation.create.length > 0 || operation.delete.length > 0 || operation.update.length > 0) relationshipsToRecreate.add(operation.relationshipId);
            continue;
        }
        if (operation.type == "UPDATE_INDEX") {
            const previous = previousIndex(operation.tableId, operation.indexId);
            if (previous && currentIndex(operation.tableId, operation.indexId) && hasRealChange(previous, operation.changes as any, IGNORED_INDEX_KEYS)) {
                indexesToRecreate.set(operation.indexId, operation.tableId);
            }
            continue;
        }
        if (operation.type == "UPDATE_FIELD_INDICES") {
            if ((operation.create.length > 0 || operation.delete.length > 0) && previousIndex(operation.tableId, operation.indexId) && currentIndex(operation.tableId, operation.indexId)) {
                indexesToRecreate.set(operation.indexId, operation.tableId);
            }
            continue;
        }
        kept.push(operation);
    }

    for (const relationshipId of relationshipsToRecreate) {
        const current = currentDatabase.relationships.find((relationship: RelationshipType) => relationship.id == relationshipId);
        if (!current || !previousDatabase.relationships.some((relationship: RelationshipType) => relationship.id == relationshipId)) continue;
        kept.push({ type: "DELETE_RELATIONSHIP", relationshipId });
        kept.push({ type: "CREATE_RELATIONSHIP", relationship: _.cloneDeep(current) });
    }
    for (const [indexId, tableId] of indexesToRecreate) {
        const current = currentIndex(tableId, indexId);
        if (!current) continue;
        kept.push({ type: "DELETE_INDEX", tableId, indexId });
        kept.push({ type: "CREATE_INDEX", tableId, index: _.cloneDeep(current) });
    }
    return kept;
};

// enrich a database operations is : 
// - adding the type to the fields . 
// - adding  sourceField , targetField , sourceTable , targetTable to the relationships 
export const optimizeOps = (operations: DBDiffOperation[], currentDatabase: DatabaseType, previousDatabase: DatabaseType, data_types: DataType[]): DBDiffOperation[] => {
    let ops: DBDiffOperation[] = [];



    operations = rewriteConstraintUpdates(operations, currentDatabase, previousDatabase);

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
            operation.table.checks = checkConstraintValues<CheckConstraintType>(operation.table.checks as any);

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

            // normalizeDatabase() keys relationshipFields by id (an object map, like
            // indices' fieldIndices) so array order never produces a spurious diff -
            // convert it back to an ordered array for renderers/consumers to use.
            operation.relationship.relationshipFields = Object.values(operation.relationship.relationshipFields ?? {});
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

        if (operation.type == "CREATE_CHECK") {
            operation.table = findTable(operation.tableId);
        }

        if (operation.type == "DELETE_CHECK" || operation.type == "UPDATE_CHECK") {
            const table = previousDatabase.tables.find((t: TableType) => t.id == operation.tableId);
            operation.table = table ?? findTable(operation.tableId);
            const previousChecks = table?.checks ?? [];
            if (operation.type == "DELETE_CHECK" && operation.checkId === "*") {
                // The table's whole checks map was removed: fan out one delete per check.
                for (const check of previousChecks) {
                    ops.push({ type: "DELETE_CHECK", tableId: operation.tableId, checkId: check.id, table: operation.table, check });
                }
                continue;
            }
            operation.check = previousChecks.find((check: CheckConstraintType) => check.id == operation.checkId);
        }

        if (operation.type == "DELETE_VIEW") {
            operation.view = previousDatabase.views?.find((view: ViewType) => view.id === operation.viewId);
        }

        if (operation.type == "UPDATE_VIEW") {
            operation.view = previousDatabase.views?.find((view: ViewType) => view.id === operation.viewId);
        }

        if (operation.type == "DELETE_SEQUENCE" || operation.type == "UPDATE_SEQUENCE") {
            operation.sequence = previousDatabase.sequences?.find((sequence: SequenceType) => sequence.id === operation.sequenceId);
        }

        if (operation.type == "DELETE_RELATIONSHIP") {
            const previous = previousDatabase.relationships.find((relationship: RelationshipType) => relationship.id == operation.relationshipId);
            if (previous) {
                const sourceTable = previousDatabase.tables.find((table: TableType) => table.id == previous.sourceTableId);
                const targetTable = previousDatabase.tables.find((table: TableType) => table.id == previous.targetTableId);
                operation.relationship = {
                    ...previous,
                    sourceTable: sourceTable as TableType,
                    targetTable: targetTable as TableType,
                    sourceField: sourceTable?.fields.find((field: FieldType) => field.id == previous.sourceFieldId) as FieldType,
                    targetField: targetTable?.fields.find((field: FieldType) => field.id == previous.targetFieldId) as FieldType,
                    relationshipFields: Object.values(previous.relationshipFields ?? {}),
                } as RelationshipType;
            }
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
        'CREATE_SCHEMA',
        // Drops/deletes first, so a dropped index/column never collides with a same-named create.
        'DELETE_INDEX',
        'DELETE_CHECK',
        'DELETE_VIEW',
        'DELETE_SEQUENCE',
        'DELETE_RELATIONSHIP',
        'DELETE_FIELD',
        'DELETE_TABLE',
        // Structural creates
        'CREATE_SEQUENCE',
        'CREATE_TABLE',
        'CREATE_FIELD',
        // In-place column alters (may include a column rename) - must run before any
        // index/relationship/table-rename statement that references the column, since
        // those come later and would otherwise refer to a name that no longer exists.
        'UPDATE_FIELD',
        // CHECK constraints may reference columns added or renamed above
        'UPDATE_CHECK',
        'CREATE_CHECK',
        // Relationships/indexes need their tables and columns to exist first
        'CREATE_RELATIONSHIP',
        'CREATE_VIEW',
        'UPDATE_VIEW',
        'UPDATE_SEQUENCE',
        'CREATE_INDEX',
        // Table rename runs dead last - every other statement above still needs the
        // table's original name to resolve; renaming any earlier breaks all of them.
        'UPDATE_TABLE',
    ];

    // Topological ordering for CREATE_VIEW and reverse topological for DELETE_VIEW
    const createViewOps = ops.filter(op => op.type === "CREATE_VIEW") as { type: "CREATE_VIEW"; view: ViewType }[];
    const sortedCreateViews = sortViewsTopologically(createViewOps.map(op => op.view));
    const createViewOrder = new Map(sortedCreateViews.map((v, i) => [v.id, i]));

    const deleteViewOps = ops.filter(op => op.type === "DELETE_VIEW" && op.view) as { type: "DELETE_VIEW"; viewId: string; view: ViewType }[];
    const sortedDeleteViews = sortViewsTopologically(deleteViewOps.map(op => op.view));
    const reverseDeleteViews = [...sortedDeleteViews].reverse();
    const deleteViewOrder = new Map(reverseDeleteViews.map((v, i) => [v.id, i]));

    return [...ops].sort((a, b) => {
        const orderDiff = OPERATION_ORDER.indexOf(a.type) - OPERATION_ORDER.indexOf(b.type);
        if (orderDiff !== 0) return orderDiff;
        if (a.type === "CREATE_VIEW" && b.type === "CREATE_VIEW") {
            return (createViewOrder.get(a.view.id) ?? 0) - (createViewOrder.get(b.view.id) ?? 0);
        }
        if (a.type === "DELETE_VIEW" && b.type === "DELETE_VIEW") {
            const aId = a.view?.id ?? a.viewId;
            const bId = b.view?.id ?? b.viewId;
            return (deleteViewOrder.get(aId) ?? 0) - (deleteViewOrder.get(bId) ?? 0);
        }
        return 0;
    });
}




