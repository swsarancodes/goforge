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

/** Topologically sorts views so views dependencies are created before the views that depend on them. */
export function sortViewsTopologically<T extends { id: string; name: string; namespace?: string | null; definition: string }>(viewsList: T[]): T[] {
    if (!viewsList || viewsList.length <= 1) return viewsList ?? [];

    const viewByName = new Map<string, T>();
    for (const view of viewsList) {
        const unqualified = view.name.toLowerCase();
        const qualified = view.namespace ? `${view.namespace.toLowerCase()}.${unqualified}` : unqualified;
        viewByName.set(unqualified, view);
        viewByName.set(qualified, view);
    }

    const adj = new Map<string, Set<string>>();
    for (const view of viewsList) {
        const id = view.id;
        adj.set(id, new Set());
        const deps = extractViewDependencies(view.definition);
        for (const dep of deps) {
            const depLower = dep.toLowerCase();
            const matchingDepView = viewByName.get(depLower);
            if (matchingDepView && matchingDepView.id !== id) {
                adj.get(id)!.add(matchingDepView.id);
            }
        }
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: T[] = [];

    function visit(viewId: string) {
        if (visited.has(viewId)) return;
        if (visiting.has(viewId)) {
            // Circular dependency detected: break cycle gracefully
            return;
        }
        visiting.add(viewId);

        const deps = adj.get(viewId) ?? new Set();
        for (const depId of deps) {
            visit(depId);
        }

        visiting.delete(viewId);
        visited.add(viewId);
        const v = viewsList.find(view => view.id === viewId);
        if (v) result.push(v);
    }

    for (const view of viewsList) {
        if (!visited.has(view.id)) {
            visit(view.id);
        }
    }

    return result;
}

