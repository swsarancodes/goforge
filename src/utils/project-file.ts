import { DatabaseDialect } from "@/lib/database";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import type { FieldInsertType } from "@/lib/schemas/field-schema";
import type { IndexInsertType } from "@/lib/schemas/index-schema";
import type { RelationshipInsertType } from "@/lib/schemas/relationship-schema";
import type { SequenceInsertType } from "@/lib/schemas/sequence-schema";
import type { TableInsertType } from "@/lib/schemas/table-schema";
import type { ViewInsertType } from "@/lib/schemas/view-schema";
import { CheckConstraintInsertType, validateCheck } from "@/lib/schemas/check-constraint-schema";

/**
 * Portable GoForge project file.
 *
 * `formatVersion` only changes when an existing field's meaning changes or a field
 * becomes required. Adding optional fields does not bump it. Older files are upgraded
 * by `PROJECT_FILE_MIGRATIONS`; files from a newer GoForge are rejected with a clear
 * message instead of being half-imported.
 */
export const PROJECT_FILE_FORMAT = "goforge-project";
export const PROJECT_FILE_VERSION = 1;

/** Maps `formatVersion N` documents to the shape of `N + 1`. Empty until v2 exists. */
const PROJECT_FILE_MIGRATIONS: Record<number, (document: any) => any> = {};

const DIALECTS = new Set<string>(Object.values(DatabaseDialect));

export interface ProjectFile {
    format: typeof PROJECT_FILE_FORMAT;
    formatVersion: number;
    exportedAt: string;
    project: {
        name: string;
        dialect: DatabaseDialect;
        tables: ProjectTable[];
        relationships: ProjectRelationship[];
        views: ViewInsertType[];
        sequences: SequenceInsertType[];
    };
}

export type ProjectIndex = Omit<IndexInsertType, "fieldIndices"> & {
    fieldIndices: { id: string; fieldId: string; indexId: string }[];
};
export type ProjectTable = Omit<TableInsertType, "fields" | "checks" | "databaseId"> & {
    fields: Omit<FieldInsertType, "tableId">[];
    indices: ProjectIndex[];
    /** Optional so files written before CHECK support (or by other tools) stay valid. */
    checks?: Omit<CheckConstraintInsertType, "tableId">[];
};
export type ProjectRelationship = Omit<RelationshipInsertType, "databaseId" | "relationshipFields"> & {
    relationshipFields: { id: string; relationshipId: string; sourceFieldId: string; targetFieldId: string; sequence: number }[];
};

export class ProjectFileError extends Error {
    constructor(message: string, readonly details: string[] = []) {
        super(message);
        this.name = "ProjectFileError";
    }
}

/** Drops joined/derived objects so the file only holds plain rows. */
export const serializeProject = (database: DatabaseType, now: Date = new Date()): ProjectFile => ({
    format: PROJECT_FILE_FORMAT,
    formatVersion: PROJECT_FILE_VERSION,
    exportedAt: now.toISOString(),
    project: {
        name: database.name,
        dialect: database.dialect,
        tables: (database.tables ?? []).map((table) => {
            const { fields, indices, checks, sourceRelations: _s, targetRelations: _t, databaseId: _d, ...tableRow } = table as any;
            return {
                ...tableRow,
                checks: (checks ?? []).map(({ tableId: _tableId, ...check }: any) => check),
                fields: (fields ?? []).map((field: any) => {
                    const { type: _type, sourceRelations: _fs, targetRelations: _ft, tableId: _tableId, ...fieldRow } = field;
                    return fieldRow;
                }),
                indices: (indices ?? []).map((index: any) => {
                    const { fields: _f, fieldIndices, ...indexRow } = index;
                    return { ...indexRow, fieldIndices: (fieldIndices ?? []).map((fi: any) => ({ id: fi.id, fieldId: fi.fieldId, indexId: fi.indexId })) };
                }),
            };
        }),
        relationships: (database.relationships ?? []).map((relationship) => {
            const { sourceTable: _st, targetTable: _tt, sourceField: _sf, targetField: _tf, databaseId: _d, relationshipFields, ...relationshipRow } = relationship as any;
            return {
                ...relationshipRow,
                relationshipFields: (relationshipFields ?? []).map((rf: any) => ({
                    id: rf.id,
                    relationshipId: rf.relationshipId,
                    sourceFieldId: rf.sourceFieldId,
                    targetFieldId: rf.targetFieldId,
                    sequence: rf.sequence ?? 0,
                })),
            };
        }),
        views: (database.views ?? []).map(({ databaseId: _d, ...view }: any) => view),
        sequences: (database.sequences ?? []).map(({ databaseId: _d, ...sequence }: any) => sequence),
    },
});

const isRecord = (value: unknown): value is Record<string, any> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: unknown, where: string, problems: string[]) => {
    if (typeof value !== "string" || value.length === 0) problems.push(`${where} must be a non-empty string`);
};

/**
 * Parses and validates a project file. Throws `ProjectFileError` listing every problem
 * found (capped) so the user can see what is wrong in one pass.
 *
 * `knownTypeIds` (when given) must contain the ids of data types available for the
 * project's dialect; fields pointing elsewhere are rejected, because they could not be
 * rendered after import.
 */
export const parseProjectFile = (text: string, knownTypeIds?: ReadonlySet<string>): ProjectFile => {
    let raw: any;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new ProjectFileError("This file is not valid JSON.");
    }

    if (!isRecord(raw) || raw.format !== PROJECT_FILE_FORMAT) {
        throw new ProjectFileError("This is not a GoForge project file.");
    }

    let version = raw.formatVersion;
    if (!Number.isInteger(version) || version < 1) {
        throw new ProjectFileError("The project file has no valid format version.");
    }
    if (version > PROJECT_FILE_VERSION) {
        throw new ProjectFileError(`This project was exported by a newer version of GoForge (format ${version}). Update GoForge to open it.`);
    }
    while (version < PROJECT_FILE_VERSION) {
        const migrate = PROJECT_FILE_MIGRATIONS[version];
        if (!migrate) throw new ProjectFileError(`Cannot upgrade project format ${version}.`);
        raw = migrate(raw);
        version += 1;
    }

    const problems: string[] = [];
    const project = raw.project;
    if (!isRecord(project)) throw new ProjectFileError("The project file has no project data.");

    requireString(project.name, "project.name", problems);
    if (!DIALECTS.has(project.dialect)) problems.push(`project.dialect "${String(project.dialect)}" is not supported`);
    for (const key of ["tables", "relationships", "views", "sequences"] as const) {
        if (project[key] === undefined && key !== "tables") project[key] = [];
        else if (!Array.isArray(project[key])) problems.push(`project.${key} must be a list`);
    }
    if (problems.length > 0) throw new ProjectFileError("The project file is invalid.", problems);

    const tableIds = new Set<string>();
    const fieldIds = new Set<string>();
    const indexIds = new Set<string>();
    const seen = new Set<string>();
    const claimId = (id: unknown, where: string) => {
        requireString(id, `${where}.id`, problems);
        if (typeof id !== "string") return;
        if (seen.has(id)) problems.push(`${where}.id "${id}" is used more than once`);
        seen.add(id);
    };

    project.tables.forEach((table: any, tableIndex: number) => {
        const where = `tables[${tableIndex}]`;
        if (!isRecord(table)) return void problems.push(`${where} must be an object`);
        claimId(table.id, where);
        requireString(table.name, `${where}.name`, problems);
        tableIds.add(table.id);
        if (table.fields === undefined) table.fields = [];
        if (table.indices === undefined) table.indices = [];
        if (!Array.isArray(table.fields)) return void problems.push(`${where}.fields must be a list`);
        if (!Array.isArray(table.indices)) return void problems.push(`${where}.indices must be a list`);

        table.fields.forEach((field: any, fieldIndex: number) => {
            const fieldWhere = `${where}.fields[${fieldIndex}]`;
            if (!isRecord(field)) return void problems.push(`${fieldWhere} must be an object`);
            claimId(field.id, fieldWhere);
            requireString(field.name, `${fieldWhere}.name`, problems);
            fieldIds.add(field.id);
            if (knownTypeIds && (typeof field.typeId !== "string" || !knownTypeIds.has(field.typeId))) {
                problems.push(`${fieldWhere}.typeId "${String(field.typeId)}" is not a ${project.dialect} data type`);
            }
        });
        if (table.checks === undefined) table.checks = [];
        if (!Array.isArray(table.checks)) return void problems.push(`${where}.checks must be a list`);
        table.checks.forEach((check: any, checkIndex: number) => {
            const checkWhere = `${where}.checks[${checkIndex}]`;
            if (!isRecord(check)) return void problems.push(`${checkWhere} must be an object`);
            claimId(check.id, checkWhere);
            // Expressions are spliced into generated DDL, so a hand-edited file must not
            // be able to smuggle in anything the editor itself would refuse.
            const siblings = table.checks.filter((other: any) => other !== check && isRecord(other) && typeof other.name === "string").map((other: any) => ({ id: other.id, name: other.name }));
            const problem = validateCheck(check as { id?: string; name: string; expression: string }, siblings);
            if (problem) problems.push(`${checkWhere}: ${problem}`);
        });
        table.indices.forEach((index: any, indexIndex: number) => {
            const indexWhere = `${where}.indices[${indexIndex}]`;
            if (!isRecord(index)) return void problems.push(`${indexWhere} must be an object`);
            claimId(index.id, indexWhere);
            requireString(index.name, `${indexWhere}.name`, problems);
            indexIds.add(index.id);
            if (index.fieldIndices === undefined) index.fieldIndices = [];
            if (!Array.isArray(index.fieldIndices)) problems.push(`${indexWhere}.fieldIndices must be a list`);
        });
    });

    // Second pass: references can only be checked once every id is known.
    project.tables.forEach((table: any, tableIndex: number) => {
        if (!isRecord(table) || !Array.isArray(table.indices)) return;
        table.indices.forEach((index: any, indexIndex: number) => {
            if (!isRecord(index) || !Array.isArray(index.fieldIndices)) return;
            index.fieldIndices.forEach((fi: any, fiIndex: number) => {
                if (isRecord(fi)) claimId(fi.id, `tables[${tableIndex}].indices[${indexIndex}].fieldIndices[${fiIndex}]`);
                if (!isRecord(fi) || !fieldIds.has(fi.fieldId)) {
                    problems.push(`tables[${tableIndex}].indices[${indexIndex}].fieldIndices[${fiIndex}] references an unknown field`);
                }
            });
        });
    });

    project.relationships.forEach((relationship: any, relIndex: number) => {
        const where = `relationships[${relIndex}]`;
        if (!isRecord(relationship)) return void problems.push(`${where} must be an object`);
        claimId(relationship.id, where);
        for (const key of ["sourceTableId", "targetTableId"] as const) {
            if (!tableIds.has(relationship[key])) problems.push(`${where}.${key} references an unknown table`);
        }
        for (const key of ["sourceFieldId", "targetFieldId"] as const) {
            if (!fieldIds.has(relationship[key])) problems.push(`${where}.${key} references an unknown field`);
        }
        if (relationship.relationshipFields === undefined) relationship.relationshipFields = [];
        if (!Array.isArray(relationship.relationshipFields)) return void problems.push(`${where}.relationshipFields must be a list`);
        relationship.relationshipFields.forEach((rf: any, rfIndex: number) => {
            if (isRecord(rf)) claimId(rf.id, `${where}.relationshipFields[${rfIndex}]`);
            if (!isRecord(rf) || !fieldIds.has(rf.sourceFieldId) || !fieldIds.has(rf.targetFieldId)) {
                problems.push(`${where}.relationshipFields[${rfIndex}] references an unknown field`);
            }
        });
    });

    for (const key of ["views", "sequences"] as const) {
        project[key].forEach((item: any, itemIndex: number) => {
            const where = `${key}[${itemIndex}]`;
            if (!isRecord(item)) return void problems.push(`${where} must be an object`);
            claimId(item.id, where);
            requireString(item.name, `${where}.name`, problems);
        });
    }

    if (problems.length > 0) {
        const shown = problems.slice(0, 10);
        if (problems.length > shown.length) shown.push(`…and ${problems.length - shown.length} more`);
        throw new ProjectFileError("The project file is invalid.", shown);
    }

    return raw as ProjectFile;
};

export interface ProjectBundle {
    name: string;
    dialect: DatabaseDialect;
    tables: (TableInsertType & { fields: FieldInsertType[]; checks: CheckConstraintInsertType[] })[];
    relationships: RelationshipInsertType[];
    indexes: IndexInsertType[];
    views: ViewInsertType[];
    sequences: SequenceInsertType[];
}

/**
 * Turns a validated project into insertable rows with fresh ids, so the same file can
 * be imported (or a project duplicated) any number of times without id collisions.
 * Every cross reference is rewritten through the same id map.
 */
export const projectToBundle = (file: ProjectFile, newId: () => string, name: string = file.project.name): ProjectBundle => {
    const ids = new Map<string, string>();
    const remap = (oldId: string): string => {
        let next = ids.get(oldId);
        if (!next) {
            next = newId();
            ids.set(oldId, next);
        }
        return next;
    };

    const tables: ProjectBundle["tables"] = [];
    const indexes: IndexInsertType[] = [];
    for (const table of file.project.tables) {
        const tableId = remap(table.id);
        const { fields, indices, checks = [], ...tableRow } = table;
        tables.push({
            ...tableRow,
            id: tableId,
            fields: fields.map((field) => ({ ...field, id: remap(field.id), tableId } as FieldInsertType)),
            checks: checks.map((check) => ({ ...check, id: remap(check.id), tableId } as CheckConstraintInsertType)),
        } as ProjectBundle["tables"][number]);
        for (const index of indices) {
            const indexId = remap(index.id);
            indexes.push({
                ...index,
                id: indexId,
                tableId,
                fieldIndices: index.fieldIndices.map((fi) => ({ id: remap(fi.id), indexId, fieldId: remap(fi.fieldId) })),
            });
        }
    }

    const relationships: RelationshipInsertType[] = file.project.relationships.map((relationship) => {
        const relationshipId = remap(relationship.id);
        return {
            ...relationship,
            id: relationshipId,
            sourceTableId: remap(relationship.sourceTableId),
            targetTableId: remap(relationship.targetTableId),
            sourceFieldId: remap(relationship.sourceFieldId),
            targetFieldId: remap(relationship.targetFieldId),
            relationshipFields: relationship.relationshipFields.map((rf) => ({
                id: remap(rf.id),
                relationshipId,
                sourceFieldId: remap(rf.sourceFieldId),
                targetFieldId: remap(rf.targetFieldId),
                sequence: rf.sequence,
            })),
            // databaseId is assigned when the rows are inserted into the new project.
        } as RelationshipInsertType;
    });

    return {
        name,
        dialect: file.project.dialect,
        tables,
        relationships,
        indexes,
        views: file.project.views.map((view) => ({ ...view, id: remap(view.id) })),
        sequences: file.project.sequences.map((sequence) => ({ ...sequence, id: remap(sequence.id) })),
    };
};

export interface ProjectSummary {
    tables: number;
    fields: number;
    checks: number;
    relationships: number;
    indexes: number;
    views: number;
    sequences: number;
}

export const summarizeProject = (file: ProjectFile): ProjectSummary => ({
    tables: file.project.tables.length,
    fields: file.project.tables.reduce((total, table) => total + table.fields.length, 0),
    checks: file.project.tables.reduce((total, table) => total + (table.checks?.length ?? 0), 0),
    relationships: file.project.relationships.length,
    indexes: file.project.tables.reduce((total, table) => total + table.indices.length, 0),
    views: file.project.views.length,
    sequences: file.project.sequences.length,
});
