import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, History, Loader2, Play, Square, Terminal, Undo2 } from "lucide-react";
import CodeEditor from "@/components/code-editor";
import { RowsTable, RowsTableSkeleton } from "@/components/rows-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useDelayedFlag } from "@/hooks/use-delayed-flag";
import { connectionAddress, connectionLabel } from "@/lib/live-connection-api";
import { cn } from "@/lib/utils";
import { positionToLineColumn } from "./error-position";
import { useSqlEditor, type SqlEditor } from "./use-sql-editor";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const RUN_SHORTCUT = isMac ? "⌘↵" : "Ctrl+↵";

const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

const ResultsPanel: React.FC<{ editor: SqlEditor }> = ({ editor }) => {
    const { view, isRunning, requestError, transaction } = editor;
    const [active, setActive] = useState<number>(0);
    // Show the last result that has rows (usually the one that matters in a script); otherwise the last statement.
    useEffect(() => {
        const results = view?.results ?? [];
        const lastWithRows = results.map((result) => result.columns.length > 0).lastIndexOf(true);
        setActive(lastWithRows >= 0 ? lastWithRows : Math.max(0, results.length - 1));
    }, [view]);

    const showSkeleton = useDelayedFlag(isRunning, 250);

    if (requestError) {
        return (
            <div className="p-3 text-sm text-destructive flex items-start gap-2" role="alert">
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <span className="min-w-0 break-words">{requestError}</span>
            </div>
        );
    }

    if (isRunning && (showSkeleton || !view)) {
        return (
            <div className="h-full overflow-hidden" aria-live="polite">
                <RowsTableSkeleton rowCount={8} />
            </div>
        );
    }

    if (!view) {
        return (
            <div className="h-full flex flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
                <Terminal className="size-8 opacity-40" aria-hidden="true" />
                <p className="text-sm">Run SQL to see the results here.</p>
                <p className="text-xs">
                    {RUN_SHORTCUT} runs everything, or only the text you have selected.
                </p>
            </div>
        );
    }

    const { error, results, formatted, elapsedMs, ranSql } = view;
    const result = results[Math.min(active, results.length - 1)];
    const rows = formatted[Math.min(active, results.length - 1)] ?? [];
    const location = error?.position ? positionToLineColumn(ranSql, error.position) : undefined;

    return (
        <div className="h-full min-h-0 flex flex-col">
            {error && (
                <div className="p-3 border-b bg-destructive/5 text-sm space-y-1" role="alert">
                    <p className="font-medium text-destructive flex items-start gap-2">
                        <AlertCircle className="size-4 shrink-0 mt-0.5" />
                        <span className="min-w-0 break-words">{error.message}</span>
                    </p>
                    {error.detail && <p className="text-muted-foreground pl-6">{error.detail}</p>}
                    {error.hint && <p className="text-muted-foreground pl-6">Hint: {error.hint}</p>}
                    <p className="text-xs text-muted-foreground pl-6 flex flex-wrap items-center gap-x-3">
                        {error.code && <span>SQLSTATE {error.code}</span>}
                        {location && (
                            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => editor.goToError(error.position!, ranSql)}>
                                Line {location.line}, column {location.column}
                            </button>
                        )}
                    </p>
                    {view.transactionLost ? (
                        <p className="text-xs pl-6">The connection dropped, so your open transaction was rolled back.</p>
                    ) : transaction.open && transaction.hasChanges ? (
                        <p className="text-xs text-muted-foreground pl-6">This run was undone. Changes from your earlier runs are still uncommitted.</p>
                    ) : null}
                </div>
            )}

            {results.length > 0 && (
                <>
                    <div className="flex items-center gap-1 px-2 py-1.5 border-b overflow-x-auto shrink-0">
                        {results.map((item, index) => (
                            <Button key={index} size="sm" variant={index === active ? "secondary" : "ghost"} className="h-7 px-2 text-xs shrink-0" onClick={() => setActive(index)}>
                                {results.length > 1 && <span className="text-muted-foreground">{index + 1}</span>}
                                {item.command || "OK"}
                                {item.columns.length > 0 && <span className="text-muted-foreground">{plural(item.rows.length, "row")}</span>}
                            </Button>
                        ))}
                        <span className="ml-auto pl-2 text-xs text-muted-foreground shrink-0">
                            {plural(results.length, "statement")} · {elapsedMs.toLocaleString()} ms
                        </span>
                    </div>

                    {result.columns.length > 0 ? (
                        <div className="flex-1 min-h-0 overflow-auto">
                            <RowsTable columns={result.columns} rows={rows} emptyText="No rows returned." />
                            {result.truncated && <p className="px-3 py-2 text-xs text-muted-foreground">Showing the first {result.rows.length.toLocaleString()} rows.</p>}
                        </div>
                    ) : (
                        <div className="p-4 text-sm flex items-center gap-2">
                            <Check className="size-4 text-muted-foreground" aria-hidden="true" />
                            <span className="font-medium">{result.command || "OK"}</span>
                            {result.rowCount !== null && <span className="text-muted-foreground">{plural(result.rowCount, "row")} affected</span>}
                        </div>
                    )}
                </>
            )}

            {!error && results.length === 0 && <p className="p-4 text-sm text-muted-foreground">Done. The statements returned nothing to show.</p>}
        </div>
    );
};

const HistoryMenu: React.FC<{ editor: SqlEditor }> = ({ editor }) => {
    const [open, setOpen] = useState(false);
    const { history } = editor;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={history.length === 0} aria-label="Run history">
                    <History className="size-3.5" />
                    <span className="hidden sm:inline">History</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(440px,calc(100vw-2rem))] p-0">
                <div className="flex items-center justify-between px-3 py-2 border-b">
                    <span className="text-sm font-medium">Recent runs</span>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={editor.clearHistory}>
                        Clear
                    </Button>
                </div>
                <ul className="max-h-80 overflow-y-auto">
                    {history.map((entry) => (
                        <li key={entry.id}>
                            <button
                                type="button"
                                className="w-full text-left px-3 py-2 hover:bg-accent border-b last:border-0"
                                onClick={() => {
                                    editor.loadFromHistory(entry);
                                    setOpen(false);
                                }}
                            >
                                <code className="block text-xs truncate">{entry.sql.trim().split("\n")[0]}</code>
                                <span className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                                    <span className={cn("size-1.5 rounded-full", entry.ok ? "bg-emerald-500" : "bg-destructive")} aria-hidden="true" />
                                    {entry.ok ? "Succeeded" : "Failed"} · {entry.ms.toLocaleString()} ms · {new Date(entry.at).toLocaleString()}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            </PopoverContent>
        </Popover>
    );
};

/**
 * SQL editor for a saved Postgres connection. Runs happen inside a transaction that stays open until you commit or
 * roll back, so you can look at what a change did before it becomes permanent.
 */
const SqlEditorPage: React.FC = () => {
    const editor = useSqlEditor();
    const { transaction } = editor;

    const noConnections = !editor.isLoadingConnections && editor.connections.length === 0;
    const transactionLabel = useMemo(() => {
        if (!transaction.open) return undefined;
        const minutes = editor.minutesOpen;
        const age = minutes < 1 ? "just now" : `${minutes} min`;
        return transaction.hasChanges ? `Uncommitted changes · open ${age}` : `Transaction open · ${age}`;
    }, [transaction.open, transaction.hasChanges, editor.minutesOpen]);

    return (
        <div className="w-full h-full min-h-0 flex flex-col bg-background">
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b shrink-0">
                <Select value={editor.connectionId} onValueChange={editor.selectConnection} disabled={transaction.hasChanges}>
                    <SelectTrigger size="sm" className="h-8 w-56 max-w-full" aria-label="Connection" title={transaction.hasChanges ? "Commit or roll back before switching connection" : undefined}>
                        <SelectValue placeholder={noConnections ? "No saved connections" : "Pick a connection"} />
                    </SelectTrigger>
                    <SelectContent>
                        {editor.connections.map((connection) => (
                            <SelectItem key={connection.id} value={connection.id} title={connectionAddress(connection)}>
                                {connectionLabel(connection, editor.connections)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                <Button size="sm" className="h-8 gap-1.5" onClick={() => editor.run()} disabled={!editor.connectionId || editor.isRunning || !editor.sql.trim()}>
                    {editor.isRunning ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    Run
                    <kbd className="hidden sm:inline text-[10px] opacity-70 font-sans">{RUN_SHORTCUT}</kbd>
                </Button>
                {editor.isRunning && (
                    <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={editor.cancel}>
                        <Square className="size-3.5" /> Stop
                    </Button>
                )}

                <label
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                    title="Changes stay uncommitted until you press Commit. Turn this off for statements Postgres can't run in a transaction, such as CREATE INDEX CONCURRENTLY."
                >
                    <Switch checked={editor.transactional} onCheckedChange={editor.setTransactional} disabled={transaction.open} aria-label="Run in a transaction" />
                    Transaction
                </label>

                <div className="ml-auto flex flex-wrap items-center gap-2">
                    {transactionLabel && (
                        <Badge variant="outline" className={cn("font-normal", transaction.hasChanges && "border-amber-500/50 text-amber-600 dark:text-amber-400")}>
                            {transactionLabel}
                        </Badge>
                    )}
                    {transaction.open && (
                        <>
                            <Button size="sm" className="h-8 gap-1.5" onClick={editor.commit} disabled={editor.isFinishing || editor.isRunning}>
                                <Check className="size-3.5" /> Commit
                            </Button>
                            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={editor.rollback} disabled={editor.isFinishing || editor.isRunning}>
                                <Undo2 className="size-3.5" /> Roll back
                            </Button>
                        </>
                    )}
                    <HistoryMenu editor={editor} />
                </div>
            </div>

            {transaction.hasChanges && (
                <p className="px-3 py-1.5 text-xs text-muted-foreground border-b bg-muted/40 shrink-0">
                    These changes are only visible in this editor until you commit. Schema changes lock tables for everyone else until then, and the transaction rolls back by itself after 5 minutes of inactivity.
                </p>
            )}

            {noConnections ? (
                <div className="flex-1 flex items-center justify-center p-6 text-sm text-muted-foreground text-center">No saved connections yet. Add one from File &gt; Connect Live Database.</div>
            ) : (
                <ResizablePanelGroup direction="vertical" autoSaveId="goforge-sql-editor" className="flex-1 min-h-0">
                    <ResizablePanel id="sql-editor-input" order={1} defaultSize={45} minSize={15}>
                        <div className="h-full p-1">
                            <CodeEditor
                                value={editor.sql}
                                onChange={editor.setSql}
                                onRun={(selection) => void editor.run(selection)}
                                onCreateEditor={(view) => {
                                    editor.editorView.current = view;
                                }}
                                className="h-full font-mono text-xs"
                            />
                        </div>
                    </ResizablePanel>
                    <ResizableHandle withHandle className="hover:bg-primary/50 active:bg-primary/50 transition-colors" />
                    <ResizablePanel id="sql-editor-results" order={2} defaultSize={55} minSize={15}>
                        <div className="h-full min-h-0 overflow-auto bg-card">
                            <ResultsPanel editor={editor} />
                        </div>
                    </ResizablePanel>
                </ResizablePanelGroup>
            )}
        </div>
    );
};

export default SqlEditorPage;
