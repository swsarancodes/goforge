import { TableInsertType } from "@/lib/schemas/table-schema";
import { FieldIndexInsertType } from "@/lib/schemas/field_index-schema";
import { IndexInsertType } from "@/lib/schemas/index-schema";
import { RelationshipInsertType } from "@/lib/schemas/relationship-schema";
import { DatabaseType } from "@/lib/schemas/database-schema";

export interface ParsedDatabaseResult {
    tables: TableInsertType[];
    relationships: RelationshipInsertType[];
    indexes: IndexInsertType[];
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
export function reconcileWithDatabase(parsed: ParsedDatabaseResult, currentDatabase: DatabaseType): ParsedDatabaseResult {
    const tableIdMap = new Map<string, string>();
    const fieldIdMap = new Map<string, string>();

    const tables: TableInsertType[] = parsed.tables.map((parsedTable) => {
        const existingTable = currentDatabase.tables.find((t) => t.name === parsedTable.name);
        const resolvedTableId = existingTable?.id ?? (parsedTable.id as string);
        tableIdMap.set(parsedTable.id as string, resolvedTableId);

        const fields = (parsedTable.fields ?? []).map((parsedField) => {
            const existingField = existingTable?.fields.find((f) => f.name === parsedField.name);
            const resolvedFieldId = existingField?.id ?? (parsedField.id as string);
            fieldIdMap.set(parsedField.id as string, resolvedFieldId);
            return { ...parsedField, id: resolvedFieldId, tableId: resolvedTableId };
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
            color: existingTable?.color ?? parsedTable.color,
            width: existingTable?.width ?? parsedTable.width,
            sequence: existingTable?.sequence ?? parsedTable.sequence,
            fields,
        } as TableInsertType;
    });

    const relationships: RelationshipInsertType[] = parsed.relationships.map((rel) => {
        const sourceTableId = tableIdMap.get(rel.sourceTableId as string) ?? rel.sourceTableId;
        const targetTableId = tableIdMap.get(rel.targetTableId as string) ?? rel.targetTableId;
        const sourceFieldId = fieldIdMap.get(rel.sourceFieldId as string) ?? rel.sourceFieldId;
        const targetFieldId = fieldIdMap.get(rel.targetFieldId as string) ?? rel.targetFieldId;

        const existingRelationship = currentDatabase.relationships.find(
            (existing) =>
                existing.sourceTableId === sourceTableId &&
                existing.targetTableId === targetTableId &&
                existing.sourceFieldId === sourceFieldId &&
                existing.targetFieldId === targetFieldId
        );

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
            fieldIndices: remappedFieldIndices.map((fi) => ({
                ...fi,
                id: existingIndex?.fieldIndices.find((e) => e.fieldId === fi.fieldId)?.id ?? fi.id,
            })),
        } as IndexInsertType;
    });

    return { tables, relationships, indexes };
}
