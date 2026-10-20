import React from "react";
import { Badge } from "@/components/ui/badge";
import type { ModernizeOutcome } from "../modernize";

/** Every rule that fired, what it means in plain words, and the text before and after. */
export const ChangesPanel: React.FC<{ outcome: ModernizeOutcome }> = ({ outcome }) => {
    const { applied } = outcome.engine;
    if (applied.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
                <h4 className="text-sm font-medium text-foreground">No rule changed anything</h4>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">The query already uses nothing the rules know to rewrite. That is not the same as being valid on PostgreSQL: see the Checks tab.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2.5 p-1">
            {applied.map((rule) => (
                <div key={rule.id} className="rounded-lg border bg-card p-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-xs font-medium text-foreground">{rule.title}</h4>
                        <Badge variant="outline" className="text-[10px] py-0 px-1.5 font-normal text-muted-foreground">
                            {rule.family}
                        </Badge>
                        <span className="ml-auto text-[11px] text-muted-foreground">{rule.count === 1 ? "once" : `${rule.count} times`}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{rule.why}</p>
                    {rule.examples.length > 0 && (
                        <div className="mt-2 space-y-1.5">
                            {rule.examples.map((example, index) => (
                                <div key={index} className="grid gap-1 rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                                    <div className="text-rose-700 dark:text-rose-300 break-all">− {example.before || "(removed)"}</div>
                                    <div className="text-emerald-700 dark:text-emerald-300 break-all">+ {example.after || "(removed)"}</div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
};
