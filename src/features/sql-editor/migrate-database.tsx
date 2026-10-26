import { useEffect, useState } from "react";
import { ArrowRightLeft, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SavedConnection, connectionLabel, listSavedConnections } from "@/lib/live-connection-api";
import { MigrationOutcome, MigrationPlanPreview, TableVerification, migrateOracleToPostgres, planOracleMigration, verifyMigration } from "@/lib/migrations-api";
import { useAuth } from "@/providers/auth-provider/auth-provider";
import { rememberDataConnection } from "@/features/data-browser/use-data-browser";
import { rememberConnectionOnPages } from "@/features/database/live-database";
import { MigrationChecklist } from "./migration-checklist";
import { MigrationProof } from "./migration-proof";
import type { SqlEditor } from "./use-sql-editor";

const CLOUD = "cloud";

/**
 * Migrating the open Oracle database into a new PostgreSQL database: the schema, the rows and the keys, checked table by table against
 * Oracle. The new database is a GoForge cloud database or one made on a saved PostgreSQL server, and it shows up everywhere PostgreSQL
 * connections do (Data, Modernizer, Schema Change, SQL). Nothing is kept if any of it fails.
 */
export const MigrateDatabase: React.FC<{ editor: SqlEditor }> = ({ editor }) => {
    const auth = useAuth();
    const connection = editor.connection;
    const [open, setOpen] = useState(false);
    const [plan, setPlan] = useState<MigrationPlanPreview | undefined>(undefined);
    const [servers, setServers] = useState<SavedConnection[]>([]);
    const [target, setTarget] = useState("");
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const [done, setDone] = useState<MigrationOutcome | undefined>(undefined);
    /** The proof on show: the migration's own, or the one from running the checks again. */
    const [proof, setProof] = useState<TableVerification[] | undefined>(undefined);
    const [rerunning, setRerunning] = useState(false);
    const cloudAvailable = auth.cloudDatabases !== undefined;

    useEffect(() => {
        if (!open || !connection) return;
        let current = true;
        setPlan(undefined);
        setError(undefined);
        setDone(undefined);
        setProof(undefined);
        setName(`${connection.name} postgres`.slice(0, 60));
        planOracleMigration(connection.id)
            .then((result) => current && setPlan(result))
            .catch((caught) => current && setError(caught instanceof Error ? caught.message : String(caught)));
        listSavedConnections()
            .then((list) => {
                if (!current) return;
                const own = list.filter((candidate) => candidate.kind !== "cloud");
                setServers(own);
                setTarget((previous) => previous || (cloudAvailable ? CLOUD : (own[0]?.id ?? "")));
            })
            .catch(() => undefined);
        return () => {
            current = false;
        };
        // the plan is read when the dialog opens
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, connection?.id]);

    if (!connection || connection.engine !== "oracle") return null;

    const canMigrate = Boolean(plan && plan.problems.length === 0 && plan.tables.length > 0 && target && name.trim() && !busy && !done);
    const migrate = async () => {
        setBusy(true);
        setError(undefined);
        try {
            const outcome = await migrateOracleToPostgres({ sourceConnectionId: connection.id, name: name.trim(), target: target === CLOUD ? { kind: "cloud" } : { kind: "server", connectionId: target } });
            setDone(outcome);
            setProof(outcome.verification);
            rememberConnectionOnPages(outcome.connection.id);
            rememberDataConnection(outcome.connection.id);
            if (target === CLOUD) await auth.refresh();
            await editor.refreshConnections();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const rerunProof = async () => {
        if (!done) return;
        setRerunning(true);
        setError(undefined);
        try {
            setProof((await verifyMigration({ sourceConnectionId: connection.id, targetConnectionId: done.connection.id })).verification);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setRerunning(false);
        }
    };

    const rowsTotal = plan?.tables.reduce((sum, table) => sum + table.rows, 0) ?? 0;

    return (
        <>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setOpen(true)} disabled={editor.isRunning} aria-label={`Migrate the database ${connection.name} to PostgreSQL`}>
                <ArrowRightLeft className="size-3.5" /> Migrate to PostgreSQL
            </Button>
            <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
                <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>Migrate “{connection.name}” to PostgreSQL</DialogTitle>
                        <DialogDescription>Creates a new PostgreSQL database with the same tables and keys, copies every row, and checks each table against Oracle with queries on both sides. Nothing is kept if any of it fails. The Oracle database is not changed.</DialogDescription>
                    </DialogHeader>

                    {!plan && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Reading the Oracle database…</p>}

                    {plan && (
                        <div className="min-w-0 space-y-3 text-xs">
                            <p className="text-muted-foreground">{plan.tables.length} table{plan.tables.length === 1 ? "" : "s"}, {rowsTotal.toLocaleString()} rows. Read this before you migrate: it says what every column becomes, what can be lost, and what is left behind.</p>
                            <MigrationChecklist plan={plan} />
                            {plan.problems.length > 0 && (
                                <div className="rounded-md border border-destructive/50 p-2 text-destructive" role="alert">
                                    <p className="font-medium">This database cannot be migrated as it is:</p>
                                    <ul className="list-disc pl-4">{plan.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
                                </div>
                            )}
                            {plan.problems.length === 0 && !done && (
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
                        </div>
                    )}

                    {done && (
                        <div className="min-w-0 space-y-2 text-xs" role="status">
                            <p className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400"><Check className="size-3.5" /> “{done.connection.name}” is a PostgreSQL database now, and every table matches Oracle.</p>
                            {proof && <MigrationProof verification={proof} onRerun={() => void rerunProof()} rerunning={rerunning} />}
                            <p className="text-muted-foreground">Open it under Data, Modernizer, Schema Change and SQL. In the Modernizer, an Oracle query can be run on the Oracle database and compared with its PostgreSQL conversion.</p>
                        </div>
                    )}
                    {error && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p>}

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>{done ? "Close" : "Cancel"}</Button>
                        {!done && (
                            <Button onClick={() => void migrate()} disabled={!canMigrate}>
                                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} {busy ? "Migrating…" : "Migrate"}
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
};
