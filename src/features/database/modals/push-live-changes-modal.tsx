import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal, { ModalProps } from "@/components/modal";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { AlertCircleIcon, CheckCircle2, Loader2 } from "lucide-react";
import CodeEditor from "@/components/code-editor";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { getRenderer } from "@/utils/render/render-uttils";
import { fromIntrospection } from "@/utils/import/from-introspection";
import {
    SavedConnection,
    executeSql,
    introspectSavedConnection,
    listSavedConnections,
    previewSql,
} from "@/lib/live-connection-api";
import { DatabaseType } from "@/lib/schemas/database-schema";

const PushLiveChangesModal: React.FC<ModalProps> = (props) => {
    const { t } = useTranslation();
    const { isOpen, onOpenChange } = props;

    const { database } = useDatabase();
    const { data_types } = useDatabaseOperations();

    const [connections, setConnections] = useState<SavedConnection[]>([]);
    const [connectionId, setConnectionId] = useState<string | undefined>(undefined);

    const [sql, setSql] = useState<string>("");
    const [isGenerating, setIsGenerating] = useState<boolean>(false);
    const [generateError, setGenerateError] = useState<string | undefined>(undefined);

    const [validation, setValidation] = useState<{ valid: boolean; error?: string } | undefined>(undefined);
    const [isValidating, setIsValidating] = useState<boolean>(false);
    const [applySuccess, setApplySuccess] = useState<boolean>(false);

    useEffect(() => {
        if (isOpen) listSavedConnections().then(setConnections).catch(() => setConnections([]));
    }, [isOpen]);

    const generateDiff = useCallback(async (id: string) => {
        if (!database) return;
        setIsGenerating(true);
        setGenerateError(undefined);
        setValidation(undefined);
        setApplySuccess(false);
        try {
            const introspection = await introspectSavedConnection(id);
            const { tables, relationships, indexes, errors } = fromIntrospection(introspection, data_types);
            if (errors.length > 0) console.warn("fromIntrospection encountered non-fatal issues:", errors);

            for (const table of tables) {
                (table as any).indices = indexes.filter((idx: any) => idx.tableId === table.id);
            }

            const liveDatabase: DatabaseType = {
                id: database.id,
                name: database.name,
                dialect: database.dialect,
                numOfTables: tables.length,
                createdAt: null,
                tables: tables as any,
                relationships: relationships as any,
            } as DatabaseType;

            const renderer = getRenderer(database.dialect, data_types);
            const generated = await renderer!.renderDiffDDL(database, liveDatabase);
            setSql(generated);
        } catch (error) {
            setGenerateError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsGenerating(false);
        }
    }, [database, data_types]);

    const onConnectionChange = (id: string) => {
        setConnectionId(id);
        generateDiff(id);
    };

    const onValidate = useCallback(async () => {
        if (!connectionId || !sql.trim()) return;
        setIsValidating(true);
        setApplySuccess(false);
        try {
            const result = await previewSql(connectionId, sql);
            setValidation(result);
        } catch (error) {
            setValidation({ valid: false, error: error instanceof Error ? error.message : String(error) });
        } finally {
            setIsValidating(false);
        }
    }, [connectionId, sql]);

    const onApply = useCallback(async () => {
        if (!connectionId || !sql.trim()) return;
        // Always re-validate immediately before applying - the live schema could have
        // changed since the diff was generated, and this is the last safety check
        // before anything real executes.
        const check = await previewSql(connectionId, sql);
        setValidation(check);
        if (!check.valid) return;

        await executeSql(connectionId, sql);
        setApplySuccess(true);
    }, [connectionId, sql]);

    const hasChanges = sql.trim().length > 0;

    return (
        <Modal
            {...props}
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title={t("modals.push_live_changes.title")}
            description={t("modals.push_live_changes.description")}
            className="lg:min-w-[860px] w-full max-h-screen overflow-auto"
            actionName={t("modals.push_live_changes.apply")}
            actionHandler={hasChanges ? onApply : undefined}
            isDisabled={!hasChanges || isGenerating}
        >
            <div className="flex flex-col gap-3">
                <div className="space-y-1">
                    <Label>{t("modals.connect_live_database.title")}</Label>
                    <Select value={connectionId} onValueChange={onConnectionChange}>
                        <SelectTrigger>
                            <SelectValue placeholder={t("modals.connect_live_database.no_connections")} />
                        </SelectTrigger>
                        <SelectContent>
                            {connections.map((conn) => (
                                <SelectItem key={conn.id} value={conn.id}>
                                    {conn.name} ({conn.host}:{conn.port}/{conn.database})
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {generateError && (
                    <p className="text-destructive text-sm flex items-center gap-1">
                        <AlertCircleIcon className="size-4" /> {generateError}
                    </p>
                )}

                {isGenerating && (
                    <p className="text-sm text-muted-foreground flex items-center gap-1">
                        <Loader2 className="size-4 animate-spin" /> {t("modals.push_live_changes.preview_loading")}
                    </p>
                )}

                {!isGenerating && connectionId && !hasChanges && !generateError && (
                    <p className="text-sm text-muted-foreground">{t("modals.push_live_changes.no_changes")}</p>
                )}

                {hasChanges && (
                    <>
                        <CodeEditor
                            className="flex w-full min-h-[320px] max-h-[320px] border-1 rounded-md border-divider overflow-hidden"
                            value={sql}
                            onChange={() => {}}
                        />

                        <Button variant="outline" size="sm" onClick={onValidate} disabled={isValidating}>
                            {isValidating ? <Loader2 className="size-4 animate-spin" /> : t("modals.connect_live_database.test")}
                        </Button>

                        {validation && validation.valid && (
                            <p className="text-sm text-primary flex items-center gap-1">
                                <CheckCircle2 className="size-4" /> {t("modals.push_live_changes.valid")}
                            </p>
                        )}
                        {validation && !validation.valid && (
                            <p className="text-destructive text-sm flex items-center gap-1">
                                <AlertCircleIcon className="size-4" /> {t("modals.push_live_changes.invalid")} {validation.error}
                            </p>
                        )}
                        {applySuccess && (
                            <p className="text-sm text-primary flex items-center gap-1">
                                <CheckCircle2 className="size-4" /> {t("modals.push_live_changes.success")}
                            </p>
                        )}
                    </>
                )}
            </div>
        </Modal>
    );
};

export default PushLiveChangesModal;
