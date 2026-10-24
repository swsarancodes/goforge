import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsv } from "./compare";

export interface MappingRow {
    sourceTable: string;
    sourceColumn: string;
    targetTable: string;
    targetColumn: string;
    note: string;
}

export function parseMapping(csv: string): MappingRow[] {
    const [header, ...body] = parseCsv(csv);
    const index = (name: string) => {
        const position = header?.indexOf(name) ?? -1;
        if (position < 0) throw new Error(`schema_mapping.csv has no ${name} column`);
        return position;
    };
    const [st, sc, tt, tc] = ["source_table", "source_column", "target_table", "target_column"].map(index);
    const note = header.indexOf("note");
    return body.map((row) => ({ sourceTable: row[st], sourceColumn: row[sc], targetTable: row[tt], targetColumn: row[tc], note: note >= 0 ? (row[note] ?? "") : "" }));
}

export const loadMapping = (domainDir: string) => parseMapping(readFileSync(resolve(domainDir, "schema_mapping.csv"), "utf8"));

/**
 * One view per legacy table, with the legacy table and column names, over the target tables. It lets a query converted by something that
 * only knows SQL syntax (the rule engine has no notion of a schema mapping yet) run against the target database, so what is measured is the
 * conversion of the dialect, not the renaming. Built from schema_mapping.csv, never written by hand.
 */
export function legacyNameViews(mapping: MappingRow[]): string {
    const tables = new Map<string, MappingRow[]>();
    for (const row of mapping) tables.set(row.sourceTable, [...(tables.get(row.sourceTable) ?? []), row]);
    return [...tables.entries()]
        .map(([source, rows]) => `CREATE VIEW ${source.toLowerCase()} AS SELECT ${rows.map((row) => `${row.targetColumn} AS ${row.sourceColumn.toLowerCase()}`).join(", ")} FROM ${rows[0].targetTable};`)
        .join("\n");
}
