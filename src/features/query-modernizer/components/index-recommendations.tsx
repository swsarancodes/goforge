import React, { useState } from "react";
import { IndexRecommendation } from "../types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Zap, Check, Plus, Database, Sparkles } from "lucide-react";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { toast } from "sonner";

interface IndexRecommendationsProps {
    recommendations: IndexRecommendation[];
}

export const IndexRecommendations: React.FC<IndexRecommendationsProps> = ({ recommendations }) => {
    const { database } = useDatabase();
    const { addIndex } = useDatabaseOperations();
    const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());

    if (!recommendations || recommendations.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
                <Database className="h-8 w-8 text-muted-foreground/50 mb-2" />
                <h4 className="text-sm font-semibold text-foreground">No Missing Indexes Flagged</h4>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                    The optimizer verified that all joins and filter predicates in this query are either already covered or structurally optimal.
                </p>
            </div>
        );
    }

    const handleApplyIndex = (idx: IndexRecommendation) => {
        if (!database) {
            toast.error("No database project currently open on canvas.");
            return;
        }

        // Find matching table in database
        const targetTable = database.tables.find(
            t => t.name.toLowerCase() === idx.tableName.toLowerCase()
        );

        if (!targetTable) {
            toast.warning(`Table "${idx.tableName}" not found in current canvas. You can still run the DDL manually.`);
            return;
        }

        try {
            // Apply index to table using GoForge database operations
            addIndex(targetTable.id, {
                name: idx.name,
                fields: idx.columns,
                is_unique: idx.unique,
            });

            setAppliedIds(prev => new Set(prev).add(idx.id));
            toast.success(`Applied index "${idx.name}" to table "${targetTable.name}" on canvas!`);
        } catch (error) {
            toast.error(`Failed to apply index: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    return (
        <div className="flex flex-col gap-3 p-1">
            <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-amber-500 animate-pulse" />
                    <span className="text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                        Optimizer Index Advisory ({recommendations.length})
                    </span>
                </div>
                <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-500 border-amber-500/30">
                    Canvas Live Sync
                </Badge>
            </div>

            <div className="flex flex-col gap-3">
                {recommendations.map(idx => {
                    const isApplied = appliedIds.has(idx.id);

                    return (
                        <div
                            key={idx.id}
                            className="rounded-lg border border-border/60 bg-card/60 p-3 shadow-xs hover:border-amber-500/40 transition-all duration-200"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <span className="font-mono text-xs font-semibold text-foreground">
                                            {idx.name}
                                        </span>
                                        <Badge variant="secondary" className="text-[10px] bg-muted py-0 px-1.5 font-mono">
                                            on {idx.tableName} ({idx.columns.join(", ")})
                                        </Badge>
                                    </div>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                        {idx.reason}
                                    </p>
                                </div>

                                <div className="flex flex-col items-end gap-1.5 shrink-0">
                                    <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-[10px] font-semibold">
                                        <Sparkles className="h-3 w-3 mr-1" />
                                        {idx.estimatedImpact}
                                    </Badge>

                                    <Button
                                        size="sm"
                                        variant={isApplied ? "secondary" : "default"}
                                        disabled={isApplied}
                                        onClick={() => handleApplyIndex(idx)}
                                        className="h-7 text-xs gap-1.5 font-medium"
                                    >
                                        {isApplied ? (
                                            <>
                                                <Check className="h-3 w-3 text-emerald-500" />
                                                Applied to Canvas
                                            </>
                                        ) : (
                                            <>
                                                <Plus className="h-3 w-3" />
                                                Apply to Canvas
                                            </>
                                        )}
                                    </Button>
                                </div>
                            </div>

                            <div className="mt-2 pt-2 border-t border-border/40">
                                <pre className="font-mono text-[11px] text-muted-foreground bg-muted/40 p-2 rounded-md overflow-x-auto select-all">
                                    {idx.ddl}
                                </pre>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
