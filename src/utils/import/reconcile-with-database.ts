import { qualifiedTableName, TableInsertType } from "@/lib/schemas/table-schema";
import { FieldIndexInsertType } from "@/lib/schemas/field_index-schema";
import { IndexInsertType } from "@/lib/schemas/index-schema";
import { RelationshipInsertType } from "@/lib/schemas/relationship-schema";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { DataType } from "@/lib/schemas/data-type-schema";
import { ViewInsertType } from "@/lib/schemas/view-schema";
import { SequenceInsertType } from "@/lib/schemas/sequence-schema";
import { canonicalCheckExpression, CheckConstraintInsertType, CheckConstraintType, checkConstraintValues } from "@/lib/schemas/check-constraint-schema";

export interface ParsedDatabaseResult {
    tables: TableInsertType[];
    relationships: RelationshipInsertType[];
    indexes: IndexInsertType[];
    views: ViewInsertType[];
    sequences: SequenceInsertType[];
}

/**
 * A fresh `BaseSqlImporter.parseSql()` result has brand new ids for every table/
 * field/relationship/index - it has no idea an existing canvas database already
 * has stable ids for the entities it's re-describing. Diffing that straight
 * against the current database would see every existing entity as deleted and
 * every parsed entity as newly created, wiping table positions/colors and
 * resetting ids on every "edit code, apply" round-trip.
 *
 * This rewrites the parsed result's ids to match the current database's ids
 * wherever a name match is found (table name, field name within that table,
 * same source/target table+field pair for relationships, same column set for
 * indexes), so the downstream diff produces UPDATE ops for edited entities and
 * only CREATE ops for genuinely new ones.
 */
const dataTypeNames = (dataType: DataType | undefined) => {
    if (!dataType) return new Set<string>();
    let synonyms: string[] = [];
    try {
        synonyms = Array.isArray(dataType.synonyms) ? dataType.synonyms : dataType.synonyms ? JSON.parse(dataType.synonyms) : [];
    } catch {
        synonyms = [];
    }
    return new Set([dataType.name, ...synonyms].filter(Boolean).map((name) => name.toLowerCase().replace(/\s+/g, "")));
};

const areEquivalentDataTypes = (left: DataType | undefined, right: DataType | undefined) => {
    const leftNames = dataTypeNames(left);
    const rightNames = dataTypeNames(right);
    return [...leftNames].some((name) => rightNames.has(name));
};

/**
 * Re-attaches parsed CHECK constraints to the ids of the ones already stored: first by
 * name, then by identical expression (a pure rename). When an expression only differs
 * in whitespace/formatting - SQL goes through a formatter on the way out - the stored
 * text wins, so applying unchanged SQL is a no-op instead of a phantom edit.
 */
const reconcileChecks = (parsedChecks: CheckConstraintInsertType[] | undefined, existingChecks: CheckConstraintType[], tableId: string): CheckConstraintInsertType[] => {
    const remaining = [...existingChecks];
    const take = (predicate: (check: CheckConstraintType) => boolean) => {
        const index = remaining.findIndex(predicate);
        return index >= 0 ? remaining.splice(index, 1)[0] : undefined;
    };
    const resolved = checkConstraintValues<CheckConstraintInsertType>(parsedChecks as any);
    const matches = new Map<CheckConstraintInsertType, CheckConstraintType>();
    for (const parsedCheck of resolved) {
        const match = take((existing) => existing.name.toLowerCase() === parsedCheck.name.toLowerCase());
        if (match) matches.set(parsedCheck, match);
    }
    for (const parsedCheck of resolved) {
        if (matches.has(parsedCheck)) continue;
        const wanted = canonicalCheckExpression(parsedCheck.expression);
        const match = take((existing) => canonicalCheckExpression(existing.expression) === wanted);
        if (match) matches.set(parsedCheck, match);
    }
    return resolved.map((parsedCheck) => {
        const existing = matches.get(parsedCheck);
        const sameMeaning = existing && canonicalCheckExpression(existing.expression) === canonicalCheckExpression(parsedCheck.expression);
        return {
            id: existing?.id ?? (parsedCheck.id as string),
            tableId,
            name: parsedCheck.name,
            expression: sameMeaning ? existing.expression : parsedCheck.expression,
            createdAt: existing?.createdAt ?? null,
        };
    });
};

export function reconcileWithDatabase(parsed: ParsedDatabaseResult, currentDatabase: DatabaseType, dataTypes: DataType[] = []): ParsedDatabaseResult {
    const tableIdMap = new Map<string, string>();
    const fieldIdMap = new Map<string, string>();

    const tables: TableInsertType[] = parsed.tables.map((parsedTable) => {
        const existingTable = currentDatabase.tables.find((t) => qualifiedTableName(t) === qualifiedTableName(parsedTable));
        const resolvedTableId = existingTable?.id ?? (parsedTable.id as string);
        tableIdMap.set(parsedTable.id as string, resolvedTableId);

        const fields = (parsedTable.fields ?? []).map((parsedField) => {
            const existingField = existingTable?.fields.find((f) => f.name === parsedField.name);
            const resolvedFieldId = existingField?.id ?? (parsedField.id as string);
            const parsedDataType = dataTypes.find((dataType) => dataType.id === parsedField.typeId);
            const existingDataType = existingField?.type ?? dataTypes.find((dataType) => dataType.id === existingField?.typeId);
            const resolvedTypeId = existingField && areEquivalentDataTypes(existingDataType, parsedDataType) ? existingField.typeId : parsedField.typeId;
            fieldIdMap.set(parsedField.id as string, resolvedFieldId);
            return {
                ...parsedField,
                id: resolvedFieldId,
                tableId: resolvedTableId,
                typeId: resolvedTypeId,
                // SQL does not represent notes and the parser uses undefined for
                // absent nullable/defaulted columns while persisted rows use null.
                // Canonicalizing here prevents a no-op round trip from looking like
                // dozens of property removals.
                note: existingField?.note ?? null,
                defaultValue: parsedField.defaultValue ?? null,
                maxLength: parsedField.maxLength ?? null,
                unsigned: parsedField.unsigned ?? false,
                isForeign: existingField?.isForeign ?? parsedField.isForeign ?? false,
                zeroFill: parsedField.zeroFill ?? false,
                precision: parsedField.precision ?? null,
                scale: parsedField.scale ?? null,
                charset: parsedField.charset ?? null,
                collate: parsedField.collate ?? null,
                values: parsedField.values ?? null,
            };
        });

        return {
            ...parsedTable,
            id: resolvedTableId,
            // databaseId is NOT NULL with no default - BaseSqlImporter never sets it
            // (importDatabase() normally injects it), but executeDbDiffOps() inserts
            // operation.table verbatim, so a genuinely new table without it fails the
            // constraint and the whole diff transaction fails with it.
            databaseId: currentDatabase.id,
            // Preserve the existing table's canvas placement/appearance - an
            // edit-and-apply round-trip shouldn't reshuffle the diagram layout.
            posX: existingTable?.posX ?? parsedTable.posX,
            posY: existingTable?.posY ?? parsedTable.posY,
            color: existingTable ? existingTable.color : parsedTable.color,
            width: existingTable ? existingTable.width : parsedTable.width,
            sequence: existingTable?.sequence ?? parsedTable.sequence,
            note: existingTable?.note ?? null,
            createdAt: existingTable ? existingTable.createdAt : (parsedTable.createdAt ?? null),
            fields,
            checks: reconcileChecks(parsedTable.checks, existingTable?.checks ?? [], resolvedTableId),
        } as TableInsertType;
    });

    const relationships: RelationshipInsertType[] = parsed.relationships.map((rel) => {
        const sourceTableId = tableIdMap.get(rel.sourceTableId as string) ?? rel.sourceTableId;
        const targetTableId = tableIdMap.get(rel.targetTableId as string) ?? rel.targetTableId;
        const sourceFieldId = fieldIdMap.get(rel.sourceFieldId as string) ?? rel.sourceFieldId;
        const targetFieldId = fieldIdMap.get(rel.targetFieldId as string) ?? rel.targetFieldId;

        const existingRelationship = currentDatabase.relationships.find((existing) => existing.sourceTableId === sourceTableId && existing.targetTableId === targetTableId && existing.sourceFieldId === sourceFieldId && existing.targetFieldId === targetFieldId);

        // Remap the extra composite-FK column pairs the same way as the first pair
        // above, matching each pair back to an existing relationship_fields row by
        // its (already-remapped) field ids so ids stay stable across re-imports.
        const remappedRelationshipFields = (rel.relationshipFields ?? []).map((relationshipField) => {
            const remappedSourceFieldId = fieldIdMap.get(relationshipField.sourceFieldId as string) ?? relationshipField.sourceFieldId;
            const remappedTargetFieldId = fieldIdMap.get(relationshipField.targetFieldId as string) ?? relationshipField.targetFieldId;
            const existingRelationshipField = existingRelationship?.relationshipFields?.find(
                (existing) => existing.sourceFieldId === remappedSourceFieldId && existing.targetFieldId === remappedTargetFieldId
            );

            return {
                ...relationshipField,
                id: existingRelationshipField?.id ?? relationshipField.id,
                sourceFieldId: remappedSourceFieldId,
                targetFieldId: remappedTargetFieldId,
            };
        });

        return {
            ...rel,
            id: existingRelationship?.id ?? rel.id,
            // Same NOT NULL gap as tables above - executeDbDiffOps() inserts this
            // object verbatim, so a new relationship needs a real databaseId.
            databaseId: currentDatabase.id,
            sourceTableId,
            targetTableId,
            sourceFieldId,
            targetFieldId,
            relationshipFields: remappedRelationshipFields.length > 0 ? remappedRelationshipFields : undefined,
            name: rel.name ?? existingRelationship?.name ?? null,
            onDelete: rel.onDelete ?? "no_action",
            onUpdate: rel.onUpdate ?? "no_action",
            sourceAliasName: existingRelationship?.sourceAliasName ?? null,
            targetAliasName: existingRelationship?.targetAliasName ?? null,
            createdAt: existingRelationship ? existingRelationship.createdAt : (rel.createdAt ?? null),
        } as RelationshipInsertType;
    });

    const indexes: IndexInsertType[] = parsed.indexes.map((index) => {
        const resolvedTableId = tableIdMap.get(index.tableId as string) ?? index.tableId;
        const remappedFieldIndices = ((index.fieldIndices ?? []) as FieldIndexInsertType[]).map((fi) => ({
            ...fi,
            fieldId: fieldIdMap.get(fi.fieldId as string) ?? fi.fieldId,
        }));

        const parsedColumnFieldIds = new Set(remappedFieldIndices.map((fi) => fi.fieldId));
        const existingTable = currentDatabase.tables.find((t) => t.id === resolvedTableId);
        const existingIndex = existingTable?.indices.find((existing) => {
            const existingFieldIds = new Set(existing.fieldIndices.map((fi) => fi.fieldId));
            return existingFieldIds.size === parsedColumnFieldIds.size && [...existingFieldIds].every((id) => parsedColumnFieldIds.has(id));
        });

        return {
            ...index,
            id: existingIndex?.id ?? index.id,
            tableId: resolvedTableId,
            unique: index.unique ?? false,
            createdAt: existingIndex ? existingIndex.createdAt : (index.createdAt ?? null),
            fieldIndices: remappedFieldIndices.map((fi) => ({
                ...fi,
                id: existingIndex?.fieldIndices.find((e) => e.fieldId === fi.fieldId)?.id ?? fi.id,
                indexId: existingIndex?.id ?? index.id,
            })),
        } as IndexInsertType;
    });

    const views: ViewInsertType[] = (parsed.views ?? []).map((parsedView) => {
        const existingView = (currentDatabase.views ?? []).find((view) =>
            view.name === parsedView.name && (view.namespace ?? null) === (parsedView.namespace ?? null)
        );
        return {
            ...parsedView,
            id: existingView?.id ?? parsedView.id,
            databaseId: currentDatabase.id,
            namespace: parsedView.namespace ?? null,
            materialized: parsedView.materialized ?? false,
            dependencies: parsedView.dependencies ?? existingView?.dependencies ?? null,
            note: existingView?.note ?? null,
            createdAt: existingView ? existingView.createdAt : (parsedView.createdAt ?? null),
        };
    });

    const sequences: SequenceInsertType[] = (parsed.sequences ?? []).map((parsedSequence) => {
        const existingSequence = (currentDatabase.sequences ?? []).find((sequence) =>
            sequence.name === parsedSequence.name && (sequence.namespace ?? null) === (parsedSequence.namespace ?? null)
        );
        return {
            ...parsedSequence,
            id: existingSequence?.id ?? parsedSequence.id,
            databaseId: currentDatabase.id,
            namespace: parsedSequence.namespace ?? null,
            definition: parsedSequence.definition ?? "",
            note: existingSequence?.note ?? null,
            createdAt: existingSequence ? existingSequence.createdAt : (parsedSequence.createdAt ?? null),
        };
    });

    return { tables, relationships, indexes, views, sequences };
}
