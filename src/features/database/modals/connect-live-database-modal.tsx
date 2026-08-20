import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Node } from "@xyflow/react";
import Modal, { ModalProps } from "@/components/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircleIcon, CheckCircle2, Loader2, Plug, Trash2 } from "lucide-react";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { adjustTablesPositions, getTableNextSequence } from "@/utils/tables";
import { fromIntrospection } from "@/utils/import/from-introspection";
import {
    CreateConnectionInput,
    SavedConnection,
    createSavedConnection,
    deleteSavedConnection,
    introspectSavedConnection,
    listSavedConnections,
    testSavedConnection,
} from "@/lib/live-connection-api";
import { TableInsertType } from "@/lib/schemas/table-schema";

type View = "list" | "new";

const EMPTY_FORM: CreateConnectionInput = {
    name: "",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "",
    database: "",
    sslMode: "disable",
};

const ConnectLiveDatabaseModal: React.FC<ModalProps> = (props) => {
    const { t } = useTranslation();
    const { isOpen, onOpenChange } = props;

    const { database } = useDatabase();
    const { data_types, importDatabase } = useDatabaseOperations();

    const [view, setView] = useState<View>("list");
    const [connections, setConnections] = useState<SavedConnection[]>([]);
    const [isLoadingList, setIsLoadingList] = useState<boolean>(false);
    const [listError, setListError] = useState<string | undefined>(undefined);

    const [form, setForm] = useState<CreateConnectionInput>(EMPTY_FORM);
    const [formError, setFormError] = useState<string | undefined>(undefined);

    const [testingId, setTestingId] = useState<string | undefined>(undefined);
    const [testResult, setTestResult] = useState<Record<string, boolean>>({});
    const [connectingId, setConnectingId] = useState<string | undefined>(undefined);
    const [connectError, setConnectError] = useState<string | undefined>(undefined);

    const refreshConnections = useCallback(async () => {
        setIsLoadingList(true);
        setListError(undefined);
        try {
            const result = await listSavedConnections();
            setConnections(result);
        } catch (error) {
            setListError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsLoadingList(false);
        }
    }, []);

    useEffect(() => {
        if (isOpen) refreshConnections();
    }, [isOpen, refreshConnections]);

    const onSaveConnection = useCallback(async () => {
        setFormError(undefined);
        if (!form.name.trim() || !form.host.trim() || !form.database.trim() || !form.username.trim()) {
            setFormError(t("modals.connect_live_database.form_error"));
            return;
        }
        try {
            await createSavedConnection(form);
            setForm(EMPTY_FORM);
            setView("list");
            await refreshConnections();
        } catch (error) {
            setFormError(error instanceof Error ? error.message : String(error));
        }
    }, [form, refreshConnections, t]);

    const onTest = useCallback(async (id: string) => {
        setTestingId(id);
        try {
            const result = await testSavedConnection(id);
            setTestResult((prev) => ({ ...prev, [id]: result.ok }));
        } catch {
            setTestResult((prev) => ({ ...prev, [id]: false }));
        } finally {
            setTestingId(undefined);
        }
    }, []);

    const onDelete = useCallback(async (id: string) => {
        await deleteSavedConnection(id);
        await refreshConnections();
    }, [refreshConnections]);

    const onConnect = useCallback(async (id: string) => {
        setConnectError(undefined);
        setConnectingId(id);
        try {
            const introspection = await introspectSavedConnection(id);
            const { tables, relationships, indexes, errors } = fromIntrospection(introspection, data_types);

            if (errors.length > 0) {
                console.warn("fromIntrospection encountered non-fatal issues:", errors);
            }

            const nextTableSequence = getTableNextSequence(database ? database.tables : []);
            const nodes: Node[] = tables.map((table: TableInsertType) => ({ id: table.id as string, data: { table } })) as any;
            const adjustedTables = await adjustTablesPositions(nodes, relationships as any);

            for (let index = 0; index < adjustedTables.length; index++) {
                adjustedTables[index].sequence = nextTableSequence + index;
            }

            await importDatabase(adjustedTables, relationships, indexes);
            onOpenChange && onOpenChange(false);
        } catch (error) {
            setConnectError(error instanceof Error ? error.message : String(error));
        } finally {
            setConnectingId(undefined);
        }
    }, [data_types, database, importDatabase, onOpenChange]);

    return (
        <Modal
            {...props}
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title={view === "list" ? t("modals.connect_live_database.title") : t("modals.connect_live_database.new_title")}
            description={t("modals.connect_live_database.description")}
            className="lg:min-w-[560px] w-full max-h-screen overflow-auto"
            actionName={view === "new" ? t("modals.save") : undefined}
            actionHandler={view === "new" ? onSaveConnection : undefined}
        >
            {view === "list" && (
                <div className="flex flex-col gap-3">
                    {connectError && (
                        <p className="text-destructive text-sm flex items-center gap-1">
                            <AlertCircleIcon className="size-4" /> {connectError}
                        </p>
                    )}
                    {listError && (
                        <p className="text-destructive text-sm flex items-center gap-1">
                            <AlertCircleIcon className="size-4" /> {listError}
                        </p>
                    )}

                    {isLoadingList && <p className="text-sm text-muted-foreground">{t("modals.loading")}</p>}

                    {!isLoadingList && connections.length === 0 && (
                        <p className="text-sm text-muted-foreground">{t("modals.connect_live_database.no_connections")}</p>
                    )}

                    <div className="flex flex-col gap-2 max-h-[320px] overflow-auto">
                        {connections.map((conn) => (
                            <div key={conn.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
                                <div className="min-w-0">
                                    <p className="font-medium truncate">{conn.name}</p>
                                    <p className="text-xs text-muted-foreground truncate">
                                        {conn.username}@{conn.host}:{conn.port}/{conn.database}
                                    </p>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                    {testResult[conn.id] === true && <CheckCircle2 className="size-4 text-primary" />}
                                    {testResult[conn.id] === false && <AlertCircleIcon className="size-4 text-destructive" />}
                                    <Button variant="outline" size="sm" onClick={() => onTest(conn.id)} disabled={testingId === conn.id}>
                                        {testingId === conn.id ? <Loader2 className="size-4 animate-spin" /> : t("modals.connect_live_database.test")}
                                    </Button>
                                    <Button size="sm" onClick={() => onConnect(conn.id)} disabled={connectingId === conn.id}>
                                        {connectingId === conn.id ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={() => onDelete(conn.id)}>
                                        <Trash2 className="size-4 text-destructive" />
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>

                    <Button variant="outline" onClick={() => setView("new")}>
                        {t("modals.connect_live_database.add_connection")}
                    </Button>
                </div>
            )}

            {view === "new" && (
                <div className="flex flex-col gap-3">
                    {formError && (
                        <p className="text-destructive text-sm flex items-center gap-1">
                            <AlertCircleIcon className="size-4" /> {formError}
                        </p>
                    )}

                    <div className="space-y-1">
                        <Label>{t("modals.connect_live_database.name")}</Label>
                        <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="my-postgres-db" />
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                        <div className="col-span-2 space-y-1">
                            <Label>{t("modals.connect_live_database.host")}</Label>
                            <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                            <Label>{t("modals.connect_live_database.port")}</Label>
                            <Input
                                type="number"
                                value={form.port}
                                onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 0 })}
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                            <Label>{t("modals.connect_live_database.username")}</Label>
                            <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                            <Label>{t("modals.connect_live_database.password")}</Label>
                            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                        </div>
                    </div>

                    <div className="space-y-1">
                        <Label>{t("modals.connect_live_database.database")}</Label>
                        <Input value={form.database} onChange={(e) => setForm({ ...form, database: e.target.value })} />
                    </div>

                    <div className="space-y-1">
                        <Label>{t("modals.connect_live_database.ssl_mode")}</Label>
                        <Select value={form.sslMode} onValueChange={(value) => setForm({ ...form, sslMode: value as CreateConnectionInput["sslMode"] })}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="disable">disable</SelectItem>
                                <SelectItem value="allow">allow</SelectItem>
                                <SelectItem value="require">require</SelectItem>
                                <SelectItem value="verify-full">verify-full</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <Button variant="ghost" size="sm" onClick={() => setView("list")}>
                        {t("modals.back")}
                    </Button>
                </div>
            )}
        </Modal>
    );
};

export default ConnectLiveDatabaseModal;
