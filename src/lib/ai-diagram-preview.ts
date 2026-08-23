import { DatabaseType } from "@/lib/schemas/database-schema";
import { DBDiffOperation } from "@/utils/database";

export type AiDiffStatus = "added" | "modified" | "deleted";

export interface AiDiagramPreview {
    database: DatabaseType;
    tableStatuses: Record<string, AiDiffStatus>;
    fieldStatuses: Record<string, AiDiffStatus>;
    relationshipStatuses: Record<string, AiDiffStatus>;
}

const markModified = (statuses: Record<string, AiDiffStatus>, id: string) => {
    if (!statuses[id]) statuses[id] = "modified";
};

export function buildAiDiagramPreview(
    currentDatabase: DatabaseType,
    targetDatabase: DatabaseType,
    operations: DBDiffOperation[],
): AiDiagramPreview {
    const tableStatuses: Record<string, AiDiffStatus> = {};
    const fieldStatuses: Record<string, AiDiffStatus> = {};
    const relationshipStatuses: Record<string, AiDiffStatus> = {};
    const currentTables = new Map(currentDatabase.tables.map((table) => [table.id, table]));

    for (const operation of operations) {
        switch (operation.type) {
            case "CREATE_TABLE":
                tableStatuses[operation.table.id] = "added";
                operation.table.fields.forEach((field) => { fieldStatuses[field.id] = "added"; });
                break;
            case "DELETE_TABLE": {
                tableStatuses[operation.tableId] = "deleted";
                currentTables.get(operation.tableId)?.fields
                    .forEach((field) => { fieldStatuses[field.id] = "deleted"; });
                break;
            }
            case "UPDATE_TABLE":
                markModified(tableStatuses, operation.tableId);
                break;
            case "CREATE_FIELD":
                fieldStatuses[operation.field.id] = "added";
                markModified(tableStatuses, operation.tableId);
                break;
            case "DELETE_FIELD":
                fieldStatuses[operation.fieldId] = "deleted";
                markModified(tableStatuses, operation.tableId);
                break;
            case "UPDATE_FIELD":
                fieldStatuses[operation.fieldId] = "modified";
                markModified(tableStatuses, operation.tableId);
                break;
            case "CREATE_RELATIONSHIP":
                relationshipStatuses[operation.relationship.id] = "added";
                break;
            case "DELETE_RELATIONSHIP":
                relationshipStatuses[operation.relationshipId] = "deleted";
                break;
            case "UPDATE_RELATIONSHIP":
                relationshipStatuses[operation.relationshipId] = "modified";
                break;
            case "CREATE_INDEX":
            case "DELETE_INDEX":
            case "UPDATE_INDEX":
            case "UPDATE_FIELD_INDICES":
                markModified(tableStatuses, operation.tableId);
                break;
        }
    }

    const targetTables = new Map(targetDatabase.tables.map((table) => [table.id, table]));
    const displayTables = currentDatabase.tables.map((currentTable) => {
        const targetTable = targetTables.get(currentTable.id);
        if (!targetTable) return currentTable;
        const targetFieldIds = new Set(targetTable.fields.map((field) => field.id));
        const deletedFields = currentTable.fields.filter((field) => !targetFieldIds.has(field.id));
        return {
            ...targetTable,
            fields: [...targetTable.fields, ...deletedFields].sort((left, right) => left.sequence - right.sequence),
        };
    });
    const currentTableIds = new Set(currentDatabase.tables.map((table) => table.id));
    displayTables.push(...targetDatabase.tables.filter((table) => !currentTableIds.has(table.id)));

    const targetRelationships = new Map(targetDatabase.relationships.map((relationship) => [relationship.id, relationship]));
    const displayRelationships = currentDatabase.relationships.map(
        (relationship) => targetRelationships.get(relationship.id) ?? relationship,
    );
    const currentRelationshipIds = new Set(currentDatabase.relationships.map((relationship) => relationship.id));
    displayRelationships.push(...targetDatabase.relationships.filter((relationship) => !currentRelationshipIds.has(relationship.id)));

    return {
        database: { ...targetDatabase, tables: displayTables, relationships: displayRelationships },
        tableStatuses,
        fieldStatuses,
        relationshipStatuses,
    };
}
