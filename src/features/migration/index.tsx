import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { connectionLabel } from "@/lib/live-connection-api";
import { cn } from "@/lib/utils";
import { queryCheckUrl } from "@/features/query-check/context";
import { ASSISTANT_NAME, readCollapsed, writeCollapsed } from "./assistant";
import { ChatPanel } from "./chat-panel";
import { ConfirmBar } from "./confirm-bar";
import { MigrationChecklist } from "./migration-checklist";
import { MigrationProof } from "./migration-proof";
import { useMigration } from "./use-migration";

/**
 * Oracle to PostgreSQL, as a conversation with a checklist. The plan (what every column becomes, what can be lost, what is left behind)
 * is on the left, CosmicQuery (the assistant that changes it) is on the right and folds away when the plan needs the room, and nothing runs
 * until the person says it looks good. Afterwards the page proves the result with the comparisons run on both databases, and sends the
 * person to the query check, which shows what a query returns on each side.
 */
const MigrationPage: React.FC = () => {
    const migration = useMigration();
    const navigate = useNavigate();
    const { oracleDatabases, loadingDatabases, sourceId, setSourceId, plan, planError, loadingPlan, edits, outcome, proof, rerunning, rerunProof, source } = migration;
    // on a narrow screen the plan and the assistant take turns
    const [view, setView] = useState<"plan" | "assistant">("plan");
    const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());
    const toggle = () => {
        writeCollapsed(!collapsed);
        setCollapsed(!collapsed);
    };

    return (
        <div className="flex h-full min-h-0 w-full flex-col bg-background">
            <header className="flex flex-wrap items-center gap-3 border-b px-3 py-2">
                <div className="min-w-0">
                    <h1 className="text-sm font-medium">Migrate to PostgreSQL</h1>
                    <p className="text-[11px] text-muted-foreground">Read the plan, change what you want with {ASSISTANT_NAME}, and start the migration when it looks right.</p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                    <span className="hidden text-xs text-muted-foreground sm:inline">Oracle database</span>
                    <Select value={sourceId} onValueChange={setSourceId} disabled={loadingDatabases || oracleDatabases.length === 0 || migration.migrating || Boolean(outcome)}>
                        <SelectTrigger size="sm" className="h-8 w-56 max-w-full" aria-label="Oracle database to migrate">
                            <SelectValue placeholder={loadingDatabases ? "Loading…" : oracleDatabases.length === 0 ? "No Oracle database" : "Pick an Oracle database"} />
                        </SelectTrigger>
                        <SelectContent>
                            {oracleDatabases.map((connection) => (
                                <SelectItem key={connection.id} value={connection.id}>{connectionLabel(connection, oracleDatabases)}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex w-full gap-1 lg:hidden" role="tablist" aria-label={`Plan or ${ASSISTANT_NAME}`}>
                    {(["plan", "assistant"] as const).map((name) => (
                        <Button key={name} role="tab" aria-selected={view === name} size="sm" variant={view === name ? "default" : "outline"} className="h-8 flex-1" onClick={() => setView(name)}>{name === "plan" ? "Plan" : ASSISTANT_NAME}</Button>
                    ))}
                </div>
            </header>

            <div className={cn("grid min-h-0 flex-1 gap-3 p-3", collapsed ? "lg:grid-cols-[minmax(0,1fr)_3rem]" : "lg:grid-cols-[minmax(0,1fr)_26rem]")}>
                <div className={cn("min-h-0 min-w-0 space-y-3 overflow-y-auto pr-1", view === "assistant" && "hidden lg:block")} data-testid="plan-column">
                    {!loadingDatabases && oracleDatabases.length === 0 && (
                        <div className="rounded-lg border p-4 text-sm">
                            <p className="font-medium">There is no Oracle database to migrate yet.</p>
                            <p className="mt-1 text-muted-foreground">Create one from an Oracle diagram (File, then Create a live database from this diagram), run your data into it on the SQL page, and come back.</p>
                            <Button size="sm" variant="outline" className="mt-3" onClick={() => navigate("/database/sql")}>Open the SQL editor</Button>
                        </div>
                    )}
                    {sourceId && !plan && !planError && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Reading {source?.name ?? "the Oracle database"} and checking your data…</p>}
                    {planError && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{planError}</p>}
                    {plan && (
                        <>
                            <p className={cn("text-xs text-muted-foreground", loadingPlan && "opacity-60")}>
                                {plan.tables.length} table{plan.tables.length === 1 ? "" : "s"}, {plan.tables.reduce((sum, table) => sum + table.rows, 0).toLocaleString()} rows in <span className="text-foreground">{source?.name}</span>. {loadingPlan ? "Checking your data again…" : ""}
                            </p>
                            <MigrationChecklist plan={plan} edits={edits} />
                            <ConfirmBar migration={migration} />
                        </>
                    )}
                    {outcome && plan && (
                        <>
                            <div className="space-y-2 rounded-lg border border-emerald-500/40 p-3 text-xs" role="status">
                                <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400"><Check className="size-4" /> “{outcome.connection.name}” is a PostgreSQL database now, and every table matches Oracle.</p>
                                <div className="flex flex-wrap gap-2">
                                    <Button size="sm" variant="outline" onClick={() => navigate("/database/data")}>Browse it in Data</Button>
                                    <Button size="sm" variant="outline" onClick={() => navigate("/database/sql")}>Open it in the SQL editor</Button>
                                </div>
                            </div>
                            {proof && <MigrationProof verification={proof} onRerun={() => void rerunProof()} rerunning={rerunning} />}
                            {sourceId && (
                                <div className="space-y-2 rounded-lg border bg-card p-3 text-xs">
                                    <p className="text-sm font-medium">Prove it with a query</p>
                                    <p className="text-muted-foreground">The query check runs a query on Oracle and the same question on PostgreSQL, and shows the rows each returns side by side, with the counts and what differs. It starts from a query that reads 100 rows, with the names you changed already written in.</p>
                                    <Button size="sm" onClick={() => navigate(queryCheckUrl(sourceId, outcome.connection.id))}>Open the query check</Button>
                                </div>
                            )}
                        </>
                    )}
                </div>

                <div className={cn("min-h-[28rem] min-w-0 lg:min-h-0", view === "plan" && "hidden lg:block")}>
                    <ChatPanel migration={migration} collapsed={collapsed} onToggle={toggle} />
                </div>
            </div>
        </div>
    );
};

export default MigrationPage;
