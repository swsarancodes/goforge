import type { RelationshipType } from "@/lib/schemas/relationship-schema";
import type { TableType } from "@/lib/schemas/table-schema";
import type { Node } from "@xyflow/react";
import { adjustTablesPositions } from "../tables";
import type { ProjectFile } from "../project-file";

/**
 * Formats like DBML carry no diagram layout, so an imported project would stack every
 * table at the origin. This places them with the same layered layout the app uses.
 */
export async function layoutProjectFile(file: ProjectFile): Promise<ProjectFile> {
    if (file.project.tables.length === 0) return file;

    const nodes = file.project.tables.map((table) => ({
        id: table.id,
        position: { x: table.posX ?? 0, y: table.posY ?? 0 },
        data: { table: { ...table, fields: table.fields } as unknown as TableType },
    })) as unknown as Node[];

    const placed = await adjustTablesPositions(nodes, file.project.relationships as unknown as RelationshipType[]);
    const positions = new Map(placed.map((table) => [table.id, table]));

    return {
        ...file,
        project: {
            ...file.project,
            tables: file.project.tables.map((table) => {
                const position = positions.get(table.id);
                return position ? { ...table, posX: position.posX, posY: position.posY } : table;
            }),
        },
    };
}
