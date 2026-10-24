import { FormattedCell, formatCell } from "./format-cell";

export interface FormattedRowCell {
    cell: FormattedCell;
    truncated: boolean;
}

/**
 * Formats a page of text values for display, column by column, using each column's Postgres type.
 * `truncatedCells` lists the [row, column] positions the server cut short.
 */
export function formatRows(columns: { dataType: string }[], rows: (string | null)[][], truncatedCells: [number, number][] = []): FormattedRowCell[][] {
    const columnCount = columns.length;
    const truncated = new Set(truncatedCells.map(([row, column]) => row * columnCount + column));

    return rows.map((row, rowIndex) =>
        row.map((value, columnIndex) => {
            const isTruncated = truncated.has(rowIndex * columnCount + columnIndex);
            return { cell: formatCell(columns[columnIndex].dataType, value, isTruncated), truncated: isTruncated };
        }),
    );
}
