import { useEffect, useState } from "react";
import { ArrowRightLeft, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SavedConnection, connectionLabel, listSavedConnections } from "@/lib/live-connection-api";
import { MigrationOutcome, MigrationPlanPreview, migrateOracleToPostgres, planOracleMigration } from "@/lib/migrations-api";
import { useAuth } from "@/providers/auth-provider/auth-provider";
import { rememberDataConnection } from "@/features/data-browser/use-data-browser";
import { rememberConnectionOnPages } from "@/features/database/live-database";
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
    const cloudAvailable = auth.cloudDatabases !== undefined;

    useEffect(() => {
        if (!open || !connection) return;
        let current = true;
        setPlan(undefined);
        setError(undefined);
        setDone(undefined);
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

    const rowsTotal = plan?.tables.reduce((sum, table) => sum + table.rows, 0) ?? 0;

    return (
        <>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setOpen(true)} disabled={editor.isRunning} aria-label={`Migrate the database ${connection.name} to PostgreSQL`}>
                <ArrowRightLeft className="size-3.5" /> Migrate to PostgreSQL
            </Button>
            <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
                <DialogContent className="max-w-xl">
                    <DialogHeader>
                        <DialogTitle>Migrate “{connection.name}” to PostgreSQL</DialogTitle>
                        <DialogDescription>Creates a new PostgreSQL database with the same tables and keys, copies every row, and checks each table against Oracle. Nothing is kept if any of it fails. The Oracle database is not changed.</DialogDescription>
                    </DialogHeader>

                    {!plan && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Reading the Oracle database…</p>}

                    {plan && (
                        <div className="space-y-3 text-xs">
                            <div className="max-h-48 overflow-auto rounded-md border">
                                <table className="w-full text-left">
                                    <thead className="bg-muted/50 text-muted-foreground">
                                        <tr><th className="px-2 py-1 font-medium">Oracle table</th><th className="px-2 py-1 font-medium">PostgreSQL table</th><th className="px-2 py-1 text-right font-medium">Columns</th><th className="px-2 py-1 text-right font-medium">Rows</th></tr>
                                    </thead>
                                    <tbody>
                                        {plan.tables.map((table) => (
                                            <tr key={table.oracleName} className="border-t">
                                                <td className="px-2 py-1 font-mono">{table.oracleName}</td>
                                                <td className="px-2 py-1 font-mono">{table.pgName}</td>
                                                <td className="px-2 py-1 text-right">{table.columns.length}</td>
                                                <td className="px-2 py-1 text-right">{table.rows.toLocaleString()}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <p className="text-muted-foreground">{plan.tables.length} table{plan.tables.length === 1 ? "" : "s"}, {rowsTotal.toLocaleString()} rows. Upper-case names become lower-case; NUMBER becomes integer, bigint or numeric by its precision; DATE becomes timestamp.</p>
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
                        <div className="space-y-2 text-xs" role="status">
                            <p className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400"><Check className="size-3.5" /> “{done.connection.name}” is a PostgreSQL database now, and every table matches Oracle.</p>
                            <ul className="text-muted-foreground">
                                {done.verification.map((entry) => <li key={entry.table}><span className="font-mono text-foreground">{entry.table}</span>: {entry.postgresRows.toLocaleString()} rows, {entry.checks} checks against Oracle</li>)}
                            </ul>
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
