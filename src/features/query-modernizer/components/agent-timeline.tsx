import React from "react";
import { AgentTrace } from "../types";
import { CheckCircle2, Clock, AlertCircle, RefreshCw, Sparkles, Database, Code2, ShieldCheck, Zap, Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface AgentTimelineProps {
    traces: AgentTrace[];
    activeAgentId?: string;
    isExecuting?: boolean;
}

const AGENT_ICONS: Record<string, React.ReactNode> = {
    mapper: <Database className="h-4 w-4 text-sky-400" />,
    transpiler: <Code2 className="h-4 w-4 text-indigo-400" />,
    validator: <ShieldCheck className="h-4 w-4 text-emerald-400" />,
    optimizer: <Zap className="h-4 w-4 text-amber-400" />,
    judge: <Scale className="h-4 w-4 text-purple-400" />,
};

export const AgentTimeline: React.FC<AgentTimelineProps> = ({ traces, isExecuting }) => {
    return (
        <div className="flex flex-col gap-3 p-1">
            <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-primary animate-pulse" />
                    <span className="text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                        Multi-Agent Reasoning Swarm
                    </span>
                </div>
                {isExecuting && (
                    <Badge variant="outline" className="text-xs bg-primary/10 border-primary/30 text-primary flex items-center gap-1.5 py-0.5">
                        <RefreshCw className="h-3 w-3 animate-spin" />
                        Agents Orchestrating...
                    </Badge>
                )}
            </div>

            <div className="flex flex-col gap-2.5">
                {traces.map((trace, idx) => {
                    const isSuccess = trace.status === "success";
                    const isRetrying = trace.status === "retrying";
                    const isRunning = trace.status === "running";

                    return (
                        <div
                            key={`${trace.agentId}-${idx}`}
                            className="group rounded-lg border border-border/60 bg-card/60 p-3 shadow-xs hover:border-primary/40 transition-all duration-200"
                        >
                            <div className="flex items-start justify-between gap-2">
                                <div className="flex items-center gap-2.5">
                                    <div className="p-1.5 rounded-md bg-muted/60 border border-border/40">
                                        {AGENT_ICONS[trace.agentId] || <Sparkles className="h-4 w-4 text-muted-foreground" />}
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <h4 className="text-xs font-semibold text-foreground">
                                                {trace.name}
                                            </h4>
                                            <span className="text-[10px] text-muted-foreground font-mono">
                                                ({trace.role})
                                            </span>
                                        </div>
                                        <p className="text-xs text-foreground/80 font-medium mt-0.5">
                                            {trace.title}
                                        </p>
                                    </div>
                                </div>

                                <div className="flex items-center gap-2">
                                    {trace.durationMs !== undefined && (
                                        <span className="text-[10px] text-muted-foreground/80 flex items-center gap-1 font-mono">
                                            <Clock className="h-3 w-3" />
                                            {trace.durationMs}ms
                                        </span>
                                    )}

                                    {isSuccess && (
                                        <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 text-[10px] px-1.5 py-0 flex items-center gap-1 border-emerald-500/20">
                                            <CheckCircle2 className="h-3 w-3" />
                                            Complete
                                        </Badge>
                                    )}
                                    {isRetrying && (
                                        <Badge variant="secondary" className="bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 text-[10px] px-1.5 py-0 flex items-center gap-1 border-amber-500/20 animate-pulse">
                                            <RefreshCw className="h-3 w-3 animate-spin" />
                                            Self-Correcting
                                        </Badge>
                                    )}
                                    {isRunning && (
                                        <Badge variant="secondary" className="bg-sky-500/10 text-sky-500 hover:bg-sky-500/20 text-[10px] px-1.5 py-0 flex items-center gap-1 border-sky-500/20 animate-pulse">
                                            <RefreshCw className="h-3 w-3 animate-spin" />
                                            Active
                                        </Badge>
                                    )}
                                    {trace.status === "error" && (
                                        <Badge variant="destructive" className="text-[10px] px-1.5 py-0 flex items-center gap-1">
                                            <AlertCircle className="h-3 w-3" />
                                            Flagged
                                        </Badge>
                                    )}
                                </div>
                            </div>

                            {trace.details && trace.details.length > 0 && (
                                <ul className="mt-2.5 pt-2 border-t border-border/30 space-y-1 pl-1">
                                    {trace.details.map((detail, dIdx) => (
                                        <li key={dIdx} className="text-[11px] text-muted-foreground leading-relaxed flex items-start gap-1.5">
                                            <span className="text-primary/70 font-bold select-none">•</span>
                                            <span>{detail}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
