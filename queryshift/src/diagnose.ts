import { normalizeCell, type Category } from "./compare";
import type { CandidateReport, LoadedCase } from "./case";

/**
 * What a failed candidate looks like, as measurements: which rows are missing, which are unexpected, in which columns the two sides differ,
 * which invariants broke. This is what a correction is based on, and what goes in the report. It never says what the fix is.
 */
export interface Evidence {
    kind: "mismatch" | "error";
    message: string;
    expectedColumns: string[];
    columnProblem?: string;
    orderProblem?: string;
    missingRows: (string | null)[][];
    unexpectedRows: (string | null)[][];
    missingCount: number;
    unexpectedCount: number;
    differingColumns: { column: string; rows: number }[];
    brokenInvariants: { name: string; detail: string }[];
    /** What the static checks saw in the query text: deterministic suspects, filled in by the loop. */
    staticFindings: { id: string; title: string; detail: string }[];
}

const MAX_ROWS = 20;

/**
 * Pairs each unexpected row with the missing row it is closest to and counts the columns in which they differ. "Four rows differ only in
 * open_ratio" points at one expression; "three rows are missing and nothing is unexpected" points at a filter or a join.
 */
export function differingColumns(columns: string[], categories: Category[], missing: (string | null)[][], unexpected: (string | null)[][]): { column: string; rows: number }[] {
    const normalized = (row: (string | null)[]) => row.map((cell, index) => normalizeCell(cell, categories[index] ?? "text"));
    const left = missing.map(normalized);
    const taken = new Set<number>();
    const counts = new Map<number, number>();
    for (const row of unexpected.map(normalized)) {
        let best = -1;
        let bestDistance = Infinity;
        left.forEach((candidate, index) => {
            if (taken.has(index)) return;
            const distance = candidate.filter((cell, column) => cell !== row[column]).length;
            if (distance < bestDistance) (bestDistance = distance, (best = index));
        });
        if (best < 0 || bestDistance >= Math.max(2, Math.ceil(columns.length / 2) + 1)) continue;
        taken.add(best);
        left[best].forEach((cell, column) => {
            if (cell !== row[column]) counts.set(column, (counts.get(column) ?? 0) + 1);
        });
    }
    return [...counts.entries()].map(([column, rows]) => ({ column: columns[column], rows })).sort((a, b) => b.rows - a.rows);
}

export function diagnose(loaded: LoadedCase, report: CandidateReport): Evidence {
    const expectedColumns = loaded.expected.columns;
    const brokenInvariants = report.invariants.filter((invariant) => !invariant.ok).map(({ name, detail }) => ({ name, detail }));
    if (report.verdict === "error" || !report.comparison) {
        return { kind: "error", message: report.summary, expectedColumns, missingRows: [], unexpectedRows: [], missingCount: 0, unexpectedCount: 0, differingColumns: [], brokenInvariants, staticFindings: [] };
    }
    const { comparison } = report;
    const categories = (report.actualColumns ?? []).map((column) => column.category);
    return {
        kind: "mismatch",
        message: report.summary,
        expectedColumns,
        columnProblem: comparison.columnProblem,
        orderProblem: comparison.orderProblem,
        missingRows: comparison.missing.slice(0, MAX_ROWS),
        unexpectedRows: comparison.additional.slice(0, MAX_ROWS),
        missingCount: comparison.missingCount,
        unexpectedCount: comparison.additionalCount,
        differingColumns: comparison.columnProblem ? [] : differingColumns(expectedColumns, categories, comparison.missing, comparison.additional),
        brokenInvariants,
        staticFindings: [],
    };
}
