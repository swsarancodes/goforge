import type { DataType } from "@/lib/schemas/data-type-schema";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import type { SnapshotType } from "@/lib/schemas/version-history-schema";
import { ProjectFile, parseProjectFile, serializeProject } from "../project-file";

/** The one instant written into every snapshot, so equal schemas serialize to equal text. */
const FIXED_EXPORT_TIME = new Date(0);

/** Cheap non-cryptographic fallback for contexts without `crypto.subtle` (plain http). */
const cyrb53 = (text: string): string => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
};

/** `sha256:<hex>` when available, else `cyrb53:<hex>`; the prefix says how to verify it later. */
export const hashText = async (text: string): Promise<string> => {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
        return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
    return `cyrb53:${cyrb53(text)}`;
};

/** Hashes with the algorithm recorded in `expected`'s prefix, so old hashes stay verifiable. */
export const matchesHash = async (text: string, expected: string): Promise<boolean> => {
    if (expected.startsWith("cyrb53:")) return `cyrb53:${cyrb53(text)}` === expected;
    return (await hashText(text)) === expected;
};

/** Key order and entity-array order must not change a fingerprint. */
const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        const items = value.map(canonicalize);
        return items.every((item) => typeof item === "object" && item !== null && typeof (item as any).id === "string")
            ? items.sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            : items;
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, entry]) => entry !== undefined)
                .sort(([left], [right]) => (left < right ? -1 : 1))
                .map(([key, entry]) => [key, canonicalize(entry)]),
        );
    }
    return value;
};

// Where a table sits, how wide it is and when a row was written are not schema.
const NON_SCHEMA_TABLE_KEYS = ["posX", "posY", "width", "color", "createdAt", "sequence"];

/** Text that is identical for two projects exactly when their schema is identical. */
export const schemaFingerprintSource = (file: ProjectFile): string => {
    const project = file.project;
    const stripped = {
        ...project,
        tables: project.tables.map((table) => {
            const copy: Record<string, unknown> = { ...table };
            for (const key of NON_SCHEMA_TABLE_KEYS) delete copy[key];
            return copy;
        }),
    };
    return JSON.stringify(canonicalize(stripped));
};

export interface SnapshotDraft {
    content: string;
    hash: string;
    fingerprint: string;
    tableCount: number;
    dialect: string;
}

/** Freezes the project as it is now. */
export const draftSnapshot = async (database: DatabaseType): Promise<SnapshotDraft> => {
    const file = serializeProject(database, FIXED_EXPORT_TIME);
    const content = JSON.stringify(file);
    return {
        content,
        hash: await hashText(content),
        fingerprint: await hashText(schemaFingerprintSource(file)),
        tableCount: file.project.tables.length,
        dialect: database.dialect,
    };
};

/** The schema fingerprint of a project as it is now, comparable with `SnapshotType.fingerprint`. */
export const currentFingerprint = async (database: DatabaseType): Promise<string> =>
    hashText(schemaFingerprintSource(serializeProject(database, FIXED_EXPORT_TIME)));

/** Reads a stored snapshot back, validating it like any project file. */
export const readSnapshot = (snapshot: Pick<SnapshotType, "content">): ProjectFile => parseProjectFile(snapshot.content);

/** True when the stored content still matches the hash taken when it was frozen. */
export const verifySnapshot = (snapshot: Pick<SnapshotType, "content" | "hash">): Promise<boolean> =>
    matchesHash(snapshot.content, snapshot.hash);

/**
 * Rebuilds a database object (the shape the diff and render code works on) from a
 * snapshot, keeping the snapshot's own ids so a restore updates rows in place instead of
 * recreating everything.
 */
export const snapshotToDatabase = (file: ProjectFile, base: DatabaseType, dataTypes: DataType[]): DatabaseType => {
    const typeById = new Map(dataTypes.map((dataType) => [dataType.id, dataType]));
    const tables = file.project.tables.map((table) => {
        const fields = table.fields.map((field) => ({ ...field, tableId: table.id, type: typeById.get(field.typeId ?? "") }));
        return {
            ...table,
            databaseId: base.id,
            fields,
            indices: table.indices.map((index) => ({ ...index, tableId: table.id, fieldIndices: index.fieldIndices.map((fieldIndex) => ({ ...fieldIndex })) })),
            checks: (table.checks ?? []).map((check) => ({ ...check, tableId: table.id })),
        };
    });
    const tableById = new Map(tables.map((table) => [table.id, table]));
    const relationships = file.project.relationships.map((relationship) => {
        const sourceTable = tableById.get(relationship.sourceTableId);
        const targetTable = tableById.get(relationship.targetTableId);
        return {
            ...relationship,
            databaseId: base.id,
            sourceTable,
            targetTable,
            sourceField: sourceTable?.fields.find((field) => field.id === relationship.sourceFieldId),
            targetField: targetTable?.fields.find((field) => field.id === relationship.targetFieldId),
        };
    });
    return {
        ...base,
        numOfTables: tables.length,
        tables,
        relationships,
        views: file.project.views.map((view) => ({ ...view, databaseId: base.id })),
        sequences: file.project.sequences.map((sequence) => ({ ...sequence, databaseId: base.id })),
    } as unknown as DatabaseType;
};
