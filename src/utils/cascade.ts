// ─────────────────────────────────────────────────────────────────────────────
// ❗ PowerSync Limitation: Manual Cascade Deletes Required
// 
// PowerSync uses SQLite *views* instead of real tables, which disables support
// for standard SQLite features like FOREIGN KEY constraints and ON DELETE CASCADE.
//
// Because of this, any time we delete a parent record (like a table, field, or index),
// we must manually delete all dependent child records to maintain data integrity.
//
// These functions perform **manual cascade deletes** to avoid orphaned records.
// ─────────────────────────────────────────────────────────────────────────────

import { fields } from "@/lib/schemas/field-schema";
import { QueryResult } from "@powersync/web";
import { ExtractTablesWithRelations, inArray, or } from "drizzle-orm";
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import { tables } from "@/lib/schemas/table-schema";
import { relationships } from "@/lib/schemas/relationship-schema";
import { field_indices } from "@/lib/schemas/field_index-schema";
import { indices } from "@/lib/schemas/index-schema";
import { relationship_fields } from "@/lib/schemas/relationship_field-schema";
import { check_constraints } from "@/lib/schemas/check-constraint-schema";

// ─────────────────────────────────────────────────────────────────────────────
//  deleteFieldsWithCascade
//
// Manually deletes all related data when a field is removed.
// Removes associated relationships (source/target), field-index mappings, then the field itself.
// Used when deleting one or more fields by ID.
// ─────────────────────────────────────────────────────────────────────────────
export const deleteFieldsWithCascade = async (
    ids: string[],
    tx: SQLiteTransaction<'async', QueryResult, any, ExtractTablesWithRelations<any>>
): Promise<QueryResult[]> => {
    // Fetch relationships whose first column pair references one of these fields,
    // so their relationship_fields (the extra composite-FK column pairs) get
    // cleaned up too, not just the relationship row itself.
    const affectedRelationships: { id: string }[] = await tx.select({
        id: relationships.id
    }).from(relationships).where(or(
        inArray(relationships.sourceFieldId, ids),
        inArray(relationships.targetFieldId, ids)
    ));
    const extraRelationshipRows: { relationshipId: string }[] = await tx.select({
        relationshipId: relationship_fields.relationshipId,
    }).from(relationship_fields).where(or(
        inArray(relationship_fields.sourceFieldId, ids),
        inArray(relationship_fields.targetFieldId, ids),
    ));
    const affectedRelationshipIds = [...new Set([
        ...affectedRelationships.map((relationship) => relationship.id),
        ...extraRelationshipRows.map((relationship) => relationship.relationshipId),
    ])];

    const results: QueryResult[] = [];
    if (affectedRelationshipIds.length > 0) {
        results.push(await tx.delete(relationship_fields).where(inArray(relationship_fields.relationshipId, affectedRelationshipIds)));
        results.push(await tx.delete(relationships).where(inArray(relationships.id, affectedRelationshipIds)));
    }
    // A composite FK's extra column pairs can reference a field that isn't the
    // relationship's first pair - those rows need direct cleanup too.
    results.push(await tx.delete(relationship_fields).where(or(
        inArray(relationship_fields.sourceFieldId, ids),
        inArray(relationship_fields.targetFieldId, ids)
    )));
    results.push(await tx.delete(field_indices).where(inArray(field_indices.fieldId, ids)));
    results.push(await tx.delete(fields).where(inArray(fields.id, ids)));
    return results;
};

// ─────────────────────────────────────────────────────────────────────────────
//  deleteTablesWithCascade
//
// Handles deletion of entire tables, and manually cascades to:
// - all fields belonging to the table
// - all indices and CHECK constraints attached to the table
// - all relationships and field-index mappings tied to those fields/indices
//
// This ensures full cleanup when a table is removed in PowerSync context.
// ─────────────────────────────────────────────────────────────────────────────
export const deleteTablesWithCascade = async (
    ids: string[],
    tx: SQLiteTransaction<'async', QueryResult, any, ExtractTablesWithRelations<any>>
): Promise<QueryResult[]> => {

    // Fetch all field IDs belonging to the tables
    let fieldIds: { id: string }[] | string[] = await tx.select({
        id: fields.id
    }).from(fields).where(inArray(fields.tableId, ids));

    // Fetch all index IDs belonging to the tables
    let indicesIds: { id: string }[] | string[] = await tx.select({
        id: indices.id
    }).from(indices).where(inArray(indices.tableId, ids));

    // Normalize into string arrays
    fieldIds = fieldIds.map((fieldId) => fieldId.id);
    indicesIds = indicesIds.map((indexId) => indexId.id);

    // Fetch relationships whose first column pair references one of these fields,
    // so their relationship_fields (the extra composite-FK column pairs) get
    // cleaned up too, not just the relationship row itself.
    const affectedRelationships: { id: string }[] = fieldIds.length > 0 ? await tx.select({
        id: relationships.id
    }).from(relationships).where(or(
        inArray(relationships.sourceFieldId, fieldIds),
        inArray(relationships.targetFieldId, fieldIds)
    )) : [];
    const extraRelationshipRows: { relationshipId: string }[] = fieldIds.length > 0 ? await tx.select({
        relationshipId: relationship_fields.relationshipId,
    }).from(relationship_fields).where(or(
        inArray(relationship_fields.sourceFieldId, fieldIds),
        inArray(relationship_fields.targetFieldId, fieldIds),
    )) : [];
    const affectedRelationshipIds = [...new Set([
        ...affectedRelationships.map((relationship) => relationship.id),
        ...extraRelationshipRows.map((relationship) => relationship.relationshipId),
    ])];

    const results: QueryResult[] = [];
    if (affectedRelationshipIds.length > 0) {
        results.push(await tx.delete(relationship_fields).where(inArray(relationship_fields.relationshipId, affectedRelationshipIds)));
        results.push(await tx.delete(relationships).where(inArray(relationships.id, affectedRelationshipIds)));
    }
    // A composite FK's extra column pairs can reference a field that isn't the
    // relationship's first pair - those rows need direct cleanup too.
    if (fieldIds.length > 0) {
        results.push(await tx.delete(relationship_fields).where(or(
            inArray(relationship_fields.sourceFieldId, fieldIds),
            inArray(relationship_fields.targetFieldId, fieldIds)
        )));
        // Delete all fields in the table
        results.push(await tx.delete(fields).where(inArray(fields.id, fieldIds)));
        // Delete field-index links for those fields
        results.push(await tx.delete(field_indices).where(inArray(field_indices.fieldId, fieldIds)));
    }
    if (indicesIds.length > 0) {
        // Delete all indices belonging to the table
        results.push(await tx.delete(indices).where(inArray(indices.id, indicesIds)));
    }
    // CHECK constraints belong to the table
    results.push(await tx.delete(check_constraints).where(inArray(check_constraints.tableId, ids)));
    // Finally, delete the table(s) themselves
    results.push(await tx.delete(tables).where(inArray(tables.id, ids)));
    return results;
};

// ─────────────────────────────────────────────────────────────────────────────
//  deleteIndicesWithCascade
//
// When removing an index, this ensures that any field-index links are removed
// before the index itself is deleted. Prevents dangling associations.
// ─────────────────────────────────────────────────────────────────────────────
export const deleteIndicesWithCascade = async (
    ids: string[],
    tx: SQLiteTransaction<'async', QueryResult, any, ExtractTablesWithRelations<any>>
): Promise<QueryResult[]> => {
    return Promise.all([
        tx.delete(field_indices).where(inArray(field_indices.indexId, ids)),
        tx.delete(indices).where(inArray(indices.id, ids))
    ]);
};
