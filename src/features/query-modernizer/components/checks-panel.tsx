import React from "react";
import { AlertTriangle, CheckCircle2, CircleSlash, MinusCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModernizeOutcome } from "../modernize";
import { LEGACY_DIALECTS } from "../types";

type Tone = "pass" | "warn" | "fail" | "info";

const ICON: Record<Tone, React.ReactNode> = {
    pass: <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Passed" />,
    warn: <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-label="Needs a look" />,
    fail: <XCircle className="size-4 shrink-0 text-destructive" aria-label="Failed" />,
    info: <MinusCircle className="size-4 shrink-0 text-muted-foreground" aria-label="Not checked" />,
};

const Row: React.FC<{ tone: Tone; title: string; children?: React.ReactNode }> = ({ tone, title, children }) => (
    <li className="flex gap-2.5 py-2.5">
        <span className="mt-0.5">{ICON[tone]}</span>
        <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">{title}</p>
            {children && <div className="mt-1 text-xs text-muted-foreground space-y-1.5 break-words">{children}</div>}
        </div>
    </li>
);

/** A list of what was checked and what came out, in plain words. There is no score: each line is a fact or says it wasn't checked. */
export const ChecksPanel: React.FC<{ outcome: ModernizeOutcome; hasTables: boolean }> = ({ outcome, hasTables }) => {
    const { engine, postgres, syntax } = outcome;
    const dialectLabel = LEGACY_DIALECTS.find((candidate) => candidate.value === outcome.dialect)?.label ?? outcome.dialect;
    const rejected = postgres.statements.find((statement) => statement.status === "rejected");
    const changesResults = engine.traps.filter((trap) => trap.severity === "changes-results");
    const worthChecking = engine.traps.filter((trap) => trap.severity === "check");
    const ruleCount = engine.applied.reduce((sum, rule) => sum + rule.count, 0);

    return (
        <div className="flex flex-col gap-3 p-1">
            <ul className="divide-y rounded-lg border bg-card px-3">
                <Row tone={engine.syntaxError ? "fail" : "pass"} title={engine.syntaxError ? "Could not read the query" : `Read as ${dialectLabel}`}>
                    {engine.syntaxError ? <p>{engine.syntaxError}</p> : <p>{engine.statements.length === 1 ? "1 statement." : `${engine.statements.length} statements.`}</p>}
                </Row>

                <Row tone={engine.applied.length > 0 ? "pass" : "info"} title={engine.applied.length > 0 ? `Rewritten by ${engine.applied.length} rule${engine.applied.length === 1 ? "" : "s"} (${ruleCount} change${ruleCount === 1 ? "" : "s"})` : "No rule needed to change anything"}>
                    {engine.applied.length > 0 && <p>See the Changes tab for each one, with the old and new text.</p>}
                </Row>

                <Row tone={engine.unconverted.length === 0 ? "pass" : outcome.source === "ai" ? "warn" : "fail"} title={engine.unconverted.length === 0 ? "Nothing left unconverted" : `${engine.unconverted.length} thing${engine.unconverted.length === 1 ? "" : "s"} the rules could not convert${outcome.source === "ai" ? " (rewritten by the model)" : ""}`}>
                    {engine.unconverted.map((item, index) => (
                        <div key={index} className="rounded-md bg-muted/40 p-2">
                            <code className="font-mono text-[11px] text-foreground break-all">{item.construct}</code>
                            <p className="mt-0.5">{item.reason}.</p>
                            {item.hint && <p className="text-foreground/80">Instead: {item.hint}</p>}
                        </div>
                    ))}
                </Row>

                <Row tone={syntax.ok ? "pass" : outcome.postgres.status === "accepted" ? "info" : "fail"} title={syntax.ok ? "The result is valid PostgreSQL syntax" : "A PostgreSQL grammar does not accept the result"}>
                    <p>{syntax.ok ? "Checked offline with a general SQL parser. It can't see whether tables or functions exist." : syntax.error}</p>
                </Row>

                {postgres.status === "accepted" && (
                    <Row tone="pass" title={`PostgreSQL accepts it${postgres.connectionName ? ` (${postgres.connectionName})` : ""}`}>
                        <p>It planned the query against your real tables, columns, functions and types. Nothing was run and nothing was changed.</p>
                    </Row>
                )}
                {postgres.status === "rejected" && (
                    <Row tone="fail" title={`PostgreSQL rejects it${postgres.connectionName ? ` (${postgres.connectionName})` : ""}`}>
                        <p className="text-foreground">{rejected?.error?.message}</p>
                        {rejected?.excerpt && <code className="block font-mono text-[11px] bg-muted/40 rounded-md p-2 break-all">{rejected.excerpt}</code>}
                        {rejected?.error?.hint && <p>Hint: {rejected.error.hint}</p>}
                    </Row>
                )}
                {postgres.status === "skipped" && (
                    <Row tone="info" title="PostgreSQL could not check this kind of statement">
                        <p>Only queries and data changes can be checked without running them.</p>
                    </Row>
                )}
                {postgres.status === "unreachable" && (
                    <Row tone="warn" title="Could not ask PostgreSQL">
                        <p>{postgres.message}</p>
                    </Row>
                )}
                {postgres.status === "not-run" && (
                    <Row tone="info" title="Not checked against a database">
                        <p>Choose a connection above and convert again to have PostgreSQL confirm that the tables, columns and functions exist and the types fit.</p>
                    </Row>
                )}

                {hasTables ? (
                    <Row tone={engine.unknownTables.length === 0 ? "pass" : "warn"} title={engine.unknownTables.length === 0 ? "Every table is in your project" : `${engine.unknownTables.length} table${engine.unknownTables.length === 1 ? "" : "s"} not in your project`}>
                        {engine.unknownTables.length > 0 && <p className="font-mono">{engine.unknownTables.join(", ")}</p>}
                    </Row>
                ) : (
                    <Row tone="info" title="Table names not compared with a project">
                        <p>This project has no tables on its canvas.</p>
                    </Row>
                )}

                {outcome.source === "ai" && outcome.ai && (
                    <Row tone="warn" title={`Converted by the model (${outcome.ai.model}), in ${outcome.ai.attempts} ${outcome.ai.attempts === 1 ? "try" : "tries"}`}>
                        <p>{outcome.ai.checkedByDatabase ? "PostgreSQL accepts the model's SQL." : "Only a syntax check was done on the model's SQL."} Whether it means the same as the original has not been checked.</p>
                        {outcome.ai.summary && <p>{outcome.ai.summary}</p>}
                        {outcome.ai.risks.length > 0 && (
                            <div>
                                <p className="text-foreground">The model says to watch for (unverified):</p>
                                <ul className="list-disc pl-4">
                                    {outcome.ai.risks.map((risk, index) => (
                                        <li key={index}>{risk}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        {outcome.ai.unsupported.length > 0 && <p>It also reported it could not convert: {outcome.ai.unsupported.join("; ")}.</p>}
                    </Row>
                )}
                {outcome.aiNotice && (
                    <Row tone="warn" title="The model's answer was not used">
                        <p>{outcome.aiNotice}</p>
                    </Row>
                )}
            </ul>

            {engine.parameters.length > 0 && (
                <div className="rounded-lg border bg-card p-3">
                    <h4 className="text-xs font-medium text-foreground">Bind variables</h4>
                    <p className="mt-1 text-xs text-muted-foreground">
                        <span className="font-mono">{engine.parameters.join(", ")}</span> are left as written. PostgreSQL drivers use $1, $2, … instead. For the database check they were replaced with NULL.
                    </p>
                </div>
            )}

            {engine.traps.length > 0 && (
                <div className="flex flex-col gap-2">
                    <h4 className="px-1 text-xs font-medium text-foreground">Where the result can differ{changesResults.length > 0 ? ` (${changesResults.length} can change what comes back)` : ""}</h4>
                    {[...changesResults, ...worthChecking].map((trap) => (
                        <div key={trap.id} className={cn("rounded-lg border bg-card p-3 border-l-2", trap.severity === "changes-results" ? "border-l-amber-500" : "border-l-border")}>
                            <div className="flex items-center gap-2">
                                <CircleSlash className={cn("size-3.5 shrink-0", trap.severity === "changes-results" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")} aria-hidden="true" />
                                <p className="text-xs font-medium text-foreground">{trap.title}</p>
                                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{trap.severity === "changes-results" ? "Can change results" : "Worth checking"}</span>
                            </div>
                            <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">{trap.explanation}</p>
                        </div>
                    ))}
                </div>
            )}

            <p className="px-1 text-[11px] text-muted-foreground leading-relaxed">A passing check list means PostgreSQL accepts the query and nothing known was left behind. It does not prove the same rows come back. Run the old and the new query on the same data and compare.</p>
        </div>
    );
};
