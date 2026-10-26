import { cn } from "@/lib/utils";
import { MAX_REPORTED, type OutputComparison } from "../compare-output";

/**
 * What a comparison of two outputs found, in words: that they are the same, or how many rows each side had and which rows and cells differ.
 * Shared by the Modernizer's output check and the migration page's query proof, so both say the same thing the same way.
 */
export const ComparisonSummary: React.FC<{ comparison: OutputComparison; dialectLabel: string; ignoreOrder: boolean }> = ({ comparison, dialectLabel, ignoreOrder }) => {
    const shown = (rows: string[][]) => rows.slice(0, MAX_REPORTED);
    return (
        <div className="space-y-1.5 text-xs" role="status">
            <p className={cn("font-medium", comparison.matches ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
                {comparison.matches
                    ? comparison.partial
                        ? `The first ${comparison.actualRows} rows match. PostgreSQL had more, and only the first 100 are read.`
                        : `Same result: ${comparison.actualRows} row${comparison.actualRows === 1 ? "" : "s"}, every value matches.`
                    : `Different: ${comparison.expectedRows} row${comparison.expectedRows === 1 ? "" : "s"} from ${dialectLabel}, ${comparison.actualRows} from PostgreSQL.`}
            </p>
            {comparison.columnProblem && <p className="text-muted-foreground">{comparison.columnProblem}</p>}
            {comparison.partial && !comparison.matches && <p className="text-muted-foreground">Only the first {comparison.actualRows} rows were read from PostgreSQL, so only those were checked, in order.</p>}
            {comparison.differences.length > 0 && (
                <ul className="space-y-0.5 text-muted-foreground">
                    {comparison.differences.slice(0, MAX_REPORTED).map((difference, index) => (
                        <li key={index} className="break-words">
                            Row {difference.row}, <span className="font-mono">{difference.column}</span>: {dialectLabel} gave <span className="font-mono text-foreground">{difference.expected}</span>, PostgreSQL gives <span className="font-mono text-foreground">{difference.actual}</span>
                        </li>
                    ))}
                    {comparison.differences.length > MAX_REPORTED && <li>…and {comparison.differences.length - MAX_REPORTED} more.</li>}
                </ul>
            )}
            {comparison.missing.length > 0 && (
                <div className="text-muted-foreground">
                    <p>{ignoreOrder ? `Rows ${dialectLabel} returned that PostgreSQL did not (${comparison.missing.length}):` : `Rows ${dialectLabel} has beyond what PostgreSQL returned (${comparison.missing.length}):`}</p>
                    <ul className="font-mono">{shown(comparison.missing).map((row, index) => <li key={index} className="break-all">{row.join(" | ")}</li>)}</ul>
                </div>
            )}
            {comparison.extra.length > 0 && (
                <div className="text-muted-foreground">
                    <p>{ignoreOrder ? `Rows PostgreSQL returned that ${dialectLabel} did not (${comparison.extra.length}):` : `Rows PostgreSQL has beyond what ${dialectLabel} returned (${comparison.extra.length}):`}</p>
                    <ul className="font-mono">{shown(comparison.extra).map((row, index) => <li key={index} className="break-all">{row.join(" | ")}</li>)}</ul>
                </div>
            )}
        </div>
    );
};
