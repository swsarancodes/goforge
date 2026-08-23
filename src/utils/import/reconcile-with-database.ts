import { TableInsertType } from "@/lib/schemas/table-schema";
import { FieldIndexInsertType } from "@/lib/schemas/field_index-schema";
import { IndexInsertType } from "@/lib/schemas/index-schema";
import { RelationshipInsertType } from "@/lib/schemas/relationship-schema";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { DataType } from "@/lib/schemas/data-type-schema";

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

export function reconcileWithDatabase(parsed: ParsedDatabaseResult, currentDatabase: DatabaseType, dataTypes: DataType[] = []): ParsedDatabaseResult {
    const tableIdMap = new Map<string, string>();
    const fieldIdMap = new Map<string, string>();

    const tables: TableInsertType[] = parsed.tables.map((parsedTable) => {
        const existingTable = currentDatabase.tables.find((t) => t.name === parsedTable.name);
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
        } as TableInsertType;
    });

    const relationships: RelationshipInsertType[] = parsed.relationships.map((rel) => {
        const sourceTableId = tableIdMap.get(rel.sourceTableId as string) ?? rel.sourceTableId;
        const targetTableId = tableIdMap.get(rel.targetTableId as string) ?? rel.targetTableId;
        const sourceFieldId = fieldIdMap.get(rel.sourceFieldId as string) ?? rel.sourceFieldId;
        const targetFieldId = fieldIdMap.get(rel.targetFieldId as string) ?? rel.targetFieldId;

        const existingRelationship = currentDatabase.relationships.find((existing) => existing.sourceTableId === sourceTableId && existing.targetTableId === targetTableId && existing.sourceFieldId === sourceFieldId && existing.targetFieldId === targetFieldId);

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

    return { tables, relationships, indexes };
}
