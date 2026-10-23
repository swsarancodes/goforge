import { ArrowRight, Loader2, Play, Square } from "lucide-react";
import CodeEditor from "@/components/code-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCallback, useState } from "react";
import { ScriptView } from "./batch/batch-view";
import { setQueryHandoff } from "./query-handoff";
import { ChangesPanel } from "./components/changes-panel";
import { ChecksPanel } from "./components/checks-panel";
import { CompareView } from "./components/compare-view";
import { IndexRecommendations } from "./components/index-recommendations";
import { ResultPanel } from "./components/result-panel";
import { ModernizeMode, useModernizer } from "./use-modernizer";
import { LEGACY_DIALECTS, LegacyDialect } from "./types";

const NO_CONNECTION = "__none__";

/**
 * Query Modernizer: rewrite a query written for an older database so it runs on PostgreSQL.
 * Fixed rules do the rewriting. A live connection lets PostgreSQL itself say whether it accepts the result. A model is only
 * asked about what the rules couldn't do, and its answer is only shown if PostgreSQL accepts it.
 */
const SingleQueryView: React.FC = () => {
    const m = useModernizer();
    const { outcome } = m;
    const hasTables = !!m.schema;
    const dialectLabel = LEGACY_DIALECTS.find((candidate) => candidate.value === m.dialect)?.label ?? m.dialect;

    const checkCount = outcome ? outcome.engine.unconverted.length + outcome.engine.traps.length + (outcome.postgres.status === "rejected" ? 1 : 0) : 0;
    const indexCount = outcome ? outcome.advice.recommendations.length + outcome.advice.notes.length : 0;

    return (
        <div className="w-full h-full min-h-0 overflow-y-auto bg-background">
            <div className="flex flex-col gap-3 p-4 lg:h-full lg:min-h-0">
                <div className="min-w-0">
                    <p className="text-sm text-muted-foreground max-w-3xl">
                        Rewrites a query written for Oracle, SQL Server, MySQL or DB2 so it runs on PostgreSQL, and tells you what it could not convert and where the results can differ. It does not prove the new query returns the same rows.
                    </p>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-2.5">
                    <div className="flex items-center gap-2">
                        <Select value={m.dialect} onValueChange={(value) => m.setDialect(value as LegacyDialect)}>
                            <SelectTrigger size="sm" className="h-8 w-44 text-xs" aria-label="Convert from">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {LEGACY_DIALECTS.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>
                                        {option.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <ArrowRight className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
                        <Badge variant="outline" className="h-8 px-3 text-xs font-normal">
                            PostgreSQL
                        </Badge>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        <label className="flex min-w-0 max-w-full items-center gap-2 text-xs text-muted-foreground">
                            <span className="shrink-0">Check against</span>
                            <Select value={m.connection?.id ?? NO_CONNECTION} onValueChange={(value) => m.changeConnection(value === NO_CONNECTION ? undefined : value)}>
                                <SelectTrigger size="sm" className="h-8 w-64 min-w-0 max-w-full text-xs" aria-label="Check against" title={m.connection?.name}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NO_CONNECTION}>No database (syntax only)</SelectItem>
                                    {m.connections.map((connection) => (
                                        <SelectItem key={connection.id} value={connection.id}>
                                            {connection.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </label>
                        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground" title={m.aiConfigured ? undefined : (m.aiStatus?.problem ?? "Set OPENAI_API_KEY in server/.env (and pick a model under Schema Change → AI settings) to turn the model on")}>
                            <span id="modernize-mode-label" className="shrink-0">Converted by</span>
                            <ToggleGroup
                                type="single"
                                variant="outline"
                                size="sm"
                                value={m.mode}
                                onValueChange={(value) => value && m.changeMode(value as ModernizeMode)}
                                disabled={m.running}
                                aria-labelledby="modernize-mode-label"
                                className="shrink-0"
                            >
                                <ToggleGroupItem value="rules" className="h-8 flex-none px-3 text-xs" title="Fixed rules only. Nothing is sent to a model.">Rules</ToggleGroupItem>
                                <ToggleGroupItem value="auto" className="h-8 flex-none px-3 text-xs" disabled={!m.aiConfigured} title={m.aiConfigured ? `Rules first; ${m.aiStatus?.model || "the model"} only for what the rules can't do` : "No model is set up"}>Rules, then AI</ToggleGroupItem>
                                <ToggleGroupItem value="ai" className="h-8 flex-none px-3 text-xs" disabled={!m.aiConfigured} title={m.aiConfigured ? `${m.aiStatus?.model || "The model"} writes the conversion; PostgreSQL has to accept it, or the rules' version is shown` : "No model is set up"}>AI</ToggleGroupItem>
                            </ToggleGroup>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:flex-1 lg:min-h-0">
                    <section className="flex flex-col rounded-lg border bg-card overflow-hidden min-h-[360px] lg:min-h-0">
                        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b">
                            <div className="flex items-center gap-2 min-w-0">
                                <h2 className="text-sm font-medium">Original query</h2>
                                <Badge variant="outline" className="text-[10px] font-mono uppercase">
                                    {m.dialect}
                                </Badge>
                            </div>
                            <div className="flex items-center gap-2">
                                {m.running && (
                                    <Button size="sm" variant="outline" onClick={m.stop} className="h-8 gap-1.5 text-xs">
                                        <Square className="size-3" />
                                        Stop
                                    </Button>
                                )}
                                <Button size="sm" onClick={m.run} disabled={m.running || !m.sql.trim()} className="h-8 gap-1.5 text-xs" title="Convert (Ctrl or ⌘ + Enter)">
                                    {m.running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                                    {m.running ? "Converting…" : "Convert"}
                                </Button>
                            </div>
                        </div>
                        {m.mode !== "rules" && <p className="px-3 py-1.5 text-[11px] text-muted-foreground border-b bg-muted/30">{m.mode === "ai" ? "The query and your table and column names are sent to the model. No data is." : "If the rules can't finish, the query and your table and column names are sent to the model. No data is."}</p>}
                        <div className="flex-1 min-h-0 p-1">
                            <CodeEditor
                                value={m.sql}
                                onChange={m.setSql}
                                onRun={() => void m.run()}
                                ghostText={m.ghostText}
                                placeholder={`Paste a query written for ${dialectLabel} here.\n\n${hasTables ? "" : "Once this project has tables, an example built from them appears here too."}`.trim()}
                                className="h-full font-mono text-xs"
                            />
                        </div>
                    </section>

                    <section className="flex flex-col rounded-lg border bg-card overflow-hidden min-h-[360px] lg:min-h-0">
                        <Tabs value={m.tab} onValueChange={m.setTab} className="flex flex-col flex-1 min-h-0 gap-0">
                            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 border-b">
                                <TabsList className="h-8">
                                    <TabsTrigger value="result" className="text-xs px-2.5">
                                        Result
                                    </TabsTrigger>
                                    <TabsTrigger value="checks" className="text-xs px-2.5">
                                        Checks
                                        {outcome && checkCount > 0 && <span className="ml-1 text-muted-foreground">{checkCount}</span>}
                                    </TabsTrigger>
                                    <TabsTrigger value="changes" className="text-xs px-2.5">
                                        Changes
                                        {outcome && outcome.engine.applied.length > 0 && <span className="ml-1 text-muted-foreground">{outcome.engine.applied.length}</span>}
                                    </TabsTrigger>
                                    <TabsTrigger value="compare" className="text-xs px-2.5">
                                        Compare
                                    </TabsTrigger>
                                    <TabsTrigger value="indexes" className="text-xs px-2.5">
                                        Indexes
                                        {outcome && indexCount > 0 && <span className="ml-1 text-muted-foreground">{indexCount}</span>}
                                    </TabsTrigger>
                                </TabsList>
                                {m.running && <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Loader2 className="size-3 animate-spin" />{m.stage}…</span>}
                            </div>

                            <div className="flex-1 min-h-0 overflow-y-auto p-2">
                                {outcome ? (
                                    <>
                                        <TabsContent value="result" className="m-0 h-full">
                                            <ResultPanel outcome={outcome} preview={m.preview} previewBlocker={m.previewBlocker} onPreview={m.runPreview} onShowChecks={() => m.setTab("checks")} />
                                        </TabsContent>
                                        <TabsContent value="checks" className="m-0">
                                            <ChecksPanel outcome={outcome} hasTables={hasTables} />
                                        </TabsContent>
                                        <TabsContent value="changes" className="m-0">
                                            <ChangesPanel outcome={outcome} />
                                        </TabsContent>
                                        <TabsContent value="compare" className="m-0">
                                            <CompareView original={outcome.original} converted={outcome.sql} />
                                        </TabsContent>
                                        <TabsContent value="indexes" className="m-0">
                                            <IndexRecommendations advice={outcome.advice} hasTables={hasTables} />
                                        </TabsContent>
                                    </>
                                ) : (
                                    <EmptyState hasExample={!!m.ghostText} />
                                )}
                            </div>
                        </Tabs>
                    </section>
                </div>
            </div>
        </div>
    );
};

const EmptyState: React.FC<{ hasExample: boolean }> = ({ hasExample }) => (
    <div className="flex h-full flex-col justify-center gap-3 p-6 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">What happens when you press Convert</p>
        <ol className="list-decimal space-y-2 pl-5 text-xs leading-relaxed">
            <li>Fixed rules rewrite the old-style parts of the query for PostgreSQL: NVL and DECODE, (+) joins, TOP and ROWNUM, backticks, date functions and so on.</li>
            <li>If you choose a connection, PostgreSQL itself says whether it accepts the result: whether the tables, columns and functions exist and the types fit. Nothing is run.</li>
            <li>Whatever it could not convert, and whatever behaves differently in PostgreSQL, is listed. It is not guessed.</li>
        </ol>
        <p className="text-xs leading-relaxed">It can't prove the new query returns the same rows. Run the old and the new one on the same data and compare.</p>
        <p className="text-xs leading-relaxed">{hasExample ? "Click into the editor and press Tab to see an example written from your own tables." : "Paste a query to start."}</p>
    </div>
);

type Mode = "single" | "script";

// Which view was open when the user went to another page.
let lastMode: Mode = "single";

/** Query Modernizer: one query at a time, or a whole file. */
const QueryModernizerPage: React.FC = () => {
    const [mode, setModeState] = useState<Mode>(lastMode);
    const setMode = useCallback((next: Mode) => {
        lastMode = next;
        setModeState(next);
    }, []);

    return (
        <div className="flex h-full min-h-0 w-full flex-col bg-background">
            <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
                <h1 className="text-base font-semibold">Query Modernizer</h1>
                <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
                    <TabsList className="h-8">
                        <TabsTrigger value="single" className="px-3 text-xs">One query</TabsTrigger>
                        <TabsTrigger value="script" className="px-3 text-xs">A script</TabsTrigger>
                    </TabsList>
                </Tabs>
            </div>
            <div className="min-h-0 flex-1">
                {mode === "single" ? (
                    <SingleQueryView />
                ) : (
                    <ScriptView
                        onOpenSingle={(sql, dialect) => {
                            setQueryHandoff({ sql, dialect });
                            setMode("single");
                        }}
                    />
                )}
            </div>
        </div>
    );
};

export default QueryModernizerPage;
