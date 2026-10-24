import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal, { ModalProps } from "@/components/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import useToast from "@/hooks/use-toast";
import { AlertCircleIcon, Check, Loader2, Pencil, Plug, Trash2, X } from "lucide-react";
import { CreateConnectionInput, SavedConnection, listSavedConnections, renameSavedConnection } from "@/lib/live-connection-api";
import { forgetConnection } from "../forget-connection";
import { Modals } from "@/providers/modal-provider/modal-contxet";
import { useModal } from "@/providers/modal-provider/modal-provider";
import { looksLikeConnectionString, parseConnectionString } from "../connection-string";
import { ConnectPhase, useConnectDatabase } from "../use-connect-database";

const EMPTY_FORM: CreateConnectionInput = { name: "", host: "localhost", port: 5432, username: "", password: "", database: "", sslMode: "disable" };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The way into the app: say which database to look at. A pasted connection string connects at once; the fields
 * are there for people who have the parts instead. Starting from an empty diagram is still possible, but it is
 * the second choice.
 */
const ConnectDatabaseModal: React.FC<ModalProps> = (props) => {
    const { t } = useTranslation();
    const { isOpen, onOpenChange } = props;
    const raise = useToast();
    const { open } = useModal();
    const { connectNew, connectSaved } = useConnectDatabase();

    const [mode, setMode] = useState<"string" | "details">("string");
    const [text, setText] = useState("");
    const [form, setForm] = useState<CreateConnectionInput>(EMPTY_FORM);
    const [phase, setPhase] = useState<ConnectPhase | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [notes, setNotes] = useState<string[]>([]);
    const [saved, setSaved] = useState<SavedConnection[]>([]);
    const [listError, setListError] = useState<string | undefined>(undefined);
    const [renaming, setRenaming] = useState<{ id: string; name: string } | undefined>(undefined);
    const busy = phase !== undefined;
    // A second click or a paste while a connect is running must not start another one.
    const running = useRef(false);

    const refreshSaved = useCallback(async () => {
        try {
            setSaved(await listSavedConnections());
            setListError(undefined);
        } catch (caught) {
            setListError(errorText(caught));
        }
    }, []);

    useEffect(() => {
        if (isOpen) void refreshSaved();
    }, [isOpen, refreshSaved]);

    const attempt = useCallback(async (job: (onPhase: (phase: ConnectPhase) => void) => Promise<{ name: string; tables: number }>) => {
        if (running.current) return;
        running.current = true;
        setError(undefined);
        setPhase("saving");
        try {
            const project = await job(setPhase);
            raise(
                t("modals.connect_database.connected", { defaultValue: "Connected" }),
                t("modals.connect_database.connected_detail", { defaultValue: "{{name}}: {{count}} tables read", name: project.name, count: project.tables }),
                "SUCCESS",
            );
            onOpenChange?.(false);
        } catch (caught) {
            setError(errorText(caught));
        } finally {
            running.current = false;
            setPhase(undefined);
        }
    }, [onOpenChange, raise, t]);

    const connectText = useCallback((value: string) => {
        const result = parseConnectionString(value);
        if (!result.ok) {
            setNotes([]);
            setError(result.reason);
            return;
        }
        setNotes(result.value.notes);
        void attempt((onPhase) => connectNew(result.value.input, onPhase));
    }, [attempt, connectNew]);

    const onPaste = useCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
        const pasted = event.clipboardData.getData("text");
        // Anything that is not a connection string is pasted as usual (a host name, a password…).
        if (!looksLikeConnectionString(pasted)) return;
        event.preventDefault();
        const value = pasted.trim();
        setText(value);
        connectText(value);
    }, [connectText]);

    const onSubmit = useCallback((event: React.FormEvent) => {
        event.preventDefault();
        if (busy) return;
        if (mode === "string") {
            connectText(text);
            return;
        }
        if (!form.host.trim() || !form.username.trim() || !form.database.trim()) {
            setError(t("modals.connect_database.form_error", { defaultValue: "Host, user and database are required." }));
            return;
        }
        setNotes([]);
        void attempt((onPhase) => connectNew({ ...form, host: form.host.trim(), username: form.username.trim(), database: form.database.trim(), name: form.name.trim() || form.database.trim() }, onPhase));
    }, [attempt, busy, connectNew, connectText, form, mode, t, text]);

    const onDeleteSaved = useCallback(async (connection: SavedConnection) => {
        try {
            await forgetConnection(connection);
        } catch (caught) {
            setError(errorText(caught));
        }
        await refreshSaved();
    }, [refreshSaved]);

    const saveRename = useCallback(async () => {
        if (!renaming) return;
        const name = renaming.name.trim();
        const current = saved.find((connection) => connection.id === renaming.id);
        if (!name || name === current?.name) {
            setRenaming(undefined);
            return;
        }
        try {
            await renameSavedConnection(renaming.id, name);
            setRenaming(undefined);
            setError(undefined);
        } catch (caught) {
            setError(errorText(caught));
        }
        await refreshSaved();
    }, [refreshSaved, renaming, saved]);

    const startEmpty = useCallback(() => open(Modals.CREATE_DATABASE, { closable: props.closable }), [open, props.closable]);

    const phaseLabel: Record<ConnectPhase, string> = {
        saving: t("modals.connect_database.phase_saving", { defaultValue: "Saving the connection…" }),
        reading: t("modals.connect_database.phase_reading", { defaultValue: "Reading the schema…" }),
        drawing: t("modals.connect_database.phase_drawing", { defaultValue: "Laying out the diagram…" }),
    };

    return (
        <Modal
            {...props}
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title={t("modals.connect_database.title", { defaultValue: "Connect to a database" })}
            description={t("modals.connect_database.description", { defaultValue: "GoForge reads the structure of a PostgreSQL database (tables, columns, keys, indexes, views) and opens it as a diagram. It never reads rows." })}
            className="lg:min-w-[560px] w-full max-h-screen overflow-y-auto overflow-x-hidden grid-cols-[minmax(0,1fr)]"
            footer={false}
        >
            <form onSubmit={onSubmit} className="flex min-w-0 flex-col gap-3">
                {mode === "string" ? (
                    <div className="space-y-1.5">
                        <Label htmlFor="connection-string">{t("modals.connect_database.string_label", { defaultValue: "Connection string" })}</Label>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                                id="connection-string"
                                value={text}
                                onChange={(event) => setText(event.target.value)}
                                onPaste={onPaste}
                                disabled={busy}
                                autoComplete="off"
                                spellCheck={false}
                                placeholder="postgres://user:password@host:5432/database"
                                className="min-w-0 flex-1 font-mono text-xs"
                            />
                            <Button type="submit" disabled={busy || !text.trim()} className="sm:shrink-0">
                                {busy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                                {t("modals.connect_database.connect", { defaultValue: "Connect" })}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t("modals.connect_database.string_hint", { defaultValue: "Paste it and GoForge connects right away. postgres:// URLs, JDBC URLs and host=… dbname=… strings work." })}
                        </p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        <div className="space-y-1">
                            <Label htmlFor="connect-name">{t("modals.connect_database.name_label", { defaultValue: "Name (optional)" })}</Label>
                            <Input id="connect-name" value={form.name} disabled={busy} maxLength={100} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={form.database.trim() || t("modals.connect_database.name_placeholder", { defaultValue: "Defaults to the database name" })} autoComplete="off" />
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                            <div className="col-span-2 space-y-1">
                                <Label htmlFor="connect-host">{t("modals.connect_live_database.host")}</Label>
                                <Input id="connect-host" value={form.host} disabled={busy} onChange={(event) => setForm({ ...form, host: event.target.value })} />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="connect-port">{t("modals.connect_live_database.port")}</Label>
                                <Input id="connect-port" type="number" value={form.port} disabled={busy} onChange={(event) => setForm({ ...form, port: Number(event.target.value) || 0 })} />
                            </div>
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <div className="space-y-1">
                                <Label htmlFor="connect-user">{t("modals.connect_live_database.username")}</Label>
                                <Input id="connect-user" value={form.username} disabled={busy} onChange={(event) => setForm({ ...form, username: event.target.value })} autoComplete="off" />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="connect-password">{t("modals.connect_live_database.password")}</Label>
                                <Input id="connect-password" type="password" value={form.password} disabled={busy} onChange={(event) => setForm({ ...form, password: event.target.value })} autoComplete="new-password" />
                            </div>
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <div className="space-y-1">
                                <Label htmlFor="connect-database">{t("modals.connect_live_database.database")}</Label>
                                <Input id="connect-database" value={form.database} disabled={busy} onChange={(event) => setForm({ ...form, database: event.target.value })} />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="connect-ssl">{t("modals.connect_live_database.ssl_mode")}</Label>
                                <Select value={form.sslMode} disabled={busy} onValueChange={(value) => setForm({ ...form, sslMode: value as CreateConnectionInput["sslMode"] })}>
                                    <SelectTrigger id="connect-ssl" className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="disable">disable</SelectItem>
                                        <SelectItem value="allow">allow</SelectItem>
                                        <SelectItem value="require">require</SelectItem>
                                        <SelectItem value="verify-full">verify-full</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                        <Button type="submit" disabled={busy} className="self-start">
                            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                            {t("modals.connect_database.connect", { defaultValue: "Connect" })}
                        </Button>
                    </div>
                )}

                {busy && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                        <Loader2 className="size-4 animate-spin" /> {phaseLabel[phase]}
                    </p>
                )}
                {error && (
                    <div className="space-y-1 text-sm" role="alert">
                        <p className="flex items-start gap-1 break-words text-destructive">
                            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" /> <span className="min-w-0">{error}</span>
                        </p>
                        {notes.map((note) => (
                            <p key={note} className="pl-5 text-xs text-muted-foreground">{note}</p>
                        ))}
                    </div>
                )}

                {(saved.length > 0 || listError) && (
                    <div className="space-y-1.5 border-t pt-3">
                        <p className="text-xs font-medium text-muted-foreground">{t("modals.connect_database.saved", { defaultValue: "Saved connections" })}</p>
                        {listError && <p className="break-words text-xs text-destructive">{listError}</p>}
                        <ul className="flex max-h-[220px] min-w-0 flex-col gap-1.5 overflow-y-auto">
                            {saved.map((connection) => (
                                <li key={connection.id} className="flex min-w-0 items-center justify-between gap-2 rounded-md border p-2">
                                    {renaming?.id === connection.id ? (
                                        <>
                                            <Input
                                                value={renaming.name}
                                                onChange={(event) => setRenaming({ id: connection.id, name: event.target.value })}
                                                onKeyDown={(event) => {
                                                    // Enter must not submit the connection-string form around this list.
                                                    if (event.key === "Enter") {
                                                        event.preventDefault();
                                                        void saveRename();
                                                    }
                                                }}
                                                onFocus={(event) => event.currentTarget.select()}
                                                ref={(element) => element?.focus()}
                                                maxLength={100}
                                                aria-label={t("modals.connect_database.rename_label", { defaultValue: "Connection name" })}
                                                className="h-8 min-w-0 flex-1"
                                            />
                                            <Button type="button" size="sm" variant="outline" disabled={!renaming.name.trim()} onClick={() => void saveRename()} aria-label={t("modals.connect_database.rename_save", { defaultValue: "Save name" })} className="shrink-0">
                                                <Check className="size-4" />
                                            </Button>
                                            <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(undefined)} aria-label={t("modals.connect_database.rename_cancel", { defaultValue: "Cancel rename" })} className="shrink-0">
                                                <X className="size-4" />
                                            </Button>
                                        </>
                                    ) : (
                                        <>
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-medium" title={connection.name}>{connection.name}{connection.kind === "cloud" && <span className="ml-2 rounded border px-1 py-0.5 text-[10px] font-normal text-muted-foreground">cloud</span>}</p>
                                                <p className="truncate text-xs text-muted-foreground" title={`${connection.username}@${connection.host}:${connection.port}/${connection.database}`}>
                                                    {connection.username}@{connection.host}:{connection.port}/{connection.database}
                                                </p>
                                            </div>
                                            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void attempt((onPhase) => connectSaved(connection, onPhase))} aria-label={t("modals.connect_database.connect_named", { defaultValue: "Connect to {{name}}", name: connection.name })} className="shrink-0">
                                                <Plug className="size-4" /> <span className="hidden sm:inline">{t("modals.connect_database.connect", { defaultValue: "Connect" })}</span>
                                            </Button>
                                            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setRenaming({ id: connection.id, name: connection.name })} aria-label={t("modals.connect_database.rename", { defaultValue: "Rename this connection" })} title={t("modals.connect_database.rename", { defaultValue: "Rename this connection" })} className="shrink-0">
                                                <Pencil className="size-4" />
                                            </Button>
                                            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void onDeleteSaved(connection)} aria-label={connection.kind === "cloud" ? `Delete the database ${connection.name}` : t("modals.connect_database.forget", { defaultValue: "Forget this connection" })} className="shrink-0">
                                                <Trash2 className="size-4 text-destructive" />
                                            </Button>
                                        </>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <div className="flex flex-col gap-1 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
                    <Button type="button" variant="link" size="sm" className="h-auto justify-start p-0 text-xs" disabled={busy} onClick={() => { setError(undefined); setNotes([]); setMode(mode === "string" ? "details" : "string"); }}>
                        {mode === "string"
                            ? t("modals.connect_database.use_fields", { defaultValue: "Enter host, user and password instead" })
                            : t("modals.connect_database.use_string", { defaultValue: "Use a connection string instead" })}
                    </Button>
                    <Button type="button" variant="link" size="sm" className="h-auto justify-start p-0 text-xs text-muted-foreground" disabled={busy} onClick={startEmpty}>
                        {t("modals.connect_database.start_empty", { defaultValue: "Start with an empty diagram instead" })}
                    </Button>
                </div>
            </form>
        </Modal>
    );
};

export default ConnectDatabaseModal;
