import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { connectionLabel } from "@/lib/live-connection-api";
import { countEdits } from "@/lib/migrations-api";
import { ASSISTANT_NAME } from "./assistant";
import { CLOUD, type Migration } from "./use-migration";

/**
 * Where the migration is started. It says what is about to happen, lists any value a change would lose and asks for it to be accepted by
 * name, and only then lets the migration begin. The server checks the same thing again from the data as it is at that moment.
 */
export const ConfirmBar: React.FC<{ migration: Migration }> = ({ migration }) => {
    const { plan, edits, servers, cloudAvailable, target, setTarget, name, setName, failing, acceptLoss, setAcceptLoss, canMigrate, migrating, migrateError, migrate, loadingPlan, asking, outcome } = migration;
    if (!plan || outcome) return null;
    const changes = countEdits(edits);
    const blocked = plan.problems.length > 0;

    return (
        <section className="space-y-3 rounded-lg border bg-card p-3 text-xs" aria-label="Start the migration">
            <div>
                <p className="text-sm font-medium">{changes === 0 ? "Start the migration as GoForge proposed it?" : `Start the migration with your ${changes} change${changes === 1 ? "" : "s"}?`}</p>
                <p className="text-muted-foreground">It creates a new PostgreSQL database, copies every row, and compares each table with Oracle by queries on both sides. If anything differs, nothing is kept. The Oracle database is not changed.</p>
            </div>

            {blocked && (
                <div className="rounded-md border border-destructive/50 p-2 text-destructive" role="alert">
                    <p className="font-medium">This cannot be migrated as it stands:</p>
                    <ul className="list-disc pl-4">{plan.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
                    <p className="mt-1 text-muted-foreground">Ask {ASSISTANT_NAME} to fix it, for example by dropping a default Oracle code cannot become.</p>
                </div>
            )}

            {failing.length > 0 && (
                <div className="space-y-1.5 rounded-md border border-destructive/50 p-2">
                    <p className="font-medium text-destructive">Some values would change or be lost</p>
                    <ul className="list-disc pl-4">
                        {failing.map((entry) => (
                            <li key={`${entry.table}.${entry.column}`}>
                                <span className="font-mono">{entry.table}.{entry.column}</span>: {entry.check.count === null ? `the check could not run (${entry.check.error ?? "the query failed"})` : `${entry.check.count.toLocaleString()} ${entry.check.description}`}
                            </li>
                        ))}
                    </ul>
                    <label htmlFor="accept-loss" className="flex cursor-pointer items-start gap-2">
                        <Switch id="accept-loss" checked={acceptLoss} onCheckedChange={setAcceptLoss} className="mt-0.5" />
                        <span>I have read this and accept that these values change or are lost. Or ask {ASSISTANT_NAME} for a type that keeps them.</span>
                    </label>
                </div>
            )}

            {!blocked && (
                <div className="grid gap-2 sm:grid-cols-2">
                    <div className="min-w-0 space-y-1">
                        <label htmlFor="migrate-target" className="text-[11px] text-muted-foreground">Create it on</label>
                        <Select value={target || undefined} onValueChange={setTarget}>
                            <SelectTrigger id="migrate-target" size="sm" className="h-8 w-full min-w-0" aria-label="Where to create the PostgreSQL database"><SelectValue placeholder="Pick a server" /></SelectTrigger>
                            <SelectContent>
                                {cloudAvailable && <SelectItem value={CLOUD}>GoForge cloud (your account)</SelectItem>}
                                {servers.map((server) => <SelectItem key={server.id} value={server.id}>{connectionLabel(server, servers)}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="min-w-0 space-y-1">
                        <label htmlFor="migrate-name" className="text-[11px] text-muted-foreground">New database name</label>
                        <Input id="migrate-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoComplete="off" spellCheck={false} className="h-8 text-xs" />
                    </div>
                    {!cloudAvailable && servers.length === 0 && <p className="text-muted-foreground sm:col-span-2">Save a PostgreSQL server first (File → Connect Live Database) to create the new database on it.</p>}
                </div>
            )}

            {migrateError && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{migrateError}</p>}

            <div className="flex flex-wrap items-center justify-end gap-2">
                {(loadingPlan || asking) && <span className="text-muted-foreground">Waiting for the plan…</span>}
                <Button onClick={() => void migrate()} disabled={!canMigrate}>
                    {migrating ? <Loader2 className="size-3.5 animate-spin" /> : null} {migrating ? "Migrating…" : "Looks good, start the migration"}
                </Button>
            </div>
        </section>
    );
};
