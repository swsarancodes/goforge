import { DatabaseType } from "@/lib/schemas/database-schema";
import { TableType } from "@/lib/schemas/table-schema";
import { FieldType } from "@/lib/schemas/field-schema";
import { DriftCategory, DriftItem, DriftReport, DriftResolution, ReconciliationPlan } from "./types";
import { Cardinality, RelationshipType } from "@/lib/schemas/relationship-schema";

function tableIdentifier(t: { name: string; namespace?: string | null }): string {
    return t.namespace ? `${t.namespace.toLowerCase()}.${t.name.toLowerCase()}` : t.name.toLowerCase();
}

export function detectDrift(
    canvasDb: DatabaseType,
    liveDb: DatabaseType,
    defaultResolution: DriftResolution = "pull"
): DriftReport {
    const items: DriftItem[] = [];

    const canvasTablesMap = new Map<string, TableType>();
    for (const t of canvasDb.tables) canvasTablesMap.set(tableIdentifier(t), t);

    const liveTablesMap = new Map<string, TableType>();
    for (const t of liveDb.tables) liveTablesMap.set(tableIdentifier(t), t);

    // 1. Table-level drift
    for (const [key, liveTable] of liveTablesMap) {
        if (!canvasTablesMap.has(key)) {
            items.push({
                id: `table-added-${liveTable.name}`,
                category: "table",
                targetName: liveTable.name,
                tableName: liveTable.name,
                status: "added_in_live",
                details: `Table "${liveTable.name}" exists in live database but is missing on canvas.`,
                liveValue: `${liveTable.fields.length} column(s)`,
                canvasValue: "Missing",
                resolution: defaultResolution,
            });
        }
    }

    for (const [key, canvasTable] of canvasTablesMap) {
        if (!liveTablesMap.has(key)) {
            items.push({
                id: `table-removed-${canvasTable.name}`,
                category: "table",
                targetName: canvasTable.name,
                tableName: canvasTable.name,
                status: "removed_in_live",
                details: `Table "${canvasTable.name}" exists on canvas but was not found in live database.`,
                canvasValue: `${canvasTable.fields.length} column(s)`,
                liveValue: "Missing",
                resolution: defaultResolution,
            });
        }
    }

    // 2. Column, index, and check drift on shared tables
    for (const [key, canvasTable] of canvasTablesMap) {
        const liveTable = liveTablesMap.get(key);
        if (!liveTable) continue;

        // Columns
        const canvasFieldsMap = new Map<string, FieldType>();
        for (const f of canvasTable.fields) canvasFieldsMap.set(f.name.toLowerCase(), f);

        const liveFieldsMap = new Map<string, FieldType>();
        for (const f of liveTable.fields) liveFieldsMap.set(f.name.toLowerCase(), f);

        for (const [fName, liveField] of liveFieldsMap) {
            if (!canvasFieldsMap.has(fName)) {
                items.push({
                    id: `col-added-${canvasTable.name}-${liveField.name}`,
                    category: "column",
                    targetName: `${canvasTable.name}.${liveField.name}`,
                    tableName: canvasTable.name,
                    status: "added_in_live",
                    details: `Column "${liveField.name}" (${liveField.type?.name ?? "unknown"}) was added remotely.`,
                    liveValue: liveField.type?.name ?? "present",
                    canvasValue: "Missing",
                    resolution: defaultResolution,
                });
            }
        }

        for (const [fName, canvasField] of canvasFieldsMap) {
            const liveField = liveFieldsMap.get(fName);
            if (!liveField) {
                items.push({
                    id: `col-removed-${canvasTable.name}-${canvasField.name}`,
                    category: "column",
                    targetName: `${canvasTable.name}.${canvasField.name}`,
                    tableName: canvasTable.name,
                    status: "removed_in_live",
                    details: `Column "${canvasField.name}" was removed remotely.`,
                    canvasValue: canvasField.type?.name ?? "present",
                    liveValue: "Missing",
                    resolution: defaultResolution,
                });
            } else {
                // Column modification checks
                const typeDiff = canvasField.type?.name && liveField.type?.name && canvasField.type.name.toLowerCase() !== liveField.type.name.toLowerCase();
                const nullDiff = Boolean(canvasField.nullable) !== Boolean(liveField.nullable);
                const pkDiff = Boolean(canvasField.isPrimary) !== Boolean(liveField.isPrimary);

                if (typeDiff || nullDiff || pkDiff) {
                    const diffs: string[] = [];
                    if (typeDiff) diffs.push(`Type: canvas ${canvasField.type?.name} vs live ${liveField.type?.name}`);
                    if (nullDiff) diffs.push(`Nullable: canvas ${canvasField.nullable} vs live ${liveField.nullable}`);
                    if (pkDiff) diffs.push(`PK: canvas ${canvasField.isPrimary} vs live ${liveField.isPrimary}`);

                    items.push({
                        id: `col-mod-${canvasTable.name}-${canvasField.name}`,
                        category: "column",
                        targetName: `${canvasTable.name}.${canvasField.name}`,
                        tableName: canvasTable.name,
                        status: "modified",
                        details: diffs.join("; "),
                        canvasValue: `${canvasField.type?.name ?? ""}${canvasField.nullable ? " (null)" : " (not null)"}`,
                        liveValue: `${liveField.type?.name ?? ""}${liveField.nullable ? " (null)" : " (not null)"}`,
                        resolution: defaultResolution,
                    });
                }
            }
        }

        // Indexes
        const canvasIndexNames = new Set((canvasTable.indices ?? []).map(i => i.name.toLowerCase()));
        const liveIndexNames = new Set((liveTable.indices ?? []).map(i => i.name.toLowerCase()));

        for (const liveIdx of liveTable.indices ?? []) {
            if (!canvasIndexNames.has(liveIdx.name.toLowerCase())) {
                items.push({
                    id: `idx-added-${canvasTable.name}-${liveIdx.name}`,
                    category: "index",
                    targetName: `${canvasTable.name}.${liveIdx.name}`,
                    tableName: canvasTable.name,
                    status: "added_in_live",
                    details: `Index "${liveIdx.name}" exists remotely on "${canvasTable.name}".`,
                    liveValue: "Present",
                    canvasValue: "Missing",
                    resolution: defaultResolution,
                });
            }
        }

        for (const canvasIdx of canvasTable.indices ?? []) {
            if (!liveIndexNames.has(canvasIdx.name.toLowerCase())) {
                items.push({
                    id: `idx-removed-${canvasTable.name}-${canvasIdx.name}`,
                    category: "index",
                    targetName: `${canvasTable.name}.${canvasIdx.name}`,
                    tableName: canvasTable.name,
                    status: "removed_in_live",
                    details: `Index "${canvasIdx.name}" is missing remotely on "${canvasTable.name}".`,
                    canvasValue: "Present",
                    liveValue: "Missing",
                    resolution: defaultResolution,
                });
            }
        }
    }

    // 3. Relationships / Foreign Keys
    const canvasRelNames = new Set(canvasDb.relationships.map(r => r.name?.toLowerCase()).filter(Boolean));
    const liveRelNames = new Set(liveDb.relationships.map(r => r.name?.toLowerCase()).filter(Boolean));

    for (const liveRel of liveDb.relationships) {
        if (liveRel.name && !canvasRelNames.has(liveRel.name.toLowerCase())) {
            items.push({
                id: `rel-added-${liveRel.name}`,
                category: "foreign_key",
                targetName: liveRel.name,
                status: "added_in_live",
                details: `Foreign key "${liveRel.name}" was added remotely.`,
                liveValue: "Present",
                canvasValue: "Missing",
                resolution: defaultResolution,
            });
        }
    }

    for (const canvasRel of canvasDb.relationships) {
        if (canvasRel.name && !liveRelNames.has(canvasRel.name.toLowerCase())) {
            items.push({
                id: `rel-removed-${canvasRel.name}`,
                category: "foreign_key",
                targetName: canvasRel.name,
                status: "removed_in_live",
                details: `Foreign key "${canvasRel.name}" exists on canvas but is missing remotely.`,
                canvasValue: "Present",
                liveValue: "Missing",
                resolution: defaultResolution,
            });
        }
    }

    const summary = {
        total: items.length,
        addedInLive: items.filter(i => i.status === "added_in_live").length,
        removedInLive: items.filter(i => i.status === "removed_in_live").length,
        modified: items.filter(i => i.status === "modified").length,
        inSync: items.length === 0,
    };

    return {
        items,
        summary,
        liveDialect: liveDb.dialect,
        timestamp: new Date().toISOString(),
    };
}

/** Builds an actionable reconciliation execution plan without mutating either side */
export async function buildReconciliationPlan(
    report: DriftReport,
    canvasDb: DatabaseType,
    liveDb: DatabaseType,
    renderer: any
): Promise<ReconciliationPlan> {
    const pullItems = report.items.filter(i => i.resolution === "pull");
    const pushItems = report.items.filter(i => i.resolution === "push");
    const ignoredItems = report.items.filter(i => i.resolution === "ignore");

    let pushSql = "";
    if (pushItems.length > 0 && renderer) {
        // Render diff DDL from live to canvas for push operations
        pushSql = await renderer.renderDiffDDL(canvasDb, liveDb);
    }

    let pullOperations: any[] = [];
    if (pullItems.length > 0 && renderer) {
        pullOperations = renderer.prepareDiff(liveDb, canvasDb);
    }

    return {
        pullOperations,
        pushSql,
        ignoredCount: ignoredItems.length,
        pullCount: pullItems.length,
        pushCount: pushItems.length,
    };
}
