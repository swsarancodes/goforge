import type { DataType } from "@/lib/schemas/data-type-schema";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import { v4 } from "uuid";
import { ProjectFile, projectToBundle } from "../project-file";
import { PreparedSqlSchemaChange, prepareParsedSchemaChange, withoutDeletions } from "./prepare-sql-schema-change";

/** How a project file is applied to the project that is open. */
export type ProjectImportMode = "merge" | "replace";

/**
 * Compares a project file with the open project and returns the operations that would
 * make the open project match it. Tables, fields, relationships and indexes that already
 * exist keep their ids, positions and notes; `merge` additionally keeps anything the
 * file does not mention, while `replace` removes it.
 *
 * Nothing is written: the caller reviews `operations` and then applies them, which makes
 * the whole import one undoable step.
 */
export function prepareProjectFileChange(
    file: ProjectFile,
    currentDatabase: DatabaseType,
    dataTypes: DataType[],
    mode: ProjectImportMode,
): PreparedSqlSchemaChange {
    if (file.project.dialect !== currentDatabase.dialect) {
        throw new Error(`This project is ${file.project.dialect}, but the open project is ${currentDatabase.dialect}. Import it as a new project instead.`);
    }

    const bundle = projectToBundle(file, v4);
    const change = prepareParsedSchemaChange(
        {
            // A file's own layout would land on top of the open diagram; let new tables be placed beside it.
            tables: bundle.tables.map((table) => ({ ...table, posX: undefined, posY: undefined })) as any,
            relationships: bundle.relationships,
            indexes: bundle.indexes,
            views: bundle.views,
            sequences: bundle.sequences,
        },
        currentDatabase,
        dataTypes,
    );
    return mode === "merge" ? withoutDeletions(change) : change;
}
