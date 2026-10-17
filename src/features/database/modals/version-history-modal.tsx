import Modal, { ModalProps } from "@/components/modal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import useToast from "@/hooks/use-toast";
import useVersionHistory, { SnapshotSummary } from "@/hooks/use-version-history";
import { MigrationType } from "@/lib/schemas/version-history-schema";
import { cn } from "@/lib/utils";
import { useDatabase } from "@/providers/database-provider/database-provider";
import { isDestructiveSqlOperation } from "@/utils/import/prepare-sql-schema-change";
import { SchemaChangeSummary, summarizeSchemaChange } from "@/utils/import/summarize-schema-change";
import { verifyMigrationChecksum } from "@/utils/versioning/generate-migration";
import { AlertCircleIcon, ChevronDown, ChevronRight, Copy, Download, GitCompare, History, RotateCcw, Save, Trash2 } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ImportReviewPanel from "./import-review-panel";

type Tab = "snapshots" | "migrations";

const dateOf = (value: string | null | undefined) => (value ?? "").replace("T", " ").slice(0, 16);
const padded = (sequence: number) => String(sequence).padStart(4, "0");

const selectClass = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";

const VersionHistoryModal: React.FC<Omit<ModalProps, "title" | "children">> = ({ isOpen, onOpenChange }) => {
    const { t } = useTranslation();
    const raise = useToast();
    const { database } = useDatabase();
    const history = useVersionHistory();
    const { snapshots, migrations } = history;

    const [tab, setTab] = useState<Tab>("snapshots");
    const [error, setError] = useState<string | undefined>(undefined);
    const [name, setName] = useState("");
    const [note, setNote] = useState("");

    // One inline panel at a time: comparing, restoring or writing a migration for a snapshot.
    const [panel, setPanel] = useState<{ kind: "compare" | "restore" | "migrate"; snapshotId: string; summary?: SchemaChangeSummary; destructive?: number } | undefined>(undefined);
    const [accepted, setAccepted] = useState(false);
    const [migrationName, setMigrationName] = useState("");
    const [renaming, setRenaming] = useState<{ id: string; name: string } | undefined>(undefined);
    const [busy, setBusy] = useState(false);

    const [fromId, setFromId] = useState("");
    const [toId, setToId] = useState("current");
    const [newMigrationName, setNewMigrationName] = useState("");

    const fail = useCallback((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)), []);
    const run = useCallback(async (action: () => Promise<void>) => {
        setError(undefined);
        setBusy(true);
        try {
            await action();
        } catch (caught) {
            fail(caught);
        } finally {
            setBusy(false);
        }
    }, [fail]);

    const nameOf = useCallback((id: string) => snapshots.find((snapshot) => snapshot.id === id)?.name ?? "(deleted snapshot)", [snapshots]);

    const onSave = useCallback(() => run(async () => {
        const saved = await history.saveSnapshot({ name: name.trim() || `Snapshot ${snapshots.length + 1}`, note, kind: "manual" });
        setName("");
        setNote("");
        if (saved.created) raise(t("history.saved", { defaultValue: "Snapshot saved" }), saved.name, "SUCCESS");
        else raise(t("history.unchanged", { defaultValue: "Nothing changed" }), t("history.unchanged_hint", { name: saved.name, defaultValue: 'The project matches "{{name}}", so no new snapshot was needed.' }));
    }), [run, history, name, note, snapshots.length, raise, t]);

    const onOpenPanel = useCallback((kind: "compare" | "restore" | "migrate", snapshot: SnapshotSummary) => run(async () => {
        setAccepted(false);
        if (kind === "migrate") {
            setMigrationName("");
            setPanel({ kind, snapshotId: snapshot.id });
            return;
        }
        const { from, to, operations } = await history.compareVersions(kind === "compare" ? snapshot.id : "current", kind === "compare" ? "current" : snapshot.id);
        setPanel({ kind, snapshotId: snapshot.id, summary: summarizeSchemaChange(operations, from, to), destructive: operations.filter(isDestructiveSqlOperation).length });
    }), [run, history]);

    const onRestore = useCallback(() => run(async () => {
        if (!panel) return;
        const result = await history.restoreSnapshot(panel.snapshotId);
        setPanel(undefined);
        raise(t("history.restored", { defaultValue: "Snapshot restored" }), result.skippedReason ?? nameOf(panel.snapshotId), "SUCCESS");
        onOpenChange?.(false);
    }), [run, panel, history, raise, t, nameOf, onOpenChange]);

    const onMigrateToCurrent = useCallback(() => run(async () => {
        if (!panel) return;
        await history.createMigrationToCurrent({ name: migrationName.trim() || `From ${nameOf(panel.snapshotId)}`, sourceSnapshotId: panel.snapshotId });
        setPanel(undefined);
        setTab("migrations");
    }), [run, panel, history, migrationName, nameOf]);

    const onCreateMigration = useCallback(() => run(async () => {
        const target = toId === "current"
            ? (await history.saveSnapshot({ name: `State at ${dateOf(new Date().toISOString())}`, kind: "auto" })).id
            : toId;
        await history.createMigration({ name: newMigrationName.trim() || `${nameOf(fromId)} to ${toId === "current" ? "current" : nameOf(toId)}`, sourceSnapshotId: fromId, targetSnapshotId: target });
        setNewMigrationName("");
    }), [run, history, toId, fromId, newMigrationName, nameOf]);

    const onRename = useCallback(() => run(async () => {
        if (!renaming) return;
        await history.renameSnapshot(renaming.id, renaming.name);
        setRenaming(undefined);
    }), [run, history, renaming]);

    const onDeleteSnapshot = useCallback((id: string) => run(async () => { await history.deleteSnapshot(id); setPanel(undefined); }), [run, history]);

    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title={t("history.title", { defaultValue: "Version history" })}
            description={t("history.description", { defaultValue: "Snapshots are frozen copies of your schema. Migrations are the SQL between two of them." })}
            className="md:min-w-[760px] w-full"
        >
            <div className="flex flex-col gap-4">
                <div className="flex gap-2" role="tablist">
                    {([["snapshots", `Snapshots (${snapshots.length})`], ["migrations", `Migrations (${migrations.length})`]] as const).map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            role="tab"
                            aria-selected={tab === value}
                            data-testid={`history-tab-${value}`}
                            onClick={() => { setTab(value); setError(undefined); setPanel(undefined); }}
                            className={cn("h-8 rounded-md border px-3 text-sm hover:bg-secondary", tab === value && "border-primary bg-primary/20")}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {error && (
                    <Alert variant="destructive" data-testid="history-error">
                        <AlertCircleIcon />
                        <AlertTitle className="whitespace-pre-wrap">{error}</AlertTitle>
                    </Alert>
                )}

                {tab === "snapshots" && (
                    <div className="flex flex-col gap-3">
                        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                            <Input aria-label="Snapshot name" placeholder={t("history.name_placeholder", { defaultValue: "Snapshot name" })} value={name} onChange={(event) => setName(event.target.value)} />
                            <Input aria-label="Snapshot note" placeholder={t("history.note_placeholder", { defaultValue: "Note (optional)" })} value={note} onChange={(event) => setNote(event.target.value)} />
                            <Button type="button" onClick={onSave} disabled={busy} data-testid="history-save" className="gap-1.5"><Save className="size-4" />{t("history.save", { defaultValue: "Save snapshot" })}</Button>
                        </div>

                        {snapshots.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground" data-testid="history-empty">{t("history.no_snapshots", { defaultValue: "No snapshots yet. Save one before a risky change." })}</p>}

                        <ul className="max-h-72 space-y-2 overflow-auto" data-testid="history-snapshots">
                            {snapshots.map((snapshot) => (
                                <li key={snapshot.id} data-testid="history-snapshot" className="rounded-md border p-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="min-w-0">
                                            {renaming?.id === snapshot.id ? (
                                                <div className="flex gap-2">
                                                    <Input aria-label="New snapshot name" value={renaming.name} onChange={(event) => setRenaming({ id: snapshot.id, name: event.target.value })} />
                                                    <Button size="sm" onClick={onRename} disabled={busy}>{t("history.rename_save", { defaultValue: "Save" })}</Button>
                                                </div>
                                            ) : (
                                                <p className="truncate font-medium">{snapshot.name}{snapshot.kind === "auto" && <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs font-normal text-muted-foreground">auto</span>}</p>
                                            )}
                                            <p className="text-xs text-muted-foreground">{dateOf(snapshot.createdAt)} · {snapshot.tableCount} tables{snapshot.note ? ` · ${snapshot.note}` : ""}</p>
                                        </div>
                                        <div className="flex gap-1">
                                            <Button size="sm" variant="outline" className="gap-1" onClick={() => onOpenPanel("compare", snapshot)} disabled={busy} aria-label={`Compare ${snapshot.name} with current`}><GitCompare className="size-3.5" />{t("history.compare", { defaultValue: "Compare" })}</Button>
                                            <Button size="sm" variant="outline" className="gap-1" onClick={() => onOpenPanel("restore", snapshot)} disabled={busy} aria-label={`Restore ${snapshot.name}`}><RotateCcw className="size-3.5" />{t("history.restore", { defaultValue: "Restore" })}</Button>
                                            <Button size="sm" variant="outline" className="gap-1" onClick={() => onOpenPanel("migrate", snapshot)} disabled={busy} aria-label={`Write migration from ${snapshot.name}`}><History className="size-3.5" />{t("history.migrate", { defaultValue: "Migrate" })}</Button>
                                            <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: snapshot.id, name: snapshot.name })} aria-label={`Rename ${snapshot.name}`}>{t("history.rename", { defaultValue: "Rename" })}</Button>
                                            <Button size="sm" variant="ghost" onClick={() => onDeleteSnapshot(snapshot.id)} disabled={busy} aria-label={`Delete ${snapshot.name}`}><Trash2 className="size-3.5" /></Button>
                                        </div>
                                    </div>

                                    {panel?.snapshotId === snapshot.id && panel.kind !== "migrate" && panel.summary && (
                                        <div className="mt-3 space-y-3" data-testid={`history-panel-${panel.kind}`}>
                                            <p className="text-sm text-muted-foreground">
                                                {panel.kind === "compare"
                                                    ? t("history.compare_hint", { defaultValue: "Changes from this snapshot to the project now:" })
                                                    : t("history.restore_hint", { defaultValue: "Restoring changes the project like this. Your current state is saved as a snapshot first, and you can undo the restore:" })}
                                            </p>
                                            <ImportReviewPanel
                                                summary={panel.summary}
                                                destructiveCount={panel.kind === "restore" ? panel.destructive ?? 0 : 0}
                                                accepted={accepted}
                                                onAcceptedChange={setAccepted}
                                                deletionHint={t("history.restore_deletions", { defaultValue: "Tables and columns added since this snapshot are removed. You can undo the restore afterwards." })}
                                            />
                                            {panel.kind === "restore" && (
                                                <Button
                                                    size="sm"
                                                    onClick={onRestore}
                                                    disabled={busy || panel.summary.isEmpty || ((panel.destructive ?? 0) > 0 && !accepted)}
                                                    data-testid="history-confirm-restore"
                                                >
                                                    {t("history.restore_confirm", { defaultValue: "Restore this snapshot" })}
                                                </Button>
                                            )}
                                        </div>
                                    )}

                                    {panel?.snapshotId === snapshot.id && panel.kind === "migrate" && (
                                        <div className="mt-3 flex gap-2" data-testid="history-panel-migrate">
                                            <Input aria-label="Migration name" placeholder={t("history.migration_name", { defaultValue: "Migration name" })} value={migrationName} onChange={(event) => setMigrationName(event.target.value)} />
                                            <Button size="sm" onClick={onMigrateToCurrent} disabled={busy} data-testid="history-confirm-migrate">{t("history.migrate_confirm", { defaultValue: "Write migration to current" })}</Button>
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {tab === "migrations" && (
                    <div className="flex flex-col gap-3">
                        {database && database.dialect !== "postgres" && (
                            <Alert>
                                <AlertCircleIcon />
                                <AlertDescription>
                                    {t("history.dialect_note", { dialect: database.dialect, defaultValue: "For {{dialect}} projects GoForge writes migration SQL for new tables and relationships. Changes to existing tables are refused rather than written incompletely; snapshots, comparing and restoring work for every dialect." })}
                                </AlertDescription>
                            </Alert>
                        )}

                        {snapshots.length > 0 && (
                            <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                                <div className="space-y-1"><Label htmlFor="migration-from">{t("history.from", { defaultValue: "From" })}</Label>
                                    <select id="migration-from" className={selectClass} value={fromId} onChange={(event) => setFromId(event.target.value)}>
                                        <option value="">{t("history.choose", { defaultValue: "Choose a snapshot" })}</option>
                                        {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>)}
                                    </select></div>
                                <div className="space-y-1"><Label htmlFor="migration-to">{t("history.to", { defaultValue: "To" })}</Label>
                                    <select id="migration-to" className={selectClass} value={toId} onChange={(event) => setToId(event.target.value)}>
                                        <option value="current">{t("history.current", { defaultValue: "Current project" })}</option>
                                        {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>)}
                                    </select></div>
                                <div className="space-y-1"><Label htmlFor="migration-name">{t("history.migration_name", { defaultValue: "Migration name" })}</Label>
                                    <Input id="migration-name" value={newMigrationName} onChange={(event) => setNewMigrationName(event.target.value)} /></div>
                                <Button type="button" onClick={onCreateMigration} disabled={busy || !fromId} data-testid="history-create-migration">{t("history.create_migration", { defaultValue: "Write migration" })}</Button>
                            </div>
                        )}

                        {migrations.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground" data-testid="history-no-migrations">{t("history.no_migrations", { defaultValue: "No migrations yet. Changes applied from the SQL editor or an import are recorded here automatically." })}</p>}

                        <ul className="max-h-80 space-y-2 overflow-auto" data-testid="history-migrations">
                            {migrations.map((migration) => (
                                <MigrationRow
                                    key={migration.id}
                                    migration={migration}
                                    source={nameOf(migration.sourceSnapshotId)}
                                    target={nameOf(migration.targetSnapshotId)}
                                    onDownload={history.downloadMigration}
                                    onDelete={(id) => run(async () => { await history.deleteMigration(id); })}
                                />
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </Modal>
    );
};

interface MigrationRowProps {
    migration: MigrationType;
    source: string;
    target: string;
    onDownload: (migration: MigrationType, direction: "up" | "down") => void;
    onDelete: (id: string) => void;
}

const MigrationRow: React.FC<MigrationRowProps> = ({ migration, source, target, onDownload, onDelete }) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [intact, setIntact] = useState<boolean | undefined>(undefined);

    useEffect(() => {
        if (open) void verifyMigrationChecksum(migration).then(setIntact);
    }, [open, migration]);

    return (
        <li className="rounded-md border p-3" data-testid="history-migration">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
                    {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
                    <span className="min-w-0">
                        <span className="block truncate font-medium">{padded(migration.sequence)} · {migration.name}<span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs font-normal text-muted-foreground">{migration.origin}</span></span>
                        <span className="block truncate text-xs text-muted-foreground">{source} → {target} · {dateOf(migration.createdAt)}</span>
                    </span>
                </button>
                <div className="flex gap-1">
                    <Button size="sm" variant="outline" className="gap-1" onClick={() => onDownload(migration, "up")} aria-label={`Download up ${migration.name}`}><Download className="size-3.5" />up</Button>
                    <Button size="sm" variant="outline" className="gap-1" onClick={() => onDownload(migration, "down")} disabled={!migration.downSql} aria-label={`Download down ${migration.name}`} title={migration.downBlockedReason ?? undefined}><Download className="size-3.5" />down</Button>
                    <Button size="sm" variant="ghost" onClick={() => onDelete(migration.id)} aria-label={`Delete migration ${migration.name}`}><Trash2 className="size-3.5" /></Button>
                </div>
            </div>
            {open && (
                <div className="mt-3 space-y-3" data-testid="history-migration-detail">
                    <div>
                        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                            <span>UP</span>
                            <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => void navigator.clipboard?.writeText(migration.upSql)}><Copy className="size-3" />{t("history.copy", { defaultValue: "Copy" })}</button>
                        </div>
                        <pre className="max-h-40 overflow-auto rounded-md bg-secondary/60 p-2 font-mono text-xs" data-testid="history-up-sql">{migration.upSql}</pre>
                    </div>
                    <div>
                        <div className="mb-1 text-xs text-muted-foreground">DOWN</div>
                        {migration.downSql
                            ? <pre className="max-h-40 overflow-auto rounded-md bg-secondary/60 p-2 font-mono text-xs" data-testid="history-down-sql">{migration.downSql}</pre>
                            : <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground" data-testid="history-down-blocked">{migration.downBlockedReason ?? t("history.no_down", { defaultValue: "No down migration." })}</p>}
                    </div>
                    {intact !== undefined && (
                        <p className={cn("text-xs", intact ? "text-muted-foreground" : "text-destructive")} data-testid="history-checksum">
                            {intact ? t("history.checksum_ok", { defaultValue: "Checksum matches: this SQL is exactly what was generated." }) : t("history.checksum_bad", { defaultValue: "Checksum mismatch: this SQL was changed after it was generated." })}
                        </p>
                    )}
                </div>
            )}
        </li>
    );
};

export default React.memo(VersionHistoryModal);
