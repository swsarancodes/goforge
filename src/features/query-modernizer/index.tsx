import { useEffect, useState } from "react";
import { ArrowRight, Check, Code2, Copy, Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import CodeEditor from "@/components/code-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDatabase } from "@/providers/database-provider/database-provider";
import { AgentTimeline } from "./components/agent-timeline";
import { DiffView } from "./components/diff-view";
import { IndexRecommendations } from "./components/index-recommendations";
import { modernizeQuery } from "./orchestrator";
import { ENTERPRISE_SAMPLE_QUERIES } from "./samples";
import { AgentTrace, LegacyDialect, ModernizeResponse, TargetDialect } from "./types";

interface Saved {
    sourceDialect: LegacyDialect;
    targetDialect: TargetDialect;
    legacySql: string;
    activeSampleId: string;
    activeTab: string;
    result: ModernizeResponse | null;
    liveTraces: AgentTrace[];
}

// Switching sidebar tabs unmounts the page; keep what the user was working on so coming back isn't a reset.
let saved: Saved | undefined;

/**
 * Query Modernizer: paste a query written for an older database, pick the dialect to convert it to, and get the
 * converted SQL back with the steps that produced it, index suggestions, and a review of what changed.
 */
const QueryModernizerPage: React.FC = () => {
    const { database } = useDatabase();

    const [sourceDialect, setSourceDialect] = useState<LegacyDialect>(saved?.sourceDialect ?? "oracle");
    const [targetDialect, setTargetDialect] = useState<TargetDialect>(saved?.targetDialect ?? "postgresql");
    const [legacySql, setLegacySql] = useState<string>(saved?.legacySql ?? ENTERPRISE_SAMPLE_QUERIES[0].legacySql);
    const [activeSampleId, setActiveSampleId] = useState<string>(saved?.activeSampleId ?? ENTERPRISE_SAMPLE_QUERIES[0].id);

    const [isExecuting, setIsExecuting] = useState(false);
    const [activeTab, setActiveTab] = useState(saved?.activeTab ?? "sql");
    const [result, setResult] = useState<ModernizeResponse | null>(saved?.result ?? null);
    const [liveTraces, setLiveTraces] = useState<AgentTrace[]>(saved?.liveTraces ?? []);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        saved = { sourceDialect, targetDialect, legacySql, activeSampleId, activeTab, result, liveTraces };
    }, [sourceDialect, targetDialect, legacySql, activeSampleId, activeTab, result, liveTraces]);

    const handleSelectSample = (sampleId: string) => {
        const sample = ENTERPRISE_SAMPLE_QUERIES.find((candidate) => candidate.id === sampleId);
        if (!sample) return;

        setActiveSampleId(sample.id);
        setSourceDialect(sample.sourceDialect);
        setTargetDialect(sample.targetDialect);
        setLegacySql(sample.legacySql);
        setResult(null);
        setLiveTraces([]);
        setActiveTab("sql");
    };

    const handleRun = async () => {
        if (!legacySql.trim()) {
            toast.error("Enter a query to convert.");
            return;
        }

        setIsExecuting(true);
        setLiveTraces([]);
        setResult(null);
        setActiveTab("steps");

        try {
            // The tables on the open canvas are the schema the query is checked against.
            const schemaContext = database
                ? {
                      databaseName: database.name,
                      dialect: database.dialect,
                      tables: database.tables.map((table) => ({
                          name: table.name,
                          columns: table.fields.map((field) => ({
                              name: field.name,
                              type: field.type?.name ?? "",
                              isPrimary: !!field.isPrimary,
                              isUnique: !!field.unique,
                          })),
                      })),
                  }
                : undefined;

            const response = await modernizeQuery(
                { legacySql, sourceDialect, targetDialect, schemaContext, options: { optimize: true, generateIndexes: true } },
                (trace) => setLiveTraces((previous) => [...previous, trace]),
            );

            setResult(response);
            setActiveTab("sql");
            toast.success(`Query converted. ${response.confidenceScore}% confidence.`);
        } catch (error) {
            toast.error(`Conversion failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setIsExecuting(false);
        }
    };

    const handleCopy = async () => {
        const text = result?.optimizedSql || result?.translatedSql;
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            toast.success("SQL copied");
            setTimeout(() => setCopied(false), 2000);
        } catch {
            toast.error("Couldn't copy. The browser blocked clipboard access.");
        }
    };

    return (
        <div className="w-full h-full min-h-0 overflow-y-auto bg-background">
            <div className="flex flex-col gap-3 p-4 lg:h-full lg:min-h-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                        <h1 className="text-base font-semibold">Query Modernizer</h1>
                        <p className="text-sm text-muted-foreground">Convert a query written for an older database to a current dialect, checked against the tables on your canvas.</p>
                    </div>
                    {database && (
                        <Badge variant="outline" className="text-xs font-normal text-muted-foreground shrink-0">
                            Checked against {database.name}
                        </Badge>
                    )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-2.5">
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <span className="text-xs text-muted-foreground">Examples</span>
                        {ENTERPRISE_SAMPLE_QUERIES.map((sample) => (
                            <Button
                                key={sample.id}
                                size="sm"
                                variant={activeSampleId === sample.id ? "secondary" : "ghost"}
                                onClick={() => handleSelectSample(sample.id)}
                                className="h-7 px-2.5 text-xs"
                            >
                                {sample.title.split(":")[0]}
                            </Button>
                        ))}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        <Select value={sourceDialect} onValueChange={(value) => setSourceDialect(value as LegacyDialect)}>
                            <SelectTrigger size="sm" className="h-8 w-40 text-xs" aria-label="Convert from">
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

                        <ArrowRight className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />

                        <Select value={targetDialect} onValueChange={(value) => setTargetDialect(value as TargetDialect)}>
                            <SelectTrigger size="sm" className="h-8 w-36 text-xs" aria-label="Convert to">
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

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:flex-1 lg:min-h-0">
                    <section className="flex flex-col rounded-lg border bg-card overflow-hidden min-h-[360px] lg:min-h-0">
                        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b">
                            <div className="flex items-center gap-2 min-w-0">
                                <h2 className="text-sm font-medium">Original query</h2>
                                <Badge variant="outline" className="text-[10px] font-mono uppercase">
                                    {sourceDialect}
                                </Badge>
                            </div>
                            <Button size="sm" onClick={handleRun} disabled={isExecuting} className="h-8 gap-1.5 text-xs">
                                {isExecuting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                                {isExecuting ? "Converting…" : "Convert"}
                            </Button>
                        </div>
                        <div className="flex-1 min-h-0 p-1">
                            <CodeEditor value={legacySql} onChange={(value) => setLegacySql(value)} className="h-full font-mono text-xs" />
                        </div>
                    </section>

                    <section className="flex flex-col rounded-lg border bg-card overflow-hidden min-h-[360px] lg:min-h-0">
                        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0 gap-0">
                            <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b">
                                <TabsList className="h-8">
                                    <TabsTrigger value="sql" className="text-xs px-2.5">
                                        Result
                                    </TabsTrigger>
                                    <TabsTrigger value="steps" className="text-xs px-2.5">
                                        Steps
                                    </TabsTrigger>
                                    <TabsTrigger value="indexes" className="text-xs px-2.5">
                                        Indexes
                                        {result && result.indexRecommendations.length > 0 && <span className="ml-1 text-muted-foreground">{result.indexRecommendations.length}</span>}
                                    </TabsTrigger>
                                    <TabsTrigger value="diff" className="text-xs px-2.5">
                                        Review
                                        {result && <span className="ml-1 text-muted-foreground">{result.confidenceScore}%</span>}
                                    </TabsTrigger>
                                </TabsList>

                                {activeTab === "sql" && result && (
                                    <Button size="sm" variant="outline" onClick={handleCopy} className="h-8 gap-1.5 text-xs">
                                        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                                        Copy
                                    </Button>
                                )}
                            </div>

                            <div className="flex-1 min-h-0 overflow-y-auto p-2">
                                <TabsContent value="sql" className="m-0 h-full flex flex-col">
                                    {result ? (
                                        <CodeEditor value={result.optimizedSql} readOnly={true} className="h-full font-mono text-xs border-0" />
                                    ) : (
                                        <div className="flex flex-col items-center justify-center h-full text-center p-6 text-muted-foreground">
                                            <Code2 className="size-8 mb-3 opacity-40" aria-hidden="true" />
                                            <p className="text-sm font-medium text-foreground">No result yet</p>
                                            <p className="text-xs mt-1 max-w-sm">Choose Convert to translate the query, check it against your tables, and look for slow patterns.</p>
                                        </div>
                                    )}
                                </TabsContent>

                                <TabsContent value="steps" className="m-0">
                                    <AgentTimeline traces={result ? result.agentTraces : liveTraces} isExecuting={isExecuting} />
                                </TabsContent>

                                <TabsContent value="indexes" className="m-0">
                                    <IndexRecommendations recommendations={result ? result.indexRecommendations : []} />
                                </TabsContent>

                                <TabsContent value="diff" className="m-0">
                                    {result ? (
                                        <DiffView result={result} />
                                    ) : (
                                        <div className="flex items-center justify-center h-48 text-muted-foreground text-xs">Convert a query to see what changed.</div>
                                    )}
                                </TabsContent>
                            </div>
                        </Tabs>
                    </section>
                </div>
            </div>
        </div>
    );
};

export default QueryModernizerPage;
