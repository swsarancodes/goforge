import React, { useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { PreviewResult } from "@/lib/modernizer-api";
import { compareOutput, parseExpectedOutput } from "../compare-output";
import { ComparisonSummary } from "./comparison-summary";

/**
 * "Does it return what the original returned?": the person pastes the rows the old database gave, and the PostgreSQL rows above are checked
 * against them cell by cell. Numbers and dates are compared by value, and NULL and an empty string are the same (they are, in Oracle).
 * For an Oracle query, "Run both and compare" on the Output tab runs the original itself, so nothing has to be pasted.
 */
export const OutputCheck: React.FC<{ result: PreviewResult; dialectLabel: string }> = ({ result, dialectLabel }) => {
    const [text, setText] = useState("");
    const [ignoreOrder, setIgnoreOrder] = useState(false);

    const outcome = useMemo(() => {
        if (!text.trim()) return undefined;
        const expected = parseExpectedOutput(text);
        if ("error" in expected) return { error: expected.error } as const;
        return { comparison: compareOutput(expected, { columns: result.columns.map((column) => column.name), rows: result.rows, truncated: result.truncated }, { ignoreOrder }) } as const;
    }, [text, ignoreOrder, result]);

    const comparison = outcome && "comparison" in outcome ? outcome.comparison : undefined;

    return (
        <section className="space-y-2 rounded-lg border bg-card p-3" aria-label={`Compare with the ${dialectLabel} output`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="expected-output" className="text-xs font-medium">Compare with what {dialectLabel} returned</Label>
                <label htmlFor="ignore-order" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Switch id="ignore-order" checked={ignoreOrder} onCheckedChange={setIgnoreOrder} aria-label="Ignore the order of rows" />
                    Ignore row order
                </label>
            </div>
            <Textarea
                id="expected-output"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={"Paste the result from the original database, with the column names on the first line.\nCopied from a grid, a SQL*Plus or psql table, or a CSV export."}
                className="min-h-24 font-mono text-xs"
                spellCheck={false}
            />

            {outcome && "error" in outcome && <p className="text-xs text-destructive" role="alert">{outcome.error}</p>}

            {comparison && <ComparisonSummary comparison={comparison} dialectLabel={dialectLabel} ignoreOrder={ignoreOrder} />}
        </section>
    );
};
