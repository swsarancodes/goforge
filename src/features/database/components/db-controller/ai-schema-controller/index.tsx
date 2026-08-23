import { useCallback, useMemo, useState } from "react";
import { compare } from "fast-json-patch";
import {
    AlertTriangle,
    Check,
    Code2,
    Loader2,
    RefreshCw,
    Send,
    ShieldCheck,
    Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { requestAiSchemaPlan } from "@/lib/ai-api";
import {
    AiSchemaPlanResponse,
    applyAiSchemaPlan,
    buildAiSchemaContext,
    describeAiOperation,
    isDestructiveAiOperation,
} from "@/lib/ai-schema";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { DBDiffOperation, mapDiffToDBDiffOperation, normalizeDatabase } from "@/utils/database";
import { getRenderer } from "@/utils/render/render-uttils";

interface AiPreview {
    response: AiSchemaPlanResponse;
    operations: DBDiffOperation[];
    sql: string;
    compilerWarnings: string[];
}

const EXAMPLE_PROMPTS = [
    "Add customers and orders with primary keys, timestamps, and a foreign key.",
    "Add a unique email column to users and index created_at.",
    "Rename accounts to organizations without changing its columns.",
];

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const AiSchemaController: React.FC = () => {
    const { database } = useDatabase();
    const { data_types, executeDbDiffOps } = useDatabaseOperations();
    const [prompt, setPrompt] = useState("");
    const [preview, setPreview] = useState<AiPreview>();
    const [error, setError] = useState<string>();
    const [isGenerating, setIsGenerating] = useState(false);
    const [isApplying, setIsApplying] = useState(false);
    const [destructiveAccepted, setDestructiveAccepted] = useState(false);

    const hasDestructiveChanges = useMemo(
        () => preview?.response.plan.operations.some(isDestructiveAiOperation) ?? false,
        [preview],
    );

    const generate = useCallback(async () => {
        if (!database || !prompt.trim() || data_types.length === 0) return;
        setIsGenerating(true);
        setError(undefined);
        setPreview(undefined);
        setDestructiveAccepted(false);

        try {
            const response = await requestAiSchemaPlan(
                buildAiSchemaContext(prompt.trim(), database, data_types),
            );
            const compiled = applyAiSchemaPlan(database, response.plan, data_types);
            const differences = compare(normalizeDatabase(database), normalizeDatabase(compiled.database));
            const operations = mapDiffToDBDiffOperation(differences);
            const sql = differences.length === 0
                ? "-- The proposed plan does not change the current schema."
                : await getRenderer(database.dialect, data_types).renderDiffDDL(compiled.database, database);

            setPreview({ response, operations, sql, compilerWarnings: compiled.warnings });
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            setIsGenerating(false);
        }
    }, [data_types, database, prompt]);

    const apply = useCallback(async () => {
        if (!preview || preview.operations.length === 0) return;
        setIsApplying(true);
        setError(undefined);
        try {
            await executeDbDiffOps(preview.operations);
            toast.success("AI schema changes applied", {
                description: `${preview.operations.length} database operation(s) completed in one transaction.`,
            });
            setPreview(undefined);
            setPrompt("");
            setDestructiveAccepted(false);
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            setIsApplying(false);
        }
    }, [executeDbDiffOps, preview]);

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
                            id="ai-schema-prompt"
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            onKeyDown={(event) => {
                                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void generate();
                            }}
                            placeholder="Add projects and tasks. Each task belongs to a project and has a status and due date."
                            className="min-h-32 resize-y bg-secondary dark:bg-background"
                            disabled={isGenerating || isApplying}
                        />
                        <div className="space-y-1.5">
                            {EXAMPLE_PROMPTS.map((example) => (
                                <button
                                    key={example}
                                    type="button"
                                    className="block w-full rounded-md border bg-background px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                                    onClick={() => setPrompt(example)}
                                >
                                    {example}
                                </button>
                            ))}
                        </div>
                        <Button
                            className="h-9 w-full gap-2"
                            onClick={() => void generate()}
                            disabled={!prompt.trim() || isGenerating || isApplying || !database || data_types.length === 0}
                        >
                            {isGenerating ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                            {isGenerating ? "Designing changes…" : preview ? "Regenerate plan" : "Generate plan"}
                        </Button>
                        <p className="text-center text-[11px] text-muted-foreground">Ctrl/⌘ + Enter to generate</p>
                    </div>

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
                                </div>
                                <p className="text-xs leading-5 text-muted-foreground">{preview.response.plan.summary}</p>
                                <p className="truncate text-[10px] text-muted-foreground">Model: {preview.response.model}</p>
                            </div>

                            <ol className="space-y-1.5">
                                {preview.response.plan.operations.map((operation, index) => {
                                    const destructive = isDestructiveAiOperation(operation);
                                    return (
                                        <li key={`${operation.type}-${index}`} className="flex items-start gap-2 rounded-md border bg-background p-2.5 text-xs">
                                            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">
                                                {index + 1}
                                            </span>
                                            <span className="min-w-0 flex-1 leading-5">{describeAiOperation(operation)}</span>
                                            {destructive && <Badge variant="destructive" className="text-[10px]">Destructive</Badge>}
                                        </li>
                                    );
                                })}
                            </ol>

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

                            <div className="overflow-hidden rounded-md border bg-background">
                                <div className="flex items-center gap-2 border-b bg-muted/50 px-2.5 py-2 text-xs font-medium">
                                    <Code2 className="size-3.5" /> Migration preview
                                </div>
                                <pre className="max-h-64 overflow-auto whitespace-pre-wrap p-2.5 font-mono text-[11px] leading-5">{preview.sql}</pre>
                            </div>

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
                                        Dropped schema objects may remove local data.
                                    </span>
                                </label>
                            )}

                            <div className="flex gap-2 pb-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="gap-1.5"
                                    onClick={() => void generate()}
                                    disabled={isGenerating || isApplying}
                                >
                                    <RefreshCw className="size-3.5" /> Regenerate
                                </Button>
                                <Button
                                    size="sm"
                                    className="flex-1 gap-1.5"
                                    variant={hasDestructiveChanges ? "destructive" : "default"}
                                    onClick={() => void apply()}
                                    disabled={isApplying || preview.operations.length === 0 || (hasDestructiveChanges && !destructiveAccepted)}
                                >
                                    {isApplying ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                                    {isApplying ? "Applying…" : `Apply ${preview.operations.length} operation(s)`}
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
