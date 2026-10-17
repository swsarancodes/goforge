import { asc, desc } from "drizzle-orm";
import { check_constraints } from "./schemas/check-constraint-schema";
import type { DatabaseType } from "./schemas/database-schema";
import { fields } from "./schemas/field-schema";
import { indices } from "./schemas/index-schema";
import { relationships } from "./schemas/relationship-schema";
import { tables } from "./schemas/table-schema";

/**
 * Everything that makes up one project, in the shape the whole app works on: tables with
 * their fields, indexes and checks, and relationships with their columns. The live query
 * behind the open project and one-off reads (snapshots, migrations) use the same graph so
 * they can never disagree about what a project contains.
 */
export const databaseGraph = {
    tables: {
        orderBy: desc(tables.sequence),
        with: {
            fields: {
                orderBy: asc(fields.sequence),
                with: {
                    type: true,
                },
            },
            indices: {
                orderBy: asc(indices.createdAt),
                with: {
                    fieldIndices: true,
                },
            },
            checks: {
                orderBy: asc(check_constraints.createdAt),
            },
        },
    },
    relationships: {
        with: {
            sourceTable: true,
            targetTable: true,
            sourceField: true,
            targetField: true,
            relationshipFields: true,
        },
        orderBy: desc(relationships.createdAt),
    },
    views: true,
    sequences: true,
} as const;

/** Reads one project as it is stored right now. */
export const loadDatabaseGraph = async (db: any, databaseId: string): Promise<DatabaseType | undefined> =>
    (await db.query.databases.findFirst({
        where: (databases: any, { eq }: any) => eq(databases.id, databaseId),
        with: databaseGraph,
    })) as DatabaseType | undefined;
