// Importing types from schema definitions
import { DatabaseInsertType, DatabaseType } from "@/lib/schemas/database-schema";
import { FieldType } from "@/lib/schemas/field-schema";
import { RelationshipType } from "@/lib/schemas/relationship-schema";
import { TableType } from "@/lib/schemas/table-schema";
import { excludeFields } from "./utils";
import { IndexType } from "@/lib/schemas/index-schema";
import { FieldIndexType } from "@/lib/schemas/field_index-schema";
import { RelationshipFieldType } from "@/lib/schemas/relationship_field-schema";
import { ViewType } from "@/lib/schemas/view-schema";
import { SequenceType } from "@/lib/schemas/sequence-schema";

// Define the possible operations that can be performed when diffing databases
export type DBDiffOperation =
    | { type: "RENAME_DATABASE", chnages: DatabaseInsertType }
    | { type: 'CREATE_TABLE'; table: TableType }
    | { type: 'DELETE_TABLE'; tableId: string; table?: TableType }
    | { type: 'UPDATE_TABLE'; tableId: string; changes: Partial<TableType>; table?: TableType }
    | { type: 'CREATE_FIELD'; tableId: string; field: FieldType; table?: TableType }
    | { type: 'DELETE_FIELD'; tableId: string; fieldId: string; table?: TableType; field?: FieldType }
    | { type: 'UPDATE_FIELD'; tableId: string; fieldId: string; changes: Partial<FieldType>; table?: TableType; field?: FieldType }
    | { type: 'CREATE_RELATIONSHIP'; relationship: RelationshipType }
    | { type: 'DELETE_RELATIONSHIP'; relationshipId: string }
    | { type: 'UPDATE_RELATIONSHIP'; relationshipId: string; changes: Partial<RelationshipType> }
    | { type: 'UPDATE_RELATIONSHIP_FIELDS'; relationshipId: string; create: RelationshipFieldType[]; delete: string[]; update: { id: string; changes: Partial<RelationshipFieldType> }[] }
    | { type: 'CREATE_VIEW'; view: ViewType }
    | { type: 'DELETE_VIEW'; viewId: string; view?: ViewType }
    | { type: 'UPDATE_VIEW'; viewId: string; changes: Partial<ViewType>; view?: ViewType }
    | { type: 'CREATE_SEQUENCE'; sequence: SequenceType }
    | { type: 'DELETE_SEQUENCE'; sequenceId: string; sequence?: SequenceType }
    | { type: 'UPDATE_SEQUENCE'; sequenceId: string; changes: Partial<SequenceType>; sequence?: SequenceType }
    // New index-related operations:
    | { type: 'CREATE_INDEX'; tableId: string; index: IndexType; table?: TableType }
    | { type: 'DELETE_INDEX'; tableId: string; indexId: string; table?: TableType; index?: IndexType }
    | { type: 'UPDATE_INDEX'; tableId: string; indexId: string; changes: Partial<IndexType> }
    | { type: 'UPDATE_FIELD_INDICES'; tableId: string; indexId: string; create: FieldIndexType[]; delete: string[] }
    | { type: "UPDATE_NUM_TABLES", value: number };

/**
 * Convert a list of low-level JSON patch operations into higher-level database diff operations
 */
export function mapDiffToDBDiffOperation(patch: any[]): DBDiffOperation[] {
    const operations: DBDiffOperation[] = [];

    // Track changes for tables, fields, and relationships
    const tableChanges: Record<string, Partial<TableType>> = {};
    const fieldChanges: Record<string, Record<string, Partial<FieldType>>> = {};
    const fieldCreates: Record<string, FieldType[]> = {};
    const fieldDeletes: Record<string, string[]> = {};
    const relationshipChanges: Record<string, Partial<RelationshipType>> = {};
    const relationshipCreates: RelationshipType[] = [];
    const relationshipDeletes: string[] = [];
    const relationshipFieldMutations: Record<string, {
        create: RelationshipFieldType[];
        delete: string[];
        update: { id: string; changes: Partial<RelationshipFieldType> }[];
    }> = {};
    const viewChanges: Record<string, Partial<ViewType>> = {};
    const viewCreates: ViewType[] = [];
    const viewDeletes: string[] = [];
    const sequenceChanges: Record<string, Partial<SequenceType>> = {};
    const sequenceCreates: SequenceType[] = [];
    const sequenceDeletes: string[] = [];

    // Keep track of index changes
    const indexChanges: Record<string, Record<string, Partial<IndexType>>> = {};
    const indexCreates: Record<string, IndexType[]> = {};
    const indexDeletes: Record<string, string[]> = {};
    const fieldIndexMutations: Record<string, Record<string, {
        create: FieldIndexType[];
        delete: string[];
    }>> = {};

    // Loop through each patch operation
    for (const op of patch) {
        const parts = op.path.split('/').filter(Boolean); // Split JSON path into parts

        if (op.op == "replace" && parts[0] == "name") {
            operations.push({ type: "RENAME_DATABASE", chnages: { name: op.value } as DatabaseInsertType })
        }

        if (op.op == "replace" && parts[0] == "numOfTables")
            operations.push({ type: "UPDATE_NUM_TABLES", value: op.value })
        // Handle table-related changes
        else if (parts[0] == "tables") {
            const tableId = parts[1];

            // Whole table operations (add/delete table)
            if (parts.length === 2) {
                if (op.op === 'add') {
                    operations.push({ type: 'CREATE_TABLE', table: op.value });
                } else if (op.op === 'remove') {
                    operations.push({ type: 'DELETE_TABLE', tableId });
                }
            }

            // Field-related operations inside a table
            else if (parts[2] === 'fields') {
                const fieldId = parts[3];

                if (parts.length === 4) {
                    if (op.op === 'add') {
                        fieldCreates[tableId] ??= [];
                        fieldCreates[tableId].push(op.value);
                    } else if (op.op === 'remove') {
                        fieldDeletes[tableId] ??= [];
                        fieldDeletes[tableId].push(fieldId);
                    }
                } else if (['add', 'remove', 'replace'].includes(op.op)) {
                    const attr = parts.slice(4).join('/');
                    fieldChanges[tableId] ??= {};
                    fieldChanges[tableId][fieldId] ??= {};
                    fieldChanges[tableId][fieldId][attr as keyof FieldType] = op.op === 'remove' ? null : op.value;
                }
            }
            // Handle indices inside tables
            else if (parts[2] === 'indices') {

                const indexId = parts[3];
                if (parts.length === 3) {
                    // Whole indices array replaced? Treat as table attribute update
                    if (op.op === 'replace') {
                        tableChanges[tableId] ??= {};
                        tableChanges[tableId]['indices' as keyof TableType] = op.value;
                    }
                } else if (parts.length === 4) {
                    // index-level add/remove/replace
                    if (op.op === 'add') {
                        indexCreates[tableId] ??= [];
                        indexCreates[tableId].push(op.value);
                    } else if (op.op === 'remove') {
                        indexDeletes[tableId] ??= [];
                        indexDeletes[tableId].push(indexId);
                    } else if (op.op === 'replace') {
                        // full index replaced? treat as update with full new index?
                        indexChanges[tableId] ??= {};
                        indexChanges[tableId][indexId] = op.value;
                    }
                }

                // Inside the 'indices' handler
                else if (parts.length === 6 && parts[4] === 'fieldIndices') {
                    const fieldIndexId = parts[5];

                    fieldIndexMutations[tableId] ??= {};
                    fieldIndexMutations[tableId][indexId] ??= { create: [], delete: [] };

                    if (op.op === 'add') {
                        fieldIndexMutations[tableId][indexId].create.push(op.value);
                    } else if (op.op === 'remove') {
                        fieldIndexMutations[tableId][indexId].delete.push(fieldIndexId);
                    }
                }

                else if (['add', 'remove', 'replace'].includes(op.op)) {
                    // partial index attribute change
                    const attr = parts.slice(4).join('/');
                    indexChanges[tableId] ??= {};
                    indexChanges[tableId][indexId] ??= {};
                    indexChanges[tableId][indexId][attr as keyof IndexType] = op.op === 'remove' ? null : op.value;
                }
            }

            // Updating table attributes (e.g., name, position, etc.)
            else if (['add', 'remove', 'replace'].includes(op.op)) {
                const attr = parts[2];
                tableChanges[tableId] ??= {};
                tableChanges[tableId][attr as keyof TableType] = op.op === 'remove' ? null : op.value;
            }
        }

        // Handle relationship-related changes
        else if (parts[0] === 'relationships') {
            const relationshipId = parts[1];

            // Create or delete the entire relationship
            if (parts.length === 2) {
                if (op.op === 'add') {
                    relationshipCreates.push(op.value);
                } else if (op.op === 'remove') {
                    relationshipDeletes.push(relationshipId);
                }
            }

            // Composite pairs are normalized as relationshipFields/<id> rows. Keep
            // their mutations separate because they live in a child table.
            else if (parts[2] === 'relationshipFields') {
                const relationshipFieldId = parts[3];
                relationshipFieldMutations[relationshipId] ??= { create: [], delete: [], update: [] };
                const mutation = relationshipFieldMutations[relationshipId];

                if (parts.length === 4 && op.op === 'add') {
                    mutation.create.push(op.value);
                } else if (parts.length === 4 && op.op === 'remove') {
                    mutation.delete.push(relationshipFieldId);
                } else if (parts.length > 4 && ['add', 'remove', 'replace'].includes(op.op)) {
                    mutation.update.push({
                        id: relationshipFieldId,
                        changes: { [parts.slice(4).join('/')]: op.op === 'remove' ? null : op.value },
                    });
                }
            }
            // Update relationship properties (e.g., type, constraints)
            else if (['add', 'remove', 'replace'].includes(op.op)) {
                const attr = parts.slice(2).join('/');
                relationshipChanges[relationshipId] ??= {};
                relationshipChanges[relationshipId][attr as keyof RelationshipType] = op.op === 'remove' ? null : op.value;
            }
        }

        else if (parts[0] === 'views') {
            const viewId = parts[1];
            if (parts.length === 2) {
                if (op.op === 'add') viewCreates.push(op.value);
                else if (op.op === 'remove') viewDeletes.push(viewId);
            } else if (['add', 'remove', 'replace'].includes(op.op)) {
                const attr = parts.slice(2).join('/');
                viewChanges[viewId] ??= {};
                viewChanges[viewId][attr as keyof ViewType] = op.op === 'remove' ? null : op.value;
            }
        }

        else if (parts[0] === 'sequences') {
            const sequenceId = parts[1];
            if (parts.length === 2) {
                if (op.op === 'add') sequenceCreates.push(op.value);
                else if (op.op === 'remove') sequenceDeletes.push(sequenceId);
            } else if (['add', 'remove', 'replace'].includes(op.op)) {
                const attr = parts.slice(2).join('/');
                sequenceChanges[sequenceId] ??= {};
                sequenceChanges[sequenceId][attr as keyof SequenceType] = op.op === 'remove' ? null : op.value;
            }
        }
    }

    // Push table update operations
    for (const [tableId, changes] of Object.entries(tableChanges)) {
        operations.push({
            type: 'UPDATE_TABLE',
            tableId,
            changes
        });
    }

    // Push field update operations
    for (const [tableId, fields] of Object.entries(fieldChanges)) {
        for (const [fieldId, changes] of Object.entries(fields)) {
            operations.push({
                type: 'UPDATE_FIELD',
                tableId,
                fieldId,
                changes
            });
        }
    }

    // Push field creation operations
    for (const [tableId, fields] of Object.entries(fieldCreates)) {
        for (const field of fields) {
            operations.push({
                type: 'CREATE_FIELD',
                tableId,
                field
            });
        }
    }

    // Push field deletion operations
    for (const [tableId, fieldIds] of Object.entries(fieldDeletes)) {
        for (const fieldId of fieldIds) {
            operations.push({
                type: 'DELETE_FIELD',
                tableId,
                fieldId
            });
        }
    }

    // Index creates
    for (const [tableId, indices] of Object.entries(indexCreates)) {
        for (const index of indices) {
            operations.push({ type: 'CREATE_INDEX', tableId, index });
        }
    }

    // Index deletes
    for (const [tableId, indexIds] of Object.entries(indexDeletes)) {
        for (const indexId of indexIds) {
            operations.push({ type: 'DELETE_INDEX', tableId, indexId });
        }
    }

    // Index updates
    for (const [tableId, indices] of Object.entries(indexChanges)) {
        for (const [indexId, changes] of Object.entries(indices)) {
            operations.push({ type: 'UPDATE_INDEX', tableId, indexId, changes });
        }
    }

    for (const tableId in fieldIndexMutations) {
        for (const indexId in fieldIndexMutations[tableId]) {
            const { create, delete: del } = fieldIndexMutations[tableId][indexId];
            if (create.length || del.length) {
                operations.push({
                    type: 'UPDATE_FIELD_INDICES',
                    tableId,
                    indexId,
                    create,
                    delete: del,
                });
            }
        }
    }

    // Push relationship creation operations
    for (const relationship of relationshipCreates) {
        operations.push({ type: 'CREATE_RELATIONSHIP', relationship });
    }

    // Push relationship deletion operations
    for (const relationshipId of relationshipDeletes) {
        operations.push({ type: 'DELETE_RELATIONSHIP', relationshipId });
    }

    // Push relationship update operations
    for (const [relationshipId, changes] of Object.entries(relationshipChanges)) {
        operations.push({ type: 'UPDATE_RELATIONSHIP', relationshipId, changes });
    }

    for (const [relationshipId, mutation] of Object.entries(relationshipFieldMutations)) {
        operations.push({ type: 'UPDATE_RELATIONSHIP_FIELDS', relationshipId, ...mutation });
    }

    for (const view of viewCreates) operations.push({ type: 'CREATE_VIEW', view });
    for (const viewId of viewDeletes) operations.push({ type: 'DELETE_VIEW', viewId });
    for (const [viewId, changes] of Object.entries(viewChanges)) operations.push({ type: 'UPDATE_VIEW', viewId, changes });
    for (const sequence of sequenceCreates) operations.push({ type: 'CREATE_SEQUENCE', sequence });
    for (const sequenceId of sequenceDeletes) operations.push({ type: 'DELETE_SEQUENCE', sequenceId });
    for (const [sequenceId, changes] of Object.entries(sequenceChanges)) operations.push({ type: 'UPDATE_SEQUENCE', sequenceId, changes });

    return operations;
}

/**
 * Convert a Database object to a normalized form:
 * - Convert arrays to maps keyed by ID for easier access
 * - Exclude some fields from relationships to avoid circular references
 */
export function normalizeDatabase(db: DatabaseType): any {
    return {
        ...db,
        tables: Object.fromEntries(
            db.tables.map(table => [
                table.id,
                {
                    ...table,
                    fields: Object.fromEntries(
                        table.fields.map(field => [field.id, {
                            ...field , 
                            type : undefined 
                        }])
                    ),
                    indices: Object.fromEntries(
                        table.indices.map(index => [index.id, {
                            ...index,

                            fieldIndices: Object.fromEntries(
                                index.fieldIndices.map(fieldIndex => [fieldIndex.id, fieldIndex])
                            ),
                        }])
                    ),
                }
            ])
        ),
        relationships: Object.fromEntries(
            db.relationships.map((rel: RelationshipType) => [
                rel.id,
                {
                    ...excludeFields(rel, {
                        root: ["sourceField", "targetField", "sourceTable", "targetTable", "relationshipFields"]
                    }),
                    relationshipFields: Object.fromEntries(
                        (rel.relationshipFields ?? []).map((relationshipField) => [relationshipField.id, relationshipField])
                    ),
                }
            ])
        ),
        views: Object.fromEntries((db.views ?? []).map((view) => [view.id, view])),
        sequences: Object.fromEntries((db.sequences ?? []).map((sequence) => [sequence.id, sequence])),
    };
}
