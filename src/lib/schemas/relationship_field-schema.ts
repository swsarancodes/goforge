import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { relationships } from './relationship-schema';
import { fields } from './field-schema';
import { InferInsertModel, InferSelectModel, relations } from 'drizzle-orm';

// Composite foreign keys hold an ordered list of source/target column pairs here.
// relationships.sourceFieldId/targetFieldId keep holding the first pair so every
// existing single-column consumer (diagram edges, cascade deletes, the relationship
// modal) keeps working untouched; this table only carries the extra pairs beyond
// that first one for a multi-column FK.
export const relationship_fields = sqliteTable("relationship_fields", {
    id: text('id')
        .primaryKey()
        .notNull()
        .unique(),
    relationshipId: text("relationshipId").notNull().references(() => relationships.id, { onDelete: "cascade" }),
    sourceFieldId: text("sourceFieldId").notNull().references(() => fields.id, { onDelete: "cascade" }),
    targetFieldId: text("targetFieldId").notNull().references(() => fields.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull().default(0),
});


export const relationshipFieldsRelations = relations(relationship_fields, ({ one }) => ({
    relationship: one(relationships, {
        fields: [relationship_fields.relationshipId],
        references: [relationships.id]
    }),

    sourceField: one(fields, {
        fields: [relationship_fields.sourceFieldId],
        references: [fields.id]
    }),

    targetField: one(fields, {
        fields: [relationship_fields.targetFieldId],
        references: [fields.id]
    }),
}))


export interface RelationshipFieldType extends InferSelectModel<typeof relationship_fields> { };


export interface RelationshipFieldInsertType extends InferInsertModel<typeof relationship_fields> { };

/** Accept the row-array shape used by the app and the id-keyed shape used by snapshots. */
export function relationshipFieldValues(
    value: RelationshipFieldInsertType[] | Record<string, RelationshipFieldInsertType> | undefined,
): RelationshipFieldInsertType[] {
    if (!value) return [];
    return Array.isArray(value) ? value : Object.values(value);
}

/** Validate the extra pairs; the relationship's first pair is stored on its parent row. */
export function validateRelationshipFields(
    value: RelationshipFieldInsertType[] | Record<string, RelationshipFieldInsertType> | undefined,
    firstSourceFieldId?: string,
    firstTargetFieldId?: string,
): RelationshipFieldInsertType[] {
    const fields = relationshipFieldValues(value).slice().sort((a, b) => a.sequence - b.sequence);
    const sourceIds = new Set<string>(firstSourceFieldId ? [firstSourceFieldId] : []);
    const targetIds = new Set<string>(firstTargetFieldId ? [firstTargetFieldId] : []);

    fields.forEach((field, index) => {
        if (!field.id || !field.sourceFieldId || !field.targetFieldId) {
            throw new Error('Composite foreign-key pairs require an id and both field ids');
        }
        if (field.sequence !== index + 1) {
            throw new Error('Composite foreign-key pairs must use contiguous sequence values starting at 1');
        }
        if (sourceIds.has(field.sourceFieldId) || targetIds.has(field.targetFieldId)) {
            throw new Error('Composite foreign-key pairs cannot reuse a source or target field');
        }
        sourceIds.add(field.sourceFieldId);
        targetIds.add(field.targetFieldId);
    });

    return fields;
}

/** Validate rows in an incremental diff without requiring the existing rows. */
export function validateRelationshipFieldRows(value: RelationshipFieldInsertType[]): void {
    const sourceIds = new Set<string>();
    const targetIds = new Set<string>();
    value.forEach((field) => {
        if (!field.id || !field.sourceFieldId || !field.targetFieldId || !Number.isInteger(field.sequence) || field.sequence < 1) {
            throw new Error('Composite foreign-key pairs require valid ids and a positive sequence');
        }
        if (sourceIds.has(field.sourceFieldId) || targetIds.has(field.targetFieldId)) {
            throw new Error('Composite foreign-key pairs cannot reuse a source or target field');
        }
        sourceIds.add(field.sourceFieldId);
        targetIds.add(field.targetFieldId);
    });
}
