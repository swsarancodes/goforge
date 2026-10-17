import React from "react";
import { ModernizeResponse } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldCheck, AlertTriangle, CheckCircle, Copy, Check, Terminal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface DiffViewProps {
    result: ModernizeResponse;
}

export const DiffView: React.FC<DiffViewProps> = ({ result }) => {
    const [copied, setCopied] = useState(false);

    const handleCopyVerification = () => {
        if (!result.verificationSql) return;
        navigator.clipboard.writeText(result.verificationSql);
        setCopied(true);
        toast.success("Verification query copied to clipboard!");
        setTimeout(() => setCopied(false), 2000);
    };

    const isLowRisk = result.riskLevel === "low";
    const isMediumRisk = result.riskLevel === "medium";

    return (
        <div className="flex flex-col gap-4 p-1">
            {/* Top Score Banner */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-lg border border-border/60 bg-card/60 p-3 flex items-center justify-between">
                    <div>
                        <span className="text-[11px] text-muted-foreground uppercase font-semibold">
                            Equivalence Score
                        </span>
                        <div className="text-xl font-bold text-foreground mt-0.5">
                            {result.confidenceScore}%
                        </div>
                    </div>
                    <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-xs">
                        <CheckCircle className="h-3.5 w-3.5 mr-1" />
                        Verified Parity
                    </Badge>
                </div>

                <div className="rounded-lg border border-border/60 bg-card/60 p-3 flex items-center justify-between">
                    <div>
                        <span className="text-[11px] text-muted-foreground uppercase font-semibold">
                            Risk Classification
                        </span>
                        <div className="text-xl font-bold uppercase text-foreground mt-0.5">
                            {result.riskLevel}
                        </div>
                    </div>
                    <Badge
                        variant="outline"
                        className={
                            isLowRisk
                                ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30 text-xs"
                                : isMediumRisk
                                ? "bg-amber-500/10 text-amber-500 border-amber-500/30 text-xs"
                                : "bg-red-500/10 text-red-500 border-red-500/30 text-xs"
                        }
                    >
                        {isLowRisk ? <ShieldCheck className="h-3.5 w-3.5 mr-1" /> : <AlertTriangle className="h-3.5 w-3.5 mr-1" />}
                        {isLowRisk ? "Safe for Staging" : isMediumRisk ? "Review Recommended" : "Manual Check"}
                    </Badge>
                </div>

                <div className="rounded-lg border border-border/60 bg-card/60 p-3 flex items-center justify-between">
                    <div>
                        <span className="text-[11px] text-muted-foreground uppercase font-semibold">
                            Code Diff Delta
                        </span>
                        <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-emerald-500 font-bold font-mono text-sm">+{result.diff.additions}</span>
                            <span className="text-rose-500 font-bold font-mono text-sm">-{result.diff.deletions}</span>
                        </div>
                    </div>
                    <span className="text-[11px] text-muted-foreground font-mono">
                        {result.transformationsSummary.length} transforms
                    </span>
                </div>
            </div>

            {/* Transformations Breakdown */}
            <div className="rounded-lg border border-border/60 bg-card/60 p-3">
                <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-2">
                    Applied Agentic Transformations
                </h4>
                <ul className="space-y-1.5 pl-1">
                    {result.transformationsSummary.map((trans, i) => (
                        <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                            <span className="text-emerald-500 font-bold">•</span>
                            <span>{trans}</span>
                        </li>
                    ))}
                </ul>
            </div>

            {/* Verification Probe */}
            {result.verificationSql && (
                <div className="rounded-lg border border-border/60 bg-card/60 p-3">
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                            <Terminal className="h-4 w-4 text-purple-400" />
                            <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">
                                Automated Runtime Equivalence Probe
                            </h4>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={handleCopyVerification}
                            className="h-7 text-xs gap-1.5"
                        >
                            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                            Copy Probe
                        </Button>
                    </div>
                    <pre className="font-mono text-[11px] text-muted-foreground bg-muted/40 p-2.5 rounded-md overflow-x-auto select-all">
                        {result.verificationSql}
                    </pre>
                </div>
            )}
        </div>
    );
};
