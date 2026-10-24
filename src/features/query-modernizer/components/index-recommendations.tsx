import React from "react";
import { Copy, Terminal } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useOpenInSqlEditor } from "@/features/sql-editor/use-open-in-sql-editor";
import type { IndexAdvice } from "../engine/index-advice";

interface IndexRecommendationsProps {
    advice: IndexAdvice | undefined;
    /** Suggestions need the project's tables to compare against. */
    hasTables: boolean;
}

export const IndexRecommendations: React.FC<IndexRecommendationsProps> = ({ advice, hasTables }) => {
    const openInSqlEditor = useOpenInSqlEditor();

    const copy = async (ddl: string) => {
        try {
            await navigator.clipboard.writeText(ddl);
            toast.success("SQL copied");
        } catch {
            toast.error("Couldn't copy. The browser blocked clipboard access.");
        }
    };

    if (!hasTables) {
        return (
            <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
                <h4 className="text-sm font-medium text-foreground">No tables to compare with</h4>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">Index suggestions come from what the query filters and joins on, checked against the tables and indexes in your project. Import or draw your tables first.</p>
            </div>
        );
    }

    const recommendations = advice?.recommendations ?? [];
    const notes = advice?.notes ?? [];
    if (recommendations.length === 0 && notes.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
                <h4 className="text-sm font-medium text-foreground">No index suggestions</h4>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">Every column this query filters or joins on is already the start of an index in your project, is a key, or the query doesn't filter on a plain column.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3 p-1">
            {recommendations.length > 0 && <p className="px-1 text-xs font-medium text-muted-foreground">Index suggestions ({recommendations.length})</p>}

            {recommendations.map((index) => (
                <div key={index.id} className="rounded-lg border bg-card p-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-xs font-medium text-foreground break-all">{index.name}</span>
                                <Badge variant="secondary" className="text-[10px] py-0 px-1.5 font-mono">
                                    on {index.tableName} ({index.columns.join(", ")})
                                </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">{index.reason}</p>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={() => copy(index.ddl)}>
                                <Copy className="size-3" /> Copy
                            </Button>
                            <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => openInSqlEditor(index.ddl, "Modernizer")} title="Run this against a live PostgreSQL connection">
                                <Terminal className="size-3" /> Open in SQL Editor
                            </Button>
                        </div>
                    </div>

                    <pre className="mt-2 pt-2 border-t font-mono text-[11px] text-muted-foreground bg-muted/40 p-2 rounded-md overflow-x-auto select-all">{index.ddl}</pre>
                </div>
            ))}

            {notes.map((note, index) => (
                <p key={index} className="rounded-lg border border-l-2 border-l-amber-500 bg-card p-3 text-xs text-muted-foreground leading-relaxed">
                    {note}
                </p>
            ))}

            {recommendations.length > 0 && <p className="px-1 text-[11px] text-muted-foreground">These come from the query's conditions, not from measuring it. On a large table, create an index with CREATE INDEX CONCURRENTLY outside a transaction, and check the plan afterwards.</p>}
        </div>
    );
};
