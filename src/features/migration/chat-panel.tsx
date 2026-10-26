import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AiStatus, fetchAiStatus } from "@/lib/ai-api";
import { countEdits, type MigrationPlanPreview } from "@/lib/migrations-api";
import { cn } from "@/lib/utils";
import type { Migration } from "./use-migration";

/** Things to say that fit this plan, so the first message is a click: only what the plan actually has. */
export function suggestionsFor(plan: MigrationPlanPreview | undefined): string[] {
    if (!plan) return [];
    const columns = plan.tables.flatMap((table) => table.columns);
    const suggestions: string[] = [];
    if (columns.some((column) => column.oracleType.toUpperCase() === "DATE" && column.edited.length === 0)) suggestions.push("Make the DATE columns real dates");
    if (columns.some((column) => column.note.status === "risk")) suggestions.push("Explain the columns that may lose data");
    if (columns.some((column) => /^NUMBER\(1(,0)?\)$/i.test(column.oracleType))) suggestions.push("Make the NUMBER(1) columns booleans");
    suggestions.push("What is not carried over?");
    return suggestions.slice(0, 3);
}

/**
 * The conversation with the assistant that changes the plan. What it did is listed under its answer, and what it was not allowed to do is
 * listed with the reason, so a person never has to take its word for what the plan now says.
 */
export const ChatPanel: React.FC<{ migration: Migration }> = ({ migration }) => {
    const { lines, asking, ask, undoAll, edits, plan, outcome, sourceId } = migration;
    const [text, setText] = useState("");
    const [ai, setAi] = useState<AiStatus | undefined>(undefined);
    const end = useRef<HTMLDivElement>(null);
    const changes = countEdits(edits);
    const suggestions = useMemo(() => suggestionsFor(plan), [plan]);
    const locked = Boolean(outcome);

    useEffect(() => {
        fetchAiStatus().then(setAi).catch(() => setAi(undefined));
    }, []);
    useEffect(() => {
        end.current?.scrollIntoView({ block: "end" });
    }, [lines.length, asking]);

    const send = (message: string) => {
        if (!message.trim() || asking || locked || !sourceId) return;
        setText("");
        void ask(message);
    };
    const unavailable = ai && (!ai.configured || ai.allowed === false) ? (ai.problem ?? "No model is set up on this server.") : undefined;

    return (
        <section className="flex h-full min-h-0 flex-col rounded-lg border bg-card" aria-label="Assistant">
            <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <div className="min-w-0">
                    <h2 className="text-sm font-medium">Assistant</h2>
                    <p className="truncate text-[11px] text-muted-foreground">Ask for a change, or ask why. Nothing runs until you start the migration.</p>
                </div>
                {changes > 0 && !locked && (
                    <Button size="sm" variant="ghost" className="h-7 shrink-0 text-xs" onClick={undoAll} disabled={asking}>
                        Undo all {changes}
                    </Button>
                )}
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm" data-testid="chat-lines">
                {lines.length === 0 && (
                    <div className="space-y-2 text-xs text-muted-foreground">
                        <p>The plan on the left is what GoForge would do. Tell the assistant what you want different: a type, a name, a default. Every change is checked against your Oracle data before it counts.</p>
                        {suggestions.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                                {suggestions.map((suggestion) => (
                                    <button key={suggestion} type="button" className="rounded-full border px-2.5 py-1 text-left text-xs text-foreground hover:bg-muted disabled:opacity-50" onClick={() => send(suggestion)} disabled={asking || locked || !plan}>
                                        {suggestion}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {lines.map((line) => (
                    <div key={line.id} className={cn("flex", line.role === "user" && "justify-end")}>
                        <div className={cn("max-w-[92%] space-y-1.5 rounded-lg px-3 py-2", line.role === "user" ? "bg-primary text-primary-foreground" : line.role === "error" ? "border border-destructive/50 text-destructive" : "bg-muted")}>
                            <p className="whitespace-pre-wrap break-words">{line.text}</p>
                            {line.applied && line.applied.length > 0 && (
                                <div className="text-xs">
                                    <p className="font-medium">Changed</p>
                                    <ul className="list-disc pl-4">{line.applied.map((item) => <li key={item} className="break-words">{item}</li>)}</ul>
                                </div>
                            )}
                            {line.rejected && line.rejected.length > 0 && (
                                <div className="text-xs text-muted-foreground">
                                    <p className="font-medium text-foreground">Not done</p>
                                    <ul className="list-disc pl-4">{line.rejected.map((item) => <li key={item.operation} className="break-words">{item.operation}: {item.reason}</li>)}</ul>
                                </div>
                            )}
                        </div>
                    </div>
                ))}
                {asking && (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                        <Loader2 className="size-3.5 animate-spin" /> Reading the plan and your data…
                    </p>
                )}
                <div ref={end} />
            </div>

            <footer className="space-y-1.5 border-t p-2">
                {unavailable && <p className="px-1 text-[11px] text-amber-700 dark:text-amber-400" role="status">The assistant is not available: {unavailable}</p>}
                {locked && <p className="px-1 text-[11px] text-muted-foreground">The migration has run, so the plan is closed. Start again from a new migration to change it.</p>}
                <div className="flex items-end gap-2">
                    <Textarea
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                send(text);
                            }
                        }}
                        placeholder={locked ? "The plan is closed" : "For example: make CLM_DT a date, and call the table claims"}
                        aria-label="Message to the assistant"
                        className="min-h-[2.5rem] resize-none text-sm"
                        rows={2}
                        disabled={asking || locked || !sourceId}
                        spellCheck
                    />
                    <Button size="icon" className="size-9 shrink-0" onClick={() => send(text)} disabled={asking || locked || !text.trim() || !sourceId} aria-label="Send">
                        <SendHorizontal className="size-4" />
                    </Button>
                </div>
            </footer>
        </section>
    );
};
