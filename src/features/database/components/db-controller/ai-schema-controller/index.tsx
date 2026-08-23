import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compare } from "fast-json-patch";
import {
    AlertTriangle,
    Check,
    Clock3,
    Code2,
    Loader2,
    Pencil,
    RefreshCw,
    Send,
    ShieldCheck,
    Sparkles,
    Trash2,
    X,
} from "lucide-react";
import { toast } from "sonner";

import Clipboard from "@/components/clipboard";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { buildAiDiagramPreview } from "@/lib/ai-diagram-preview";
import { requestAiSchemaPlan } from "@/lib/ai-api";
import {
    AiSchemaOperation,
    AiSchemaPlanResponse,
    applyAiSchemaPlan,
    buildAiSchemaContext,
    describeAiOperation,
    isDestructiveAiOperation,
    validateAiPlanScope,
} from "@/lib/ai-schema";
import {
    AiPromptHistoryEntry,
    addAiPromptHistory,
    clearAiPromptHistory,
    loadAiPromptHistory,
    updateAiPromptHistoryStatus,
} from "@/lib/ai-prompt-history";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { useDiagram } from "@/providers/diagram-provider/diagram-provider";
import { useDatabaseHistory } from "@/providers/database-history/database-history-provider";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { DBDiffOperation, mapDiffToDBDiffOperation, normalizeDatabase } from "@/utils/database";
import { getRenderer } from "@/utils/render/render-uttils";

interface AiPreview {
    response: AiSchemaPlanResponse;
    operations: DBDiffOperation[];
    sql: string;
    compilerWarnings: string[];
    historyId: string;
    targetDatabase: DatabaseType;
}

type PromptScope = "database" | "selected_tables";

const EXAMPLE_PROMPTS = [
    "Create a multi-tenant SaaS schema with users, organizations, subscriptions, and audit logs.",
    "Add soft deletion to every business table.",
    "Change orders to support multiple shipping addresses.",
    "Review this schema and suggest missing indexes.",
];

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const operationKind = (operation: AiSchemaOperation): "Added" | "Edited" | "Deleted" => {
    if (isDestructiveAiOperation(operation)) return "Deleted";
    if (["create_table", "add_column", "add_relationship", "add_index"].includes(operation.type)) return "Added";
    return "Edited";
};

const AiSchemaController: React.FC = () => {
    const { database } = useDatabase();
    const { data_types } = useDatabaseOperations();
    const { applyUndoableOperations } = useDatabaseHistory();
    const { setAiPreview } = useDiagram();
    const promptRef = useRef<HTMLTextAreaElement>(null);
    const [prompt, setPrompt] = useState("");
    const [scope, setScope] = useState<PromptScope>("database");
    const [selectedTableIds, setSelectedTableIds] = useState<string[]>([]);
    const [preview, setPreview] = useState<AiPreview>();
    const [history, setHistory] = useState<AiPromptHistoryEntry[]>([]);
    const [error, setError] = useState<string>();
    const [isGenerating, setIsGenerating] = useState(false);
    const [isApplying, setIsApplying] = useState(false);
    const [destructiveAccepted, setDestructiveAccepted] = useState(false);

    const clarifyingQuestions = preview?.response.plan.clarifyingQuestions ?? [];
    const hasClarifications = clarifyingQuestions.length > 0;
    const hasDestructiveChanges = useMemo(
        () => preview?.response.plan.operations.some(isDestructiveAiOperation) ?? false,
        [preview],
    );
    const selectedTableNames = useMemo(
        () => database?.tables
            .filter((table) => selectedTableIds.includes(table.id))
            .map((table) => table.name) ?? [],
        [database, selectedTableIds],
    );

    const refreshHistory = useCallback(() => {
        setHistory(database ? loadAiPromptHistory(database.id) : []);
    }, [database]);

    const clearPreview = useCallback(() => {
        setPreview(undefined);
        setAiPreview(undefined);
        setDestructiveAccepted(false);
        setError(undefined);
    }, [setAiPreview]);

    useEffect(() => {
        clearPreview();
        setSelectedTableIds([]);
        setScope("database");
        refreshHistory();
    }, [database?.id]);

    useEffect(() => () => setAiPreview(undefined), [setAiPreview]);

    const generate = useCallback(async () => {
        if (!database || !prompt.trim() || data_types.length === 0) return;
        if (scope === "selected_tables" && selectedTableNames.length === 0) {
            setError("Select at least one table for Selected tables scope.");
            return;
        }

        setIsGenerating(true);
        setError(undefined);
        setPreview(undefined);
        setAiPreview(undefined);
        setDestructiveAccepted(false);

        try {
            const scopedTables = scope === "selected_tables" ? selectedTableNames : [];
            const response = await requestAiSchemaPlan(
                buildAiSchemaContext(prompt.trim(), database, data_types, scopedTables),
            );
            const questions = response.plan.clarifyingQuestions ?? [];
            let operations: DBDiffOperation[] = [];
            let sql = "-- Answer the clarification questions before a migration is generated.";
            let compilerWarnings: string[] = [];
            let targetDatabase = database;

            if (questions.length === 0) {
                validateAiPlanScope(response.plan, scopedTables);
                const compiled = applyAiSchemaPlan(database, response.plan, data_types);
                const differences = compare(normalizeDatabase(database), normalizeDatabase(compiled.database));
                operations = mapDiffToDBDiffOperation(differences);
                compilerWarnings = compiled.warnings;
                targetDatabase = compiled.database;
                sql = differences.length === 0
                    ? "-- The proposed plan does not change the current schema."
                    : await getRenderer(database.dialect, data_types).renderDiffDDL(compiled.database, database);

                if (operations.length > 0) {
                    setAiPreview(buildAiDiagramPreview(database, compiled.database, operations));
                }
            }

            const savedHistory = addAiPromptHistory({
                databaseId: database.id,
                prompt: prompt.trim(),
                scope,
                selectedTables: scopedTables,
                status: questions.length > 0 ? "clarification" : "generated",
                summary: response.plan.summary,
            });
            setPreview({ response, operations, sql, compilerWarnings, historyId: savedHistory.id, targetDatabase });
            refreshHistory();
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            setIsGenerating(false);
        }
    }, [data_types, database, prompt, refreshHistory, scope, selectedTableNames, setAiPreview]);

    const apply = useCallback(async () => {
        if (!preview || preview.operations.length === 0) return;
        setIsApplying(true);
        setError(undefined);
        try {
            await applyUndoableOperations(preview.operations, preview.targetDatabase);
            updateAiPromptHistoryStatus(preview.historyId, "applied");
            toast.success("AI schema changes applied", {
                description: `${preview.operations.length} operation(s) completed as one undoable transaction.`,
            });
            setPrompt("");
            clearPreview();
            refreshHistory();
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            setIsApplying(false);
        }
    }, [applyUndoableOperations, clearPreview, preview, refreshHistory]);

    const reject = useCallback(() => {
        if (preview) updateAiPromptHistoryStatus(preview.historyId, "rejected");
        clearPreview();
        refreshHistory();
    }, [clearPreview, preview, refreshHistory]);

    const editPrompt = useCallback(() => {
        clearPreview();
        requestAnimationFrame(() => promptRef.current?.focus());
    }, [clearPreview]);

    const answerQuestions = useCallback(() => {
        const answerTemplate = clarifyingQuestions
            .map((question) => `- ${question}\n  Answer: `)
            .join("\n");
        setPrompt((current) => `${current.trim()}\n\nClarifications:\n${answerTemplate}`);
        clearPreview();
        requestAnimationFrame(() => promptRef.current?.focus());
    }, [clarifyingQuestions, clearPreview]);

    const restoreHistory = useCallback((entry: AiPromptHistoryEntry) => {
        clearPreview();
        setPrompt(entry.prompt);
        setScope(entry.scope);
        setSelectedTableIds(
            database?.tables.filter((table) => entry.selectedTables.includes(table.name)).map((table) => table.id) ?? [],
        );
        requestAnimationFrame(() => promptRef.current?.focus());
    }, [clearPreview, database]);

    const onPromptChange = useCallback((value: string) => {
        if (preview) clearPreview();
        setPrompt(value);
    }, [clearPreview, preview]);

    return (
        <div className="flex h-full min-h-0 w-full flex-col">
            <div className="flex h-14 shrink-0 items-center gap-2 px-3">
                <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Sparkles className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold">AI Schema</h2>
                    <p className="truncate text-xs text-muted-foreground">Design and update with prompts</p>
                </div>
                <Badge variant="secondary" className="text-[10px]">Beta</Badge>
            </div>
            <Separator />

            <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-4 p-3">
                    <div className="space-y-2">
                        <label htmlFor="ai-schema-prompt" className="text-sm font-medium">Describe your schema change</label>
                        <Textarea
                            ref={promptRef}
                            id="ai-schema-prompt"
                            value={prompt}
                            onChange={(event) => onPromptChange(event.target.value)}
                            onKeyDown={(event) => {
                                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void generate();
                            }}
                            placeholder="Create projects and tasks with owners, statuses, due dates, and audit timestamps."
                            className="min-h-32 resize-y bg-secondary dark:bg-background"
                            disabled={isGenerating || isApplying}
                        />

                        <div className="space-y-2 rounded-md border bg-background p-2.5">
                            <p className="text-xs font-medium">Prompt scope</p>
                            <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
                                <Button
                                    type="button"
                                    size="sm"
                                    variant={scope === "database" ? "default" : "ghost"}
                                    className="h-7 text-xs"
                                    onClick={() => setScope("database")}
                                >
                                    Whole database
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant={scope === "selected_tables" ? "default" : "ghost"}
                                    className="h-7 text-xs"
                                    onClick={() => setScope("selected_tables")}
                                    disabled={!database?.tables.length}
                                >
                                    Selected tables
                                </Button>
                            </div>
                            {scope === "selected_tables" && (
                                <div className="max-h-32 space-y-1 overflow-auto pt-1">
                                    {database?.tables.map((table) => (
                                        <label key={table.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted">
                                            <input
                                                type="checkbox"
                                                className="size-3.5 accent-primary"
                                                checked={selectedTableIds.includes(table.id)}
                                                onChange={(event) => setSelectedTableIds((current) => event.target.checked
                                                    ? [...current, table.id]
                                                    : current.filter((id) => id !== table.id))}
                                            />
                                            <span className="truncate">{table.name}</span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="space-y-1.5">
                            {EXAMPLE_PROMPTS.map((example) => (
                                <button
                                    key={example}
                                    type="button"
                                    className="block w-full rounded-md border bg-background px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                                    onClick={() => onPromptChange(example)}
                                >
                                    {example}
                                </button>
                            ))}
                        </div>
                        <Button
                            className="h-9 w-full gap-2"
                            onClick={() => void generate()}
                            disabled={!prompt.trim() || isGenerating || isApplying || !database || data_types.length === 0 || (scope === "selected_tables" && selectedTableIds.length === 0)}
                        >
                            {isGenerating ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                            {isGenerating ? "Designing changes…" : preview ? "Regenerate plan" : "Generate plan"}
                        </Button>
                        <p className="text-center text-[11px] text-muted-foreground">Ctrl/⌘ + Enter to generate</p>
                    </div>

                    <details className="group rounded-md border bg-background">
                        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium">
                            <Clock3 className="size-3.5" /> Prompt history
                            <Badge variant="secondary" className="ml-auto text-[9px]">{history.length}</Badge>
                        </summary>
                        <div className="space-y-1.5 border-t p-2">
                            {history.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No local prompt history yet.</p>}
                            {history.slice(0, 10).map((entry) => (
                                <button
                                    key={entry.id}
                                    type="button"
                                    className="w-full rounded-md border p-2 text-left hover:bg-muted"
                                    onClick={() => restoreHistory(entry)}
                                >
                                    <span className="flex items-center gap-1.5">
                                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{entry.prompt}</span>
                                        <Badge variant="outline" className="text-[9px] capitalize">{entry.status}</Badge>
                                    </span>
                                    <span className="mt-1 block text-[10px] text-muted-foreground">
                                        {entry.scope === "database" ? "Whole database" : entry.selectedTables.join(", ")}
                                    </span>
                                </button>
                            ))}
                            {history.length > 0 && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-full gap-1.5 text-xs text-muted-foreground"
                                    onClick={() => {
                                        if (!database) return;
                                        clearAiPromptHistory(database.id);
                                        refreshHistory();
                                    }}
                                >
                                    <Trash2 className="size-3.5" /> Clear history
                                </Button>
                            )}
                        </div>
                    </details>

                    <Alert className="border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                        <ShieldCheck className="text-amber-600" />
                        <AlertTitle className="text-xs">Schema metadata only</AlertTitle>
                        <AlertDescription className="text-xs">
                            Sends definitions—not rows or credentials. The contributor-free model may use prompts and completions for training.
                        </AlertDescription>
                    </Alert>

                    {error && (
                        <Alert variant="destructive" className="px-3 py-2.5">
                            <AlertTriangle />
                            <AlertTitle className="text-xs">Could not prepare this change</AlertTitle>
                            <AlertDescription className="break-words text-xs">{error}</AlertDescription>
                        </Alert>
                    )}

                    {preview && (
                        <div className="space-y-4">
                            <Separator />
                            <div className="space-y-1.5">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h3 className="text-sm font-semibold">Proposed plan</h3>
                                    <Badge variant="secondary">{preview.response.plan.operations.length} changes</Badge>
                                    {scope === "selected_tables" && <Badge variant="outline">{selectedTableNames.length} selected</Badge>}
                                </div>
                                <p className="text-xs leading-5 text-muted-foreground">{preview.response.plan.summary}</p>
                                <p className="truncate text-[10px] text-muted-foreground">Model: {preview.response.model}</p>
                            </div>

                            {hasClarifications && (
                                <Alert className="border-blue-500/40 bg-blue-500/5 px-3 py-2.5">
                                    <AlertTriangle className="text-blue-600" />
                                    <AlertTitle className="text-xs">A few details are needed</AlertTitle>
                                    <AlertDescription className="text-xs">
                                        <ol className="list-decimal space-y-1 pl-4">
                                            {clarifyingQuestions.map((question) => <li key={question}>{question}</li>)}
                                        </ol>
                                        <Button size="sm" className="mt-2 h-7 gap-1.5" onClick={answerQuestions}>
                                            <Pencil className="size-3.5" /> Answer questions
                                        </Button>
                                    </AlertDescription>
                                </Alert>
                            )}

                            {!hasClarifications && (
                                <ol className="space-y-1.5">
                                    {preview.response.plan.operations.map((operation, index) => {
                                        const kind = operationKind(operation);
                                        return (
                                            <li key={`${operation.type}-${index}`} className="flex items-start gap-2 rounded-md border bg-background p-2.5 text-xs">
                                                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{index + 1}</span>
                                                <span className="min-w-0 flex-1 leading-5">{describeAiOperation(operation)}</span>
                                                <Badge
                                                    variant={kind === "Deleted" ? "destructive" : "outline"}
                                                    className={kind === "Added" ? "border-emerald-500/50 text-emerald-600" : kind === "Edited" ? "border-amber-500/50 text-amber-600" : ""}
                                                >
                                                    {kind}
                                                </Badge>
                                            </li>
                                        );
                                    })}
                                </ol>
                            )}

                            {(preview.response.plan.assumptions.length > 0 || preview.compilerWarnings.length > 0) && (
                                <Alert className="px-3 py-2.5">
                                    <AlertTriangle />
                                    <AlertTitle className="text-xs">Review notes</AlertTitle>
                                    <AlertDescription className="text-xs">
                                        <ul className="list-disc space-y-1 pl-4">
                                            {preview.response.plan.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
                                            {preview.compilerWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                                        </ul>
                                    </AlertDescription>
                                </Alert>
                            )}

                            {!hasClarifications && (
                                <div className="overflow-hidden rounded-md border bg-background">
                                    <div className="flex items-center gap-2 border-b bg-muted/50 px-2.5 py-2 text-xs font-medium">
                                        <Code2 className="size-3.5" /> Migration preview
                                        <span className="ml-auto"><Clipboard text={preview.sql} /></span>
                                    </div>
                                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap p-2.5 font-mono text-[11px] leading-5">{preview.sql}</pre>
                                </div>
                            )}

                            {hasDestructiveChanges && (
                                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs">
                                    <input
                                        type="checkbox"
                                        className="mt-0.5 size-4 accent-destructive"
                                        checked={destructiveAccepted}
                                        onChange={(event) => setDestructiveAccepted(event.target.checked)}
                                    />
                                    <span>
                                        <strong className="block">I reviewed the destructive changes</strong>
                                        Red objects on the diagram will be removed and may delete local data.
                                    </span>
                                </label>
                            )}

                            <div className="grid grid-cols-2 gap-2 pb-2">
                                <Button variant="outline" size="sm" className="gap-1.5" onClick={reject} disabled={isGenerating || isApplying}>
                                    <X className="size-3.5" /> Reject
                                </Button>
                                <Button variant="outline" size="sm" className="gap-1.5" onClick={editPrompt} disabled={isGenerating || isApplying}>
                                    <Pencil className="size-3.5" /> Edit prompt
                                </Button>
                                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void generate()} disabled={isGenerating || isApplying}>
                                    <RefreshCw className="size-3.5" /> Regenerate
                                </Button>
                                <Button
                                    size="sm"
                                    className="gap-1.5"
                                    variant={hasDestructiveChanges ? "destructive" : "default"}
                                    onClick={() => void apply()}
                                    disabled={isApplying || hasClarifications || preview.operations.length === 0 || (hasDestructiveChanges && !destructiveAccepted)}
                                >
                                    {isApplying ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                                    {isApplying ? "Applying…" : `Apply ${preview.operations.length}`}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
};

export default AiSchemaController;
