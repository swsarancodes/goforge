import type { DatabaseType } from "@/lib/schemas/database-schema";
import type { DBDiffOperation } from "@/utils/database";

export interface TableChangeSummary {
    name: string;
    /** Human-readable parts, e.g. `2 fields added`. */
    details: string[];
}

export interface ObjectChangeCounts {
    added: number;
    removed: number;
    changed: number;
}

export interface SchemaChangeSummary {
    tablesAdded: string[];
    tablesRemoved: string[];
    tablesChanged: TableChangeSummary[];
    relationships: ObjectChangeCounts;
    views: ObjectChangeCounts;
    sequences: ObjectChangeCounts;
    /** True when the change would leave the diagram as it is. */
    isEmpty: boolean;
}

// Position and ordering are not schema; a re-import should not report them as edits.
const LAYOUT_KEYS = new Set(["posX", "posY", "sequence", "createdAt", "width"]);

/** null, undefined and "" all mean "not set"; so does `false` for the optional flags. */
const comparable = (value: unknown) => (value === undefined || value === "" || value === false ? null : value);

/**
 * A diff built from a re-parsed source often carries `undefined` where the stored row has
 * `null`. Only count an update when some property really differs from what is stored.
 */
const hasRealChange = (existing: Record<string, unknown> | undefined, changes: Record<string, unknown>): boolean =>
    Object.keys(changes).some((key) => !LAYOUT_KEYS.has(key) && JSON.stringify(comparable(existing?.[key])) !== JSON.stringify(comparable(changes[key])));

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

interface TableCounters {
    fieldsAdded: number;
    fieldsRemoved: number;
    fieldsChanged: number;
    indexesAdded: number;
    indexesRemoved: number;
    indexesChanged: number;
    checksAdded: number;
    checksRemoved: number;
    checksChanged: number;
    tableChanged: boolean;
}

const emptyCounters = (): TableCounters => ({
    fieldsAdded: 0, fieldsRemoved: 0, fieldsChanged: 0,
    indexesAdded: 0, indexesRemoved: 0, indexesChanged: 0,
    checksAdded: 0, checksRemoved: 0, checksChanged: 0,
    tableChanged: false,
});

const detailsOf = (counters: TableCounters): string[] => {
    const details: string[] = [];
    if (counters.tableChanged) details.push("table settings changed");
    if (counters.fieldsAdded) details.push(`${plural(counters.fieldsAdded, "field")} added`);
    if (counters.fieldsRemoved) details.push(`${plural(counters.fieldsRemoved, "field")} removed`);
    if (counters.fieldsChanged) details.push(`${plural(counters.fieldsChanged, "field")} changed`);
    if (counters.indexesAdded) details.push(`${plural(counters.indexesAdded, "index")} added`);
    if (counters.indexesRemoved) details.push(`${plural(counters.indexesRemoved, "index")} removed`);
    if (counters.indexesChanged) details.push(`${plural(counters.indexesChanged, "index")} changed`);
    if (counters.checksAdded) details.push(`${plural(counters.checksAdded, "check")} added`);
    if (counters.checksRemoved) details.push(`${plural(counters.checksRemoved, "check")} removed`);
    if (counters.checksChanged) details.push(`${plural(counters.checksChanged, "check")} changed`);
    return details;
};

/**
 * Turns the typed operations of a pending schema change into something a person can
 * review before confirming: which tables appear, disappear or change, and how.
 */
export function summarizeSchemaChange(operations: DBDiffOperation[], current: DatabaseType, target?: DatabaseType): SchemaChangeSummary {
    const currentTables = new Map(current.tables.map((table) => [table.id, table]));
    const nameOf = (tableId: string, fallback?: { name?: string | null }) =>
        currentTables.get(tableId)?.name ?? fallback?.name ?? target?.tables.find((table) => table.id === tableId)?.name ?? tableId;
    const qualified = (table: { name: string; namespace?: string | null }) => (table.namespace ? `${table.namespace}.${table.name}` : table.name);

    const tablesAdded: string[] = [];
    const tablesRemoved: string[] = [];
    const perTable = new Map<string, TableCounters>();
    const countersFor = (tableId: string) => {
        let counters = perTable.get(tableId);
        if (!counters) perTable.set(tableId, (counters = emptyCounters()));
        return counters;
    };
    const relationships: ObjectChangeCounts = { added: 0, removed: 0, changed: 0 };
    const views: ObjectChangeCounts = { added: 0, removed: 0, changed: 0 };
    const sequences: ObjectChangeCounts = { added: 0, removed: 0, changed: 0 };

    const currentFields = new Map(current.tables.flatMap((table) => table.fields.map((field) => [field.id, field] as const)));
    const currentRelationships = new Map(current.relationships.map((relationship) => [relationship.id, relationship]));
    const currentViews = new Map((current.views ?? []).map((view) => [view.id, view]));
    const currentSequences = new Map((current.sequences ?? []).map((sequence) => [sequence.id, sequence]));
    const currentChecks = new Map(current.tables.flatMap((table) => (table.checks ?? []).map((check) => [check.id, check] as const)));

    for (const operation of operations) {
        switch (operation.type) {
            case "CREATE_TABLE":
                tablesAdded.push(qualified(operation.table));
                break;
            case "DELETE_TABLE": {
                const table = currentTables.get(operation.tableId) ?? operation.table;
                tablesRemoved.push(table ? qualified(table) : operation.tableId);
                break;
            }
            case "UPDATE_TABLE":
                if (hasRealChange(currentTables.get(operation.tableId) as any, operation.changes as any)) countersFor(operation.tableId).tableChanged = true;
                break;
            case "CREATE_FIELD":
                countersFor(operation.tableId).fieldsAdded++;
                break;
            case "DELETE_FIELD":
                countersFor(operation.tableId).fieldsRemoved++;
                break;
            case "UPDATE_FIELD":
                if (hasRealChange(currentFields.get(operation.fieldId) as any, operation.changes as any)) countersFor(operation.tableId).fieldsChanged++;
                break;
            case "CREATE_INDEX":
                countersFor(operation.tableId).indexesAdded++;
                break;
            case "DELETE_INDEX":
                countersFor(operation.tableId).indexesRemoved++;
                break;
            case "UPDATE_INDEX":
                countersFor(operation.tableId).indexesChanged++;
                break;
            case "UPDATE_FIELD_INDICES":
                if (operation.create.length > 0 || operation.delete.length > 0) countersFor(operation.tableId).indexesChanged++;
                break;
            case "CREATE_CHECK":
                countersFor(operation.tableId).checksAdded++;
                break;
            case "DELETE_CHECK":
                countersFor(operation.tableId).checksRemoved++;
                break;
            case "UPDATE_CHECK":
                if (hasRealChange(currentChecks.get(operation.checkId) as any, operation.changes as any)) countersFor(operation.tableId).checksChanged++;
                break;
            case "CREATE_RELATIONSHIP":
                relationships.added++;
                break;
            case "DELETE_RELATIONSHIP":
                relationships.removed++;
                break;
            case "UPDATE_RELATIONSHIP":
                if (hasRealChange(currentRelationships.get(operation.relationshipId) as any, operation.changes as any)) relationships.changed++;
                break;
            case "UPDATE_RELATIONSHIP_FIELDS":
                if (operation.create.length > 0 || operation.delete.length > 0 || operation.update.length > 0) relationships.changed++;
                break;
            case "CREATE_VIEW":
                views.added++;
                break;
            case "DELETE_VIEW":
                views.removed++;
                break;
            case "UPDATE_VIEW":
                if (hasRealChange(currentViews.get(operation.viewId) as any, operation.changes as any)) views.changed++;
                break;
            case "CREATE_SEQUENCE":
                sequences.added++;
                break;
            case "DELETE_SEQUENCE":
                sequences.removed++;
                break;
            case "UPDATE_SEQUENCE":
                if (hasRealChange(currentSequences.get(operation.sequenceId) as any, operation.changes as any)) sequences.changed++;
                break;
            default:
                break;
        }
    }

    const tablesChanged: TableChangeSummary[] = [];
    for (const [tableId, counters] of perTable) {
        const details = detailsOf(counters);
        if (details.length > 0) tablesChanged.push({ name: nameOf(tableId), details });
    }

    const countOf = (counts: ObjectChangeCounts) => counts.added + counts.removed + counts.changed;
    return {
        tablesAdded,
        tablesRemoved,
        tablesChanged,
        relationships,
        views,
        sequences,
        isEmpty: tablesAdded.length === 0 && tablesRemoved.length === 0 && tablesChanged.length === 0 && countOf(relationships) + countOf(views) + countOf(sequences) === 0,
    };
}
