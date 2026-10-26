import type { MappingRow } from "@/features/query-modernizer/engine/mapping-apply";
import type { MigrationPlanPreview } from "@/lib/migrations-api";

/**
 * The names a legacy query has to be rewritten to once the person has renamed things: a row for every column of each table whose name, or
 * one of whose column names, differs from what GoForge would have chosen. Names that only changed case are not listed, because Oracle's
 * unquoted names already find them in PostgreSQL. Empty when nothing was renamed.
 */
export function mappingFromPlan(plan: MigrationPlanPreview): MappingRow[] {
    return plan.tables
        .filter((table) => table.renamed || table.columns.some((column) => column.edited.includes("name")))
        .flatMap((table) => table.columns.map((column) => ({ sourceTable: table.oracleName, sourceColumn: column.oracleName, targetTable: table.pgName, targetColumn: column.pgName })));
}

const SIMPLE = /^[A-Z][A-Z0-9_$#]*$/;
const identifier = (name: string): string => (SIMPLE.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/** A query that reads up to 100 rows of the table with the most rows, in a fixed order, as a starting point for the proof. */
export function defaultProofQuery(plan: MigrationPlanPreview): string {
    const table = [...plan.tables].sort((a, b) => b.rows - a.rows)[0];
    if (!table) return "";
    const order = table.oraclePrimaryKey.length > 0 ? ` ORDER BY ${table.oraclePrimaryKey.map(identifier).join(", ")}` : "";
    return `SELECT * FROM ${identifier(table.oracleName)}${order} FETCH FIRST 100 ROWS ONLY`;
}
