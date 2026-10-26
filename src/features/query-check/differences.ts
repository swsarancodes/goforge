import { normalizeCell } from "@/features/query-modernizer/compare-output";

const rowKey = (row: (string | null)[]): string => JSON.stringify(row.map((cell) => normalizeCell(cell)));

/**
 * Which rows of two results have no counterpart in the other, so both grids can mark them. Compared by value, the way the comparison itself
 * is: 100 and 100.00 are the same cell, NULL and an empty string are the same cell. With the order ignored a row is matched by any equal
 * row (duplicates counted); with the order kept it is matched by its position.
 */
export function differingRows(left: (string | null)[][], right: (string | null)[][], ignoreOrder: boolean): { left: Set<number>; right: Set<number> } {
    const result = { left: new Set<number>(), right: new Set<number>() };
    if (!ignoreOrder) {
        for (let index = 0; index < Math.max(left.length, right.length); index++) {
            const same = left[index] !== undefined && right[index] !== undefined && rowKey(left[index]) === rowKey(right[index]);
            if (!same) {
                if (index < left.length) result.left.add(index);
                if (index < right.length) result.right.add(index);
            }
        }
        return result;
    }
    const unmatched = (rows: (string | null)[][], others: (string | null)[][], into: Set<number>) => {
        const available = new Map<string, number>();
        for (const row of others) available.set(rowKey(row), (available.get(rowKey(row)) ?? 0) + 1);
        rows.forEach((row, index) => {
            const key = rowKey(row);
            const count = available.get(key) ?? 0;
            if (count > 0) available.set(key, count - 1);
            else into.add(index);
        });
    };
    unmatched(left, right, result.left);
    unmatched(right, left, result.right);
    return result;
}
