import React, { useState, useEffect } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import CodeEditor from "@/components/code-editor";
import { AgentTimeline } from "./agent-timeline";
import { IndexRecommendations } from "./index-recommendations";
import { DiffView } from "./diff-view";
import { ENTERPRISE_SAMPLE_QUERIES } from "../samples";
import { LegacyDialect, TargetDialect, ModernizeResponse, AgentTrace } from "../types";
import { modernizeQuery } from "../orchestrator";
import { useDatabase } from "@/providers/database-provider/database-provider";
import { Sparkles, Copy, Check, Play, ArrowRight, Database, Bot, Zap, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

interface QueryModernizerModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
}

export const QueryModernizerModal: React.FC<QueryModernizerModalProps> = ({
    isOpen,
    onOpenChange,
}) => {
    const { database } = useDatabase();

    const [sourceDialect, setSourceDialect] = useState<LegacyDialect>("oracle");
    const [targetDialect, setTargetDialect] = useState<TargetDialect>("postgresql");
    const [legacySql, setLegacySql] = useState<string>(ENTERPRISE_SAMPLE_QUERIES[0].legacySql);
    const [activeSampleId, setActiveSampleId] = useState<string>(ENTERPRISE_SAMPLE_QUERIES[0].id);

    const [isExecuting, setIsExecuting] = useState(false);
    const [activeTab, setActiveTab] = useState("sql");
    const [result, setResult] = useState<ModernizeResponse | null>(null);
    const [liveTraces, setLiveTraces] = useState<AgentTrace[]>([]);
    const [copied, setCopied] = useState(false);

    // Load initial sample
    const handleSelectSample = (sampleId: string) => {
        const sample = ENTERPRISE_SAMPLE_QUERIES.find(s => s.id === sampleId);
        if (!sample) return;

        setActiveSampleId(sample.id);
        setSourceDialect(sample.sourceDialect);
        setTargetDialect(sample.targetDialect);
        setLegacySql(sample.legacySql);
        setResult(null);
        setLiveTraces([]);
    };

    const handleRunModernizer = async () => {
        if (!legacySql.trim()) {
            toast.error("Please enter a legacy SQL query to modernize.");
            return;
        }

        setIsExecuting(true);
        setLiveTraces([]);
        setActiveTab("swarm");

        try {
            // Build schema context from current open canvas database
            const schemaContext = database ? {
                databaseName: database.name,
                dialect: database.dialect,
                tables: database.tables.map(t => ({
                    name: t.name,
                    columns: t.fields.map(f => ({
                        name: f.name,
                        type: f.data_type,
                        isPrimary: f.primary_key,
                        isUnique: f.unique,
                    }))
                }))
            } : undefined;

            const res = await modernizeQuery(
                {
                    legacySql,
                    sourceDialect,
                    targetDialect,
                    schemaContext,
                    options: { optimize: true, generateIndexes: true }
                },
                (trace) => {
                    setLiveTraces(prev => [...prev, trace]);
                }
            );

            setResult(res);
            toast.success(`Query modernized! ${res.confidenceScore}% confidence score.`);
        } catch (error) {
            toast.error(`Modernization failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setIsExecuting(false);
        }
    };

    const handleCopyModernizedSql = () => {
        const textToCopy = result?.optimizedSql || result?.translatedSql;
        if (!textToCopy) return;

        navigator.clipboard.writeText(textToCopy);
        setCopied(true);
        toast.success("Modernized SQL copied to clipboard!");
        setTimeout(() => setCopied(false), 2000);
    };

    // Auto-run when modal first opens with sample
    useEffect(() => {
        if (isOpen && !result && !isExecuting) {
            handleRunModernizer();
        }
    }, [isOpen]);

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-[95vw] lg:max-w-7xl h-[92vh] flex flex-col p-4 sm:p-6 gap-3">
                <DialogHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/40 space-y-0">
                    <div className="flex items-center gap-2.5">
                        <div className="p-2 rounded-lg bg-primary/10 border border-primary/20 text-primary">
                            <Bot className="h-5 w-5" />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <DialogTitle className="text-base sm:text-lg font-bold text-foreground">
                                    Enterprise Query Modernizer Studio
                                </DialogTitle>
                                <Badge className="bg-primary/20 text-primary border-primary/30 text-[10px] font-semibold">
                                    Multi-Agent Swarm
                                </Badge>
                            </div>
                            <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                                Autonomous multi-agent pipeline translates, validates & optimizes legacy SQL into modern cloud schemas.
                            </DialogDescription>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        {database && (
                            <Badge variant="outline" className="hidden sm:flex text-xs items-center gap-1.5 text-muted-foreground bg-muted/30">
                                <Database className="h-3.5 w-3.5 text-primary" />
                                <span>Canvas Context: <strong>{database.name}</strong></span>
                            </Badge>
                        )}
                    </div>
                </DialogHeader>

                {/* Top Configuration & Enterprise Sample Picker Bar */}
                <div className="flex flex-wrap items-center justify-between gap-2.5 p-2.5 rounded-lg bg-muted/40 border border-border/50">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            Enterprise Benchmark:
                        </span>
                        <div className="flex gap-1.5 flex-wrap">
                            {ENTERPRISE_SAMPLE_QUERIES.map(sample => (
                                <Button
                                    key={sample.id}
                                    size="sm"
                                    variant={activeSampleId === sample.id ? "secondary" : "ghost"}
                                    onClick={() => handleSelectSample(sample.id)}
                                    className={`h-7 text-xs px-2.5 font-medium ${
                                        activeSampleId === sample.id
                                            ? "border border-primary/30 bg-primary/10 text-primary"
                                            : "text-muted-foreground"
                                    }`}
                                >
                                    {sample.title.split(":")[0]}
                                </Button>
                            ))}
                        </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        <div className="flex items-center gap-1.5">
                            <span className="text-xs text-muted-foreground">Source:</span>
                            <Select value={sourceDialect} onValueChange={(v) => setSourceDialect(v as LegacyDialect)}>
                                <SelectTrigger className="h-7 w-28 text-xs font-mono uppercase bg-background">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="oracle">Oracle 11g/19c</SelectItem>
                                    <SelectItem value="mssql">SQL Server (T-SQL)</SelectItem>
                                    <SelectItem value="mysql">Legacy MySQL</SelectItem>
                                    <SelectItem value="db2">IBM DB2</SelectItem>
                                    <SelectItem value="sqlite">SQLite</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />

                        <div className="flex items-center gap-1.5">
                            <span className="text-xs text-muted-foreground">Target:</span>
                            <Select value={targetDialect} onValueChange={(v) => setTargetDialect(v as TargetDialect)}>
                                <SelectTrigger className="h-7 w-28 text-xs font-mono uppercase bg-background">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="postgresql">PostgreSQL 16</SelectItem>
                                    <SelectItem value="mysql">MySQL 8.4</SelectItem>
                                    <SelectItem value="sqlite">SQLite 3</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                </div>

                {/* Studio Split Layout */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 flex-1 min-h-0">
                    {/* Left Pane: Legacy SQL Input */}
                    <div className="flex flex-col rounded-lg border border-border/60 bg-card overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2 bg-muted/40 border-b border-border/40">
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                    Legacy Enterprise Query
                                </span>
                                <Badge variant="outline" className="text-[10px] font-mono uppercase">
                                    {sourceDialect}
                                </Badge>
                            </div>

                            <Button
                                size="sm"
                                onClick={handleRunModernizer}
                                disabled={isExecuting}
                                className="h-7 text-xs gap-1.5 font-semibold bg-primary text-primary-foreground shadow-xs hover:bg-primary/90"
                            >
                                <Play className={`h-3 w-3 ${isExecuting ? "animate-spin" : ""}`} />
                                {isExecuting ? "Running Agents..." : "Modernize Query (Run Swarm)"}
                            </Button>
                        </div>

                        <div className="flex-1 min-h-0 p-1">
                            <CodeEditor
                                value={legacySql}
                                onChange={(val) => setLegacySql(val)}
                                className="h-full font-mono text-xs"
                            />
                        </div>
                    </div>

                    {/* Right Pane: Modernized Studio & Agent Trace */}
                    <div className="flex flex-col rounded-lg border border-border/60 bg-card overflow-hidden">
                        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
                            <div className="flex items-center justify-between px-3 py-1.5 bg-muted/40 border-b border-border/40">
                                <TabsList className="h-8 bg-background/60 p-0.5 border border-border/40">
                                    <TabsTrigger value="sql" className="text-xs h-7 px-2.5 gap-1.5">
                                        <Sparkles className="h-3 w-3 text-primary" />
                                        Modernized SQL
                                    </TabsTrigger>
                                    <TabsTrigger value="swarm" className="text-xs h-7 px-2.5 gap-1.5">
                                        <Bot className="h-3 w-3 text-sky-400" />
                                        Agent Swarm Trace
                                        {result && (
                                            <Badge variant="secondary" className="ml-1 text-[9px] px-1 py-0 h-4 bg-sky-500/10 text-sky-500">
                                                5
                                            </Badge>
                                        )}
                                    </TabsTrigger>
                                    <TabsTrigger value="indexes" className="text-xs h-7 px-2.5 gap-1.5">
                                        <Zap className="h-3 w-3 text-amber-500" />
                                        Index Advisory
                                        {result && result.indexRecommendations.length > 0 && (
                                            <Badge variant="secondary" className="ml-1 text-[9px] px-1 py-0 h-4 bg-amber-500/10 text-amber-500">
                                                {result.indexRecommendations.length}
                                            </Badge>
                                        )}
                                    </TabsTrigger>
                                    <TabsTrigger value="diff" className="text-xs h-7 px-2.5 gap-1.5">
                                        <ShieldCheck className="h-3 w-3 text-purple-400" />
                                        Audit & Diff
                                        {result && (
                                            <Badge variant="secondary" className="ml-1 text-[9px] px-1 py-0 h-4 bg-purple-500/10 text-purple-400 font-bold">
                                                {result.confidenceScore}%
                                            </Badge>
                                        )}
                                    </TabsTrigger>
                                </TabsList>

                                {activeTab === "sql" && result && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={handleCopyModernizedSql}
                                        className="h-7 text-xs gap-1.5"
                                    >
                                        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                                        Copy Modernized SQL
                                    </Button>
                                )}
                            </div>

                            <div className="flex-1 min-h-0 overflow-y-auto p-2">
                                <TabsContent value="sql" className="m-0 h-full flex flex-col">
                                    {result ? (
                                        <div className="flex-1 flex flex-col min-h-0">
                                            <CodeEditor
                                                value={result.optimizedSql}
                                                readOnly={true}
                                                className="h-full font-mono text-xs border-0"
                                            />
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center justify-center h-full text-center p-6 text-muted-foreground">
                                            <Bot className="h-10 w-10 text-muted-foreground/40 mb-3 animate-pulse" />
                                            <p className="text-sm font-medium">Click "Modernize Query" to run the agent swarm</p>
                                            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                                                Agents will transpile syntax, validate against target schema, eliminate anti-patterns, and optimize for cloud performance.
                                            </p>
                                        </div>
                                    )}
                                </TabsContent>

                                <TabsContent value="swarm" className="m-0">
                                    <AgentTimeline
                                        traces={result ? result.agentTraces : liveTraces}
                                        isExecuting={isExecuting}
                                    />
                                </TabsContent>

                                <TabsContent value="indexes" className="m-0">
                                    <IndexRecommendations
                                        recommendations={result ? result.indexRecommendations : []}
                                    />
                                </TabsContent>

                                <TabsContent value="diff" className="m-0">
                                    {result ? (
                                        <DiffView result={result} />
                                    ) : (
                                        <div className="flex items-center justify-center h-48 text-muted-foreground text-xs">
                                            No audit report generated yet. Run modernization to inspect diff.
                                        </div>
                                    )}
                                </TabsContent>
                            </div>
                        </Tabs>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};
