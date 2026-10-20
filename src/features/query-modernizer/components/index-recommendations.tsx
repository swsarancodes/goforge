import React from "react";
import { Copy, Terminal } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useOpenInSqlEditor } from "@/features/sql-editor/use-open-in-sql-editor";
import { IndexRecommendation } from "../types";

interface IndexRecommendationsProps {
    recommendations: IndexRecommendation[];
}

export const IndexRecommendations: React.FC<IndexRecommendationsProps> = ({ recommendations }) => {
    const openInSqlEditor = useOpenInSqlEditor();

    const copy = async (ddl: string) => {
        try {
            await navigator.clipboard.writeText(ddl);
            toast.success("SQL copied");
        } catch {
            toast.error("Couldn't copy. The browser blocked clipboard access.");
        }
    };

    if (!recommendations || recommendations.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
                <h4 className="text-sm font-medium text-foreground">No index suggestions</h4>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">The joins and filters in this query are either already covered or don't need an index.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3 p-1">
            <p className="px-1 text-xs font-medium text-muted-foreground">Index suggestions ({recommendations.length})</p>

            {recommendations.map((idx) => (
                <div key={idx.id} className="rounded-lg border bg-card p-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-xs font-medium text-foreground break-all">{idx.name}</span>
                                <Badge variant="secondary" className="text-[10px] py-0 px-1.5 font-mono">
                                    on {idx.tableName} ({idx.columns.join(", ")})
                                </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">{idx.reason}</p>
                            {idx.estimatedImpact && <p className="text-[11px] text-muted-foreground">{idx.estimatedImpact}</p>}
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={() => copy(idx.ddl)}>
                                <Copy className="size-3" /> Copy
                            </Button>
                            <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => openInSqlEditor(idx.ddl, "Modernizer")} title="Run this against a live PostgreSQL connection">
                                <Terminal className="size-3" /> Open in SQL Editor
                            </Button>
                        </div>
                    </div>

                    <pre className="mt-2 pt-2 border-t font-mono text-[11px] text-muted-foreground bg-muted/40 p-2 rounded-md overflow-x-auto select-all">{idx.ddl}</pre>
                </div>
            ))}
        </div>
    );
};
