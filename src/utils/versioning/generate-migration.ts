import { compare } from "fast-json-patch";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import type { FieldType } from "@/lib/schemas/field-schema";
import type { MigrationType } from "@/lib/schemas/version-history-schema";
import type BaseDatabaseRenderer from "../render/database/base-database-renderer";
import { DBDiffOperation, mapDiffToDBDiffOperation, normalizeDatabase } from "../database";
import { isSchemaOperation, prepareForMigration } from "../migration";
import { hashText, matchesHash } from "./snapshot";

export class NoSchemaChangesError extends Error {
    constructor() {
        super("There are no schema changes between these two versions.");
        this.name = "NoSchemaChangesError";
    }
}

export interface GeneratedMigration {
    upSql: string;
    /** Null when `downBlockedReason` is set. */
    downSql: string | null;
    downBlockedReason: string | null;
}

/** The typed operations that turn `before` into `after`, ignoring layout and column order. */
export const diffOperations = (before: DatabaseType, after: DatabaseType): DBDiffOperation[] =>
    mapDiffToDBDiffOperation(compare(normalizeDatabase(prepareForMigration(before)), normalizeDatabase(prepareForMigration(after))));

// null, undefined, "" and false all mean "not set" for the optional flags.
const unset = (value: unknown) => value === undefined || value === null || value === "" || value === false;

const parseValues = (raw: unknown): string[] => {
    if (typeof raw !== "string" || !raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
};

/**
 * Why `before -> after` cannot be reversed by a generated down migration, or null when it can.
 *
 * Reversing recreates structure, not data. Anything whose data the up migration discards
 * (a dropped table or column, a narrowed or converted type, removed enum values) would come
 * back empty or fail, so those migrations get no generated down script rather than a
 * misleading one. Dropped indexes, checks, relationships and views are fully recoverable.
 */
export const downBlockedReasonFor = (before: DatabaseType, after: DatabaseType, operations: DBDiffOperation[] = diffOperations(before, after)): string | null => {
    const reasons: string[] = [];
    const beforeTables = new Map(before.tables.map((table) => [table.id, table]));
    const nameOfTable = (tableId: string) => {
        const table = beforeTables.get(tableId) ?? after.tables.find((candidate) => candidate.id === tableId);
        return table ? (table.namespace ? `${table.namespace}.${table.name}` : table.name) : tableId;
    };
    const beforeField = (tableId: string, fieldId: string): FieldType | undefined =>
        beforeTables.get(tableId)?.fields.find((field) => field.id === fieldId);

    for (const operation of operations) {
        switch (operation.type) {
            case "DELETE_TABLE":
                reasons.push(`it drops table "${nameOfTable(operation.tableId)}", and its rows cannot be restored`);
                break;
            case "DELETE_FIELD": {
                const field = beforeField(operation.tableId, operation.fieldId);
                reasons.push(`it drops column "${nameOfTable(operation.tableId)}.${field?.name ?? operation.fieldId}", and its values cannot be restored`);
                break;
            }
            case "DELETE_SEQUENCE": {
                const sequence = (before.sequences ?? []).find((candidate) => candidate.id === operation.sequenceId);
                reasons.push(`it drops sequence "${sequence?.name ?? operation.sequenceId}", and its current value cannot be restored`);
                break;
            }
            case "UPDATE_FIELD": {
                const old = beforeField(operation.tableId, operation.fieldId);
                const changes = operation.changes as Partial<FieldType>;
                if (!old) break;
                const label = `"${nameOfTable(operation.tableId)}.${old.name}"`;
                if (changes.typeId !== undefined && changes.typeId !== old.typeId) {
                    reasons.push(`it changes the type of ${label}, and converting back may lose data`);
                }
                for (const key of ["maxLength", "precision", "scale"] as const) {
                    const next = changes[key];
                    const previous = old[key];
                    if (next !== undefined && typeof next === "number" && typeof previous === "number" && next < previous) {
                        reasons.push(`it narrows ${key} of ${label}, which can truncate data`);
                    }
                }
                if (changes.values !== undefined) {
                    const kept = new Set(parseValues(changes.values));
                    if (parseValues(old.values).some((value) => !kept.has(value))) {
                        reasons.push(`it removes allowed values from ${label}`);
                    }
                }
                break;
            }
            default:
                break;
        }
    }

    if (reasons.length === 0) return null;
    const shown = reasons.slice(0, 3).join("; ");
    const more = reasons.length > 3 ? `; and ${reasons.length - 3} more` : "";
    return `A down migration is not generated because ${shown}${more}. A rename counts as a drop plus an add.`;
};

const OPERATION_LABELS: Partial<Record<DBDiffOperation["type"], string>> = {
    CREATE_FIELD: "adding a column",
    DELETE_FIELD: "dropping a column",
    UPDATE_FIELD: "changing a column",
    CREATE_INDEX: "adding an index",
    DELETE_INDEX: "dropping an index",
    DELETE_TABLE: "dropping a table",
    UPDATE_TABLE: "renaming or moving a table",
    DELETE_RELATIONSHIP: "dropping a foreign key",
};

/** "adding a column (2), dropping a table" for a list of operations. */
const describeOperations = (operations: DBDiffOperation[]): string => {
    const counts = new Map<string, number>();
    for (const operation of operations) {
        const label = OPERATION_LABELS[operation.type] ?? operation.type.toLowerCase().replace(/_/g, " ");
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, count]) => (count > 1 ? `${label} (${count})` : label)).join(", ");
};

/** The dialect cannot render some of the changes, so any script would be missing statements. */
export class UnsupportedMigrationError extends Error {
    constructor(dialect: string, operations: DBDiffOperation[]) {
        super(
            `GoForge cannot write migration SQL for this change in ${dialect} yet: it cannot render ${describeOperations(operations)}. ` +
            "Altering existing tables is currently supported for PostgreSQL only. The versions are still saved and can be compared and restored.",
        );
        this.name = "UnsupportedMigrationError";
    }
}

/**
 * Renders the SQL that moves a database from `before` to `after`, plus the inverse when one
 * can be generated safely. Pure and deterministic: the same two states always give the same text.
 *
 * Throws `NoSchemaChangesError` when nothing changed and `UnsupportedMigrationError` when the
 * dialect cannot render every change - an incomplete script is worse than none.
 */
export async function generateMigration(renderer: BaseDatabaseRenderer, before: DatabaseType, after: DatabaseType): Promise<GeneratedMigration> {
    const upOperations = renderer.prepareDiff(after, before);
    if (!upOperations.some(isSchemaOperation)) throw new NoSchemaChangesError();
    const upGaps = renderer.unsupportedOperations(upOperations);
    if (upGaps.length > 0) throw new UnsupportedMigrationError(renderer.getDialect(), upGaps);

    const upSql = (await renderer.renderDiffDDL(after, before)).trim();
    if (!upSql) throw new NoSchemaChangesError();

    let downBlockedReason = downBlockedReasonFor(before, after);
    let downSql: string | null = null;
    if (!downBlockedReason) {
        try {
            const downOperations = renderer.prepareDiff(before, after);
            const downGaps = renderer.unsupportedOperations(downOperations);
            if (downGaps.length > 0) {
                downBlockedReason = `A down migration is not generated because ${renderer.getDialect()} cannot render ${describeOperations(downGaps)}.`;
            } else {
                downSql = (await renderer.renderDiffDDL(before, after)).trim();
                if (!downSql) downBlockedReason = "The inverse of this change renders to no SQL.";
            }
        } catch (error) {
            downBlockedReason = `A down migration could not be generated: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
    return { upSql, downSql: downBlockedReason ? null : downSql, downBlockedReason };
}

const checksumSource = (upSql: string, downSql: string | null) => `${upSql}\n--\n${downSql ?? ""}`;

/** Fingerprint of a migration's SQL, kept with it so edits to the stored text are noticed. */
export const migrationChecksum = (upSql: string, downSql: string | null) => hashText(checksumSource(upSql, downSql));

export const verifyMigrationChecksum = (migration: Pick<MigrationType, "upSql" | "downSql" | "checksum">): Promise<boolean> =>
    matchesHash(checksumSource(migration.upSql, migration.downSql), migration.checksum);

/** `0003_add_comments` style stem shared by the up and down file names. */
export const migrationFileStem = (sequence: number, name: string): string =>
    `${String(sequence).padStart(4, "0")}_${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "migration"}`;

/** A SQL file for one direction of a migration, with a header saying where it came from. */
export const formatMigrationFile = (
    migration: Pick<MigrationType, "sequence" | "name" | "dialect" | "description" | "sourceSnapshotId" | "targetSnapshotId" | "upSql" | "downSql">,
    direction: "up" | "down",
    snapshotNames: { source?: string; target?: string } = {},
): string => {
    const body = direction === "up" ? migration.upSql : migration.downSql;
    if (body === null) throw new Error("This migration has no down script.");
    const lines = [
        `-- GoForge migration ${String(migration.sequence).padStart(4, "0")}: ${migration.name} (${direction})`,
        ...(migration.description ? [`-- ${migration.description.replace(/\s*\n\s*/g, " ")}`] : []),
        `-- dialect: ${migration.dialect}`,
        `-- from snapshot: ${snapshotNames.source ?? ""} [${migration.sourceSnapshotId}]`,
        `-- to snapshot:   ${snapshotNames.target ?? ""} [${migration.targetSnapshotId}]`,
        "",
    ];
    return `${lines.join("\n")}\n${body}\n`;
};
