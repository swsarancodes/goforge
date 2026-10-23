/**
 * What an Oracle database returned, as the text the output check reads: tab separated, the column names first, NULL as nothing. This is what
 * a person would otherwise copy out of a grid and paste in by hand.
 */
export function oracleResultToText(columns: { name: string }[], rows: (string | null)[][]): string {
    const cell = (value: string | null) => (value === null ? "" : value.replace(/[\t\r\n]+/g, " "));
    return [columns.map((column) => cell(column.name)).join("\t"), ...rows.map((row) => row.map(cell).join("\t"))].join("\n");
}
