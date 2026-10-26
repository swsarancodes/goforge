import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReviewFinding } from "@/lib/migrations-api";
import { cn } from "@/lib/utils";
import { ASSISTANT_NAME } from "./assistant";
import type { Migration } from "./use-migration";

/** What the plan reviewer is called: a separate agent from the assistant that changes the plan. */
export const REVIEWER_NAME = "CosmicCheck";

const SEVERITY: Record<ReviewFinding["severity"], { label: string; className: string }> = {
    concern: { label: "Concern", className: "border-destructive/50 text-destructive" },
    warning: { label: "Worth reading", className: "border-amber-500/50 text-amber-700 dark:text-amber-400" },
    note: { label: "Note", className: "text-muted-foreground" },
};

const where = (finding: ReviewFinding): string | null => (finding.table === null ? null : finding.column === null ? finding.table : `${finding.table}.${finding.column}`);

/**
 * An optional second opinion on the plan, from a reviewer that is not the assistant: it reads the report and the changes made, and says what looks
 * wrong or risky. It changes nothing and is not part of what is approved; the person may approve without it. A suggestion can be handed to the
 * assistant, which is the only one that changes the plan, and whose changes are checked by the server like any other.
 */
export const ReviewPanel: React.FC<{ migration: Migration }> = ({ migration }) => {
    const { review, reviewIsCurrent, reviewing, reviewError, runReview, ask, asking, loadingReport, outcome } = migration;
    const [focus, setFocus] = useState("");
    if (outcome) return null;

    return (
        <section className="min-w-0 space-y-2 rounded-lg border bg-card p-3 text-xs" aria-label="Second opinion on the plan" data-testid="plan-review">
            <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-medium">Second opinion</h2>
                <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">optional</span>
            </div>
            <p className="text-muted-foreground">
                {REVIEWER_NAME}, a separate AI reviewer and not {ASSISTANT_NAME}, reads the plan and the changes you made and says what looks wrong or risky: foreign keys whose types no longer agree, changes that can lose data, objects left behind that matter. It cannot change anything and it is not part of what you approve. You can approve without it.
            </p>
            <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    void runReview(focus);
                }}
            >
                <Input value={focus} onChange={(event) => setFocus(event.target.value)} maxLength={500} placeholder="Anything you want it to look at? (optional)" aria-label="What the reviewer should look at" className="h-8 min-w-48 flex-1 text-xs" disabled={reviewing} />
                <Button type="submit" size="sm" variant="outline" className="h-8 text-xs" disabled={reviewing || loadingReport}>
                    {reviewing ? <Loader2 className="size-3 animate-spin" /> : null} {review ? "Review the plan again" : "Review the plan"}
                </Button>
            </form>
            {reviewError && <p role="alert" className="text-destructive">{reviewError}</p>}

            {review && (
                <div className={cn("space-y-2 rounded-md border border-dashed p-2", !reviewIsCurrent && "opacity-60")} data-testid="ai-review">
                    <p className="flex flex-wrap items-center gap-1.5 font-medium">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">AI review</span>
                        <span className="font-normal text-muted-foreground">by {review.model} ({REVIEWER_NAME}){review.focus ? `, asked to look at: ${review.focus}` : ""}</span>
                    </p>
                    {!reviewIsCurrent && <p role="status" className="font-medium text-amber-700 dark:text-amber-400">The plan has changed since this review. Review it again to get an opinion on the plan as it is now.</p>}
                    <p className="whitespace-pre-wrap">{review.result.overview}</p>
                    {review.result.findings.length === 0 ? (
                        <p className="text-muted-foreground">It reported nothing specific. That is not a guarantee: it reads the report, not your data or your queries.</p>
                    ) : (
                        <ul className="space-y-1.5">
                            {review.result.findings.map((finding, index) => (
                                <li key={`${index}-${finding.title}`} className="space-y-0.5 rounded border p-1.5">
                                    <p className="flex flex-wrap items-center gap-1.5">
                                        <span className={cn("rounded border px-1 py-0.5 text-[10px] font-medium", SEVERITY[finding.severity].className)}>{SEVERITY[finding.severity].label}</span>
                                        {where(finding) && <span className="font-mono">{where(finding)}</span>}
                                        <span className="font-medium">{finding.title}</span>
                                    </p>
                                    <p className="text-muted-foreground">{finding.detail}</p>
                                    {finding.suggestion && (
                                        <p className="flex flex-wrap items-center gap-1.5">
                                            <span>Suggestion: {finding.suggestion}</span>
                                            {reviewIsCurrent && (
                                                <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={asking} onClick={() => void ask(finding.suggestion!)}>
                                                    Ask {ASSISTANT_NAME} to do this
                                                </Button>
                                            )}
                                        </p>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {review.result.dropped > 0 && <p className="text-[11px] text-muted-foreground">{review.result.dropped} finding{review.result.dropped === 1 ? " was" : "s were"} left out because {review.result.dropped === 1 ? "it named" : "they named"} a table or column that is not in the plan.</p>}
                    <p className="text-[11px] text-muted-foreground">This is commentary from a second AI. It is not proof, it is not part of the report's facts, and it is not what you approve.</p>
                </div>
            )}
        </section>
    );
};
