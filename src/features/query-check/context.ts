import type { MappingRow } from "@/features/query-modernizer/engine/mapping-apply";

/**
 * What the query check needs to know about a migration it did not run itself: the names the person changed (so an Oracle query can be
 * rewritten to them) and a query to start from. Kept in the tab's session storage under the PostgreSQL database, written when a migration
 * finishes. Without it the check still works; it just starts empty and rewrites no names.
 */
export interface CheckContext {
    mapping: MappingRow[];
    query: string;
}

const key = (postgresId: string) => `goforge.query-check.${postgresId}`;

export function saveCheckContext(postgresId: string, context: CheckContext): void {
    try {
        sessionStorage.setItem(key(postgresId), JSON.stringify(context));
    } catch {
        // not remembered
    }
}

export function loadCheckContext(postgresId: string): CheckContext | undefined {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(key(postgresId)) ?? "null");
        return parsed && Array.isArray(parsed.mapping) && typeof parsed.query === "string" ? (parsed as CheckContext) : undefined;
    } catch {
        return undefined;
    }
}

/** The query check, open on this pair of databases. */
export const queryCheckUrl = (oracleId: string, postgresId: string): string => `/database/query-check?oracle=${encodeURIComponent(oracleId)}&postgres=${encodeURIComponent(postgresId)}`;
