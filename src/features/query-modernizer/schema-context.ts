import type { DatabaseType } from "@/lib/schemas/database-schema";
import type { SchemaContext } from "./types";

/** The tables of the open project as the Modernizer needs them: names and types, keys, indexes and foreign keys. Never data. */
export function schemaFromDatabase(database: DatabaseType | undefined): SchemaContext | undefined {
    if (!database || database.tables.length === 0) return undefined;

    const fieldById = new Map(database.tables.flatMap((table) => table.fields.map((field) => [field.id, { table, field }] as const)));

    return {
        databaseName: database.name,
        dialect: database.dialect,
        tables: database.tables.map((table) => ({
            name: table.name,
            columns: table.fields.map((field) => ({
                name: field.name,
                type: field.type?.name ?? "",
                nullable: field.nullable ?? undefined,
                isPrimary: !!field.isPrimary,
                isUnique: !!field.unique,
            })),
            indexes: (table.indices ?? [])
                .map((index) => (index.fields ?? []).map((field) => field.name))
                .filter((columns) => columns.length > 0),
        })),
        relationships: (database.relationships ?? []).flatMap((relationship) => {
            const source = fieldById.get(relationship.sourceFieldId);
            const target = fieldById.get(relationship.targetFieldId);
            if (!source || !target) return [];
            // The app renders `ALTER TABLE <target> ADD FOREIGN KEY (<target field>) REFERENCES <source> (<source field>)`:
            // the target side holds the key (the child), the source side is what it points at.
            return [{ fromTable: target.table.name, fromColumn: target.field.name, toTable: source.table.name, toColumn: source.field.name }];
        }),
    };
}
