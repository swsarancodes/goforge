import { InferInsertModel, InferSelectModel, relations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { databases } from "./database-schema";

/** A persisted SQL view or materialized view definition. */
export const views = sqliteTable("views", {
    id: text("id").primaryKey().notNull().unique(),
    databaseId: text("databaseId").notNull().references(() => databases.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    namespace: text("namespace"),
    materialized: integer("materialized", { mode: "boolean" }).notNull().default(false),
    definition: text("definition").notNull(),
    dependencies: text("dependencies"),
    note: text("note"),
    createdAt: text("createdAt"),
});

export const viewRelations = relations(views, ({ one }) => ({
    database: one(databases, {
        fields: [views.databaseId],
        references: [databases.id],
    }),
}));

export interface ViewType extends InferSelectModel<typeof views> {}
export interface ViewInsertType extends InferInsertModel<typeof views> {}

/** Best-effort dependency metadata for portable SQL view definitions. */
export function extractViewDependencies(definition: string): string[] {
    const dependencies = new Set<string>();
    const referencePattern = /\b(?:FROM|JOIN)\s+((?:[A-Za-z_][\w$]*|"[^"]+")(?:\s*\.\s*(?:[A-Za-z_][\w$]*|"[^"]+"))?)/gi;
    for (const match of definition.matchAll(referencePattern)) {
        dependencies.add(match[1].replace(/["`\[\]]/g, '').replace(/\s*\.\s*/g, '.'));
    }
    return [...dependencies];
}
