import React, { useMemo, useState } from "react";
import { Check, Columns2, Copy, Loader2, Play, Terminal } from "lucide-react";
import { toast } from "sonner";
import CodeEditor from "@/components/code-editor";
import { RowsTable } from "@/components/rows-table";
import { Button } from "@/components/ui/button";
import { useOpenInSqlEditor } from "@/features/sql-editor/use-open-in-sql-editor";
import { cn } from "@/lib/utils";
import { formatRows } from "@/utils/data-view/format-rows";
import type { ModernizeOutcome } from "../modernize";
import { OutputCheck } from "./output-check";
import { LEGACY_DIALECTS } from "../types";
import type { PreviewState } from "../use-modernizer";

type Tone = "pass" | "warn" | "fail";

/** One sentence on where the result stands. It never says "safe" or gives a percentage. */
export function verdict(outcome: ModernizeOutcome): { tone: Tone; title: string; detail: string } {
    const { engine, postgres, syntax } = outcome;
    if (engine.syntaxError) return { tone: "fail", title: "The query could not be read", detail: engine.syntaxError };
    if (postgres.status === "rejected") return { tone: "fail", title: "PostgreSQL rejects the converted query", detail: postgres.statements.find((s) => s.status === "rejected")?.error?.message ?? "See the Checks tab." };
    if (outcome.source === "rules" && engine.unconverted.length > 0) return { tone: "fail", title: `Not fully converted: ${engine.unconverted.length} thing${engine.unconverted.length === 1 ? "" : "s"} left`, detail: "They are marked in the SQL and explained in the Checks tab." };
    if (!syntax.ok && postgres.status !== "accepted") return { tone: "fail", title: "The result is not valid PostgreSQL", detail: syntax.error ?? "" };
    if (outcome.source === "ai") return { tone: "warn", title: "Converted by the model, and PostgreSQL accepts it", detail: "Accepted does not mean it returns the same rows. Compare it with the original on your data." };
    const different = engine.traps.filter((trap) => trap.severity === "changes-results").length;
    if (different > 0) return { tone: "warn", title: `Converted, but ${different} difference${different === 1 ? "" : "s"} can change the results`, detail: "They are explained in the Checks tab." };
    if (postgres.status === "accepted") return { tone: "pass", title: "PostgreSQL accepts the converted query", detail: "Nothing known was left unconverted. It does not prove the same rows come back." };
    return { tone: "pass", title: "Converted and valid PostgreSQL syntax", detail: "Not checked against a database. Choose a connection to have PostgreSQL confirm the tables, columns and functions." };
}

interface ResultPanelProps {
    outcome: ModernizeOutcome;
    preview: PreviewState;
    previewBlocker: string | undefined;
    onPreview: () => void;
    onShowChecks: () => void;
    /** Run the original on Oracle and the conversion on PostgreSQL together, and show the two outputs side by side. */
    onRunBoth: () => void;
    /** Why that cannot run yet; undefined when it can. */
    bothBlocker: string | undefined;
    bothRunning: boolean;
}

export const ResultPanel: React.FC<ResultPanelProps> = ({ outcome, preview, previewBlocker, onPreview, onShowChecks, onRunBoth, bothBlocker, bothRunning }) => {
    const openInSqlEditor = useOpenInSqlEditor();
    const [copied, setCopied] = useState(false);
    const { tone, title, detail } = verdict(outcome);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(outcome.sql);
            setCopied(true);
            toast.success("SQL copied");
            setTimeout(() => setCopied(false), 2000);
        } catch {
            toast.error("Couldn't copy. The browser blocked clipboard access.");
        }
    };

    const formatted = useMemo(() => (preview.status === "done" && preview.response.ok ? formatRows(preview.response.result.columns, preview.response.result.rows, preview.response.result.truncatedCells) : undefined), [preview]);

    return (
        <div className="flex h-full flex-col gap-2">
            <div className={cn("rounded-lg border border-l-2 bg-card px-3 py-2", tone === "pass" && "border-l-emerald-500", tone === "warn" && "border-l-amber-500", tone === "fail" && "border-l-destructive")}>
                <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium text-foreground">{title}</p>
                    <button type="button" onClick={onShowChecks} className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
                        All checks
                    </button>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground break-words">{detail}</p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="outline" onClick={() => openInSqlEditor(outcome.sql, "Modernizer")} className="h-8 gap-1.5 text-xs" title="Open it in the SQL Editor, where you can run it in a transaction">
                    <Terminal className="size-3.5" />
                    Open in SQL Editor
                </Button>
                <Button size="sm" variant="outline" onClick={copy} className="h-8 gap-1.5 text-xs">
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    Copy
                </Button>
                <Button size="sm" variant="outline" onClick={onPreview} disabled={!!previewBlocker || preview.status === "running"} title={previewBlocker ?? "Read the first 100 rows, read-only"} className="h-8 gap-1.5 text-xs">
                    {preview.status === "running" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    Run on PostgreSQL
                </Button>
                <Button size="sm" onClick={onRunBoth} disabled={Boolean(bothBlocker) || bothRunning} title={bothBlocker ?? "Run the original on Oracle and the conversion on PostgreSQL at the same time, and compare what they return"} className="h-8 gap-1.5 text-xs">
                    {bothRunning ? <Loader2 className="size-3.5 animate-spin" /> : <Columns2 className="size-3.5" />}
                    Run both and compare
                </Button>
                {(bothBlocker ?? previewBlocker) && <span className="text-[11px] text-muted-foreground">{bothBlocker ?? previewBlocker}</span>}
            </div>

            <div className={cn("min-h-[160px]", preview.status === "idle" ? "flex-1" : "h-48 shrink-0")}>
                <CodeEditor value={outcome.sql} readOnly={true} className="h-full font-mono text-xs border-0" />
            </div>

            {preview.status === "failed" && <p className="rounded-lg border border-l-2 border-l-destructive bg-card p-3 text-xs text-muted-foreground">{preview.message}</p>}
            {preview.status === "done" && !preview.response.ok && (
                <div className="rounded-lg border border-l-2 border-l-destructive bg-card p-3 text-xs">
                    <p className="font-medium text-foreground">PostgreSQL could not run it</p>
                    <p className="mt-1 text-muted-foreground break-words">{preview.response.error.message}</p>
                </div>
            )}
            {preview.status === "done" && preview.response.ok && formatted && (
                <>
                <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card">
                    <p className="border-b px-3 py-1.5 text-[11px] text-muted-foreground">
                        {preview.response.result.rows.length} row{preview.response.result.rows.length === 1 ? "" : "s"}
                        {preview.response.result.truncated ? " (first 100)" : ""} in {preview.response.elapsedMs} ms. Read-only: nothing was changed.
                    </p>
                    <div className="min-h-0 flex-1 overflow-auto">
                        <RowsTable columns={preview.response.result.columns} rows={formatted} emptyText="The query returned no rows." />
                    </div>
                </div>
                <OutputCheck result={preview.response.result} dialectLabel={LEGACY_DIALECTS.find((candidate) => candidate.value === outcome.dialect)?.label ?? outcome.dialect} />
                </>
            )}
        </div>
    );
};
