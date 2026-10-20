import React from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ModernizeResponse } from "../types";

interface DiffViewProps {
    result: ModernizeResponse;
}

const RISK_LABEL: Record<ModernizeResponse["riskLevel"], string> = {
    low: "Low risk",
    medium: "Review before using",
    high: "Check by hand",
};

const List: React.FC<{ title: string; items: string[] }> = ({ title, items }) =>
    items.length === 0 ? null : (
        <div className="rounded-lg border bg-card p-3">
            <h4 className="text-xs font-medium text-foreground mb-2">{title}</h4>
            <ul className="space-y-1.5 pl-1">
                {items.map((item, index) => (
                    <li key={index} className="text-xs text-muted-foreground flex items-start gap-2">
                        <span aria-hidden="true">•</span>
                        <span className="min-w-0 break-words">{item}</span>
                    </li>
                ))}
            </ul>
        </div>
    );

/** What changed and what to double check. Nothing here proves the two queries return the same rows. */
export const DiffView: React.FC<DiffViewProps> = ({ result }) => {
    const copyCheck = async () => {
        if (!result.verificationSql) return;
        try {
            await navigator.clipboard.writeText(result.verificationSql);
            toast.success("Query copied");
        } catch {
            toast.error("Couldn't copy. The browser blocked clipboard access.");
        }
    };

    const { validationReport } = result;

    return (
        <div className="flex flex-col gap-3 p-1">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-lg border bg-card p-3">
                    <span className="text-[11px] text-muted-foreground">Confidence</span>
                    <div className="text-xl font-semibold mt-0.5">{result.confidenceScore}%</div>
                    <span className="text-[11px] text-muted-foreground">An estimate from the checks below, not a proof.</span>
                </div>
                <div className="rounded-lg border bg-card p-3">
                    <span className="text-[11px] text-muted-foreground">Risk</span>
                    <div className="mt-1">
                        <Badge variant="outline" className={result.riskLevel === "high" ? "border-destructive/50 text-destructive" : result.riskLevel === "medium" ? "border-amber-500/50 text-amber-600 dark:text-amber-400" : ""}>
                            {RISK_LABEL[result.riskLevel]}
                        </Badge>
                    </div>
                </div>
                <div className="rounded-lg border bg-card p-3">
                    <span className="text-[11px] text-muted-foreground">Lines changed</span>
                    <div className="flex items-center gap-2 mt-0.5 font-mono text-sm">
                        <span className="text-emerald-600 dark:text-emerald-400">+{result.diff.additions}</span>
                        <span className="text-rose-600 dark:text-rose-400">-{result.diff.deletions}</span>
                    </div>
                </div>
            </div>

            {result.aiNotice && <p className="text-xs text-muted-foreground rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">{result.aiNotice}</p>}
            {result.aiSummary && <p className="text-xs text-muted-foreground px-1">{result.aiSummary}</p>}

            <List title="What changed" items={result.transformationsSummary} />
            <List title="Not converted" items={result.aiUnsupported ?? []} />
            <List title="Things to check" items={[...(result.aiRisks ?? []), ...validationReport.schemaWarnings, ...validationReport.antiPatternsDetected]} />

            {result.verificationSql && (
                <div className="rounded-lg border bg-card p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                        <div>
                            <h4 className="text-xs font-medium text-foreground">Check on your database</h4>
                            <p className="text-[11px] text-muted-foreground">Counts the rows the converted query returns. Compare with the original on the same data.</p>
                        </div>
                        <Button size="sm" variant="outline" onClick={copyCheck} className="h-7 text-xs gap-1.5 shrink-0">
                            <Copy className="size-3.5" /> Copy
                        </Button>
                    </div>
                    <pre className="font-mono text-[11px] text-muted-foreground bg-muted/40 p-2.5 rounded-md overflow-x-auto select-all">{result.verificationSql}</pre>
                </div>
            )}
        </div>
    );
};
