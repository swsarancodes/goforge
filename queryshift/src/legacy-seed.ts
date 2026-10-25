/**
 * The synthetic seed is written for the PostgreSQL tables (`customers`, `policies`, `claims`). To run the legacy Oracle queries on a real Oracle the same
 * rows go into the legacy tables (`CUST_MST`, `POLCY_HDR`, `CLM_DTL`) under their legacy column names, taken from domain/schema_mapping.csv.
 */

export interface Mapping {
    sourceTable: string;
    sourceColumn: string;
    targetTable: string;
    targetColumn: string;
}

export function parseMapping(csv: string): Mapping[] {
    const [, ...lines] = csv.trim().split("\n");
    return lines.map((line) => {
        const [sourceTable, sourceColumn, targetTable, targetColumn] = line.split(",");
        return { sourceTable, sourceColumn, targetTable, targetColumn };
    });
}

/** Renames the table and the columns of every INSERT; a table or column the mapping does not know is an error, never passed through. */
export function toLegacySeed(seed: string, mapping: Mapping[]): string {
    return seed.replace(/INSERT INTO\s+(\w+)\s*\(([^)]*)\)/gi, (_whole, table: string, columns: string) => {
        const rows = mapping.filter((entry) => entry.targetTable === table.toLowerCase());
        if (rows.length === 0) throw new Error(`The seed inserts into ${table}, which schema_mapping.csv does not map.`);
        const renamed = columns.split(",").map((column) => {
            const entry = rows.find((candidate) => candidate.targetColumn === column.trim().toLowerCase());
            if (!entry) throw new Error(`The seed inserts into ${table}.${column.trim()}, which schema_mapping.csv does not map.`);
            return entry.sourceColumn;
        });
        return `INSERT INTO ${rows[0].sourceTable} (${renamed.join(", ")})`;
    });
}
