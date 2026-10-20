import type { IntrospectionResult } from "@/lib/live-connection-api";

export type RelationKind = "table" | "view" | "materialized view";

export interface Relation {
    /** Opaque, unique per schema+name (names may themselves contain dots). */
    key: string;
    schema: string;
    name: string;
    kind: RelationKind;
}

export const relationKey = (schema: string, name: string) => `${schema}\u001f${name}`;

/**
 * Turns an introspection result into the browsable list of tables, views and materialized views.
 *
 * information_schema.columns also lists plain views, so introspection reports them as both a table and a
 * view: key by schema+name and let the view entry win. Sorted by schema, then name.
 */
export function buildRelations(introspection: Pick<IntrospectionResult, "tables" | "views">): Relation[] {
    const byKey = new Map<string, Relation>();

    for (const table of introspection.tables) {
        const schema = table.namespace ?? "public";
        const key = relationKey(schema, table.name);
        byKey.set(key, { key, schema, name: table.name, kind: "table" });
    }

    for (const view of introspection.views ?? []) {
        const schema = view.namespace ?? "public";
        const key = relationKey(schema, view.name);
        byKey.set(key, { key, schema, name: view.name, kind: view.materialized ? "materialized view" : "view" });
    }

    return Array.from(byKey.values()).sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
}

/** Groups relations by schema (keeping their order), optionally keeping only those whose `schema.name` contains `filter`. */
export function groupRelations(relations: Relation[], filter = ""): [string, Relation[]][] {
    const needle = filter.trim().toLowerCase();
    const groups = new Map<string, Relation[]>();

    for (const relation of relations) {
        if (needle && !`${relation.schema}.${relation.name}`.toLowerCase().includes(needle)) continue;
        const list = groups.get(relation.schema) ?? [];
        list.push(relation);
        groups.set(relation.schema, list);
    }

    return Array.from(groups.entries());
}
