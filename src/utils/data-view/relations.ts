import type { RelationInfo, RelationKind } from "@/lib/live-connection-api";

export type { RelationKind };

export interface Relation extends RelationInfo {
    /** Opaque, unique per schema+name (names may themselves contain dots). */
    key: string;
}

export const relationKey = (schema: string, name: string) => `${schema}\u001f${name}`;

/** Adds a stable key to the relations the server listed and sorts them by schema, then name. */
export function buildRelations(infos: RelationInfo[]): Relation[] {
    return infos
        .map((info) => ({ ...info, key: relationKey(info.schema, info.name) }))
        .sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
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

/** Short row-count label for the table list: "~208", "~1.2k", "~340k", "~3.4M"; empty when unknown. */
export function formatRowEstimate(rows: number | null): string {
    if (rows === null || !Number.isFinite(rows) || rows < 0) return "";
    if (rows < 1_000) return `~${Math.round(rows)}`;
    if (rows < 10_000) return `~${(rows / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    if (rows < 1_000_000) return `~${Math.round(rows / 1_000)}k`;
    return `~${(rows / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
