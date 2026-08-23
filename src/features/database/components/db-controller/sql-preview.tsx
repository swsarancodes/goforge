import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { DatabaseType } from "@/lib/schemas/database-schema";
import CircularDependencyAlert from "./circular-dependecy-alert";
import { useTranslation } from "react-i18next";
import Clipboard from "@/components/clipboard";
import { TableType } from "@/lib/schemas/table-schema";
import { RelationshipType } from "@/lib/schemas/relationship-schema";

import BaseDatabaseRenderer from "@/utils/render/database/base-database-renderer";
import { CircularDependencyError, getRenderer } from "@/utils/render/render-uttils";
import { areArraysEqual } from "@/utils/utils";
import CodeEditor from "@/components/code-editor";
import useToast from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { AlertCircleIcon, AlertTriangle, Check, Code2, Loader2, Pencil, X } from "lucide-react";
import { PreparedSqlSchemaChange, prepareSqlSchemaChange } from "@/utils/import/prepare-sql-schema-change";
import { DBDiffOperation } from "@/utils/database";

const SQL_OPERATION_LABELS: Record<string, string> = {
    RENAME_DATABASE: "database rename(s)",
    CREATE_TABLE: "table(s) added",
    DELETE_TABLE: "table(s) removed",
    UPDATE_TABLE: "table(s) updated",
    CREATE_FIELD: "field(s) added",
    DELETE_FIELD: "field(s) removed",
    UPDATE_FIELD: "field(s) updated",
    CREATE_RELATIONSHIP: "relationship(s) added",
    DELETE_RELATIONSHIP: "relationship(s) removed",
    UPDATE_RELATIONSHIP: "relationship(s) updated",
    CREATE_INDEX: "index(es) added",
    DELETE_INDEX: "index(es) removed",
    UPDATE_INDEX: "index(es) updated",
    UPDATE_FIELD_INDICES: "index column set(s) updated",
    UPDATE_NUM_TABLES: "table count update(s)",
};

const summarizeOperations = (operations: PreparedSqlSchemaChange["operations"]) => {
    const counts = operations.reduce<Record<string, number>>((summary, operation) => {
        summary[operation.type] = (summary[operation.type] ?? 0) + 1;
        return summary;
    }, {});

    return Object.entries(counts)
        .map(([type, count]) => `${count} ${SQL_OPERATION_LABELS[type] ?? "schema change(s)"}`)
        .join(", ");
};

const summarizeDestructiveOperations = (prepared: PreparedSqlSchemaChange) => {
    const destructiveLabels: Record<string, string> = {
        DELETE_TABLE: "table(s)",
        DELETE_FIELD: "field(s)",
        DELETE_RELATIONSHIP: "relationship(s)",
        DELETE_INDEX: "index(es)",
    };
    const counts = prepared.destructiveOperations.reduce<Record<string, number>>((summary, operation) => {
        summary[operation.type] = (summary[operation.type] ?? 0) + 1;
        return summary;
    }, {});

    return Object.entries(counts)
        .map(([type, count]) => `${count} ${destructiveLabels[type] ?? "object(s)"}`)
        .join(", ");
};

const describeSqlOperation = (operation: DBDiffOperation, currentDatabase: DatabaseType, prepared: PreparedSqlSchemaChange) => {
    const tables = [...currentDatabase.tables, ...prepared.targetDatabase.tables];
    const tableName = (tableId: string) => tables.find((table) => table.id === tableId)?.name ?? tableId;
    const fieldName = (tableId: string, fieldId: string) => tables.find((table) => table.id === tableId)?.fields.find((field) => field.id === fieldId)?.name ?? fieldId;

    switch (operation.type) {
        case "CREATE_TABLE":
            return `Add table ${operation.table.name}`;
        case "DELETE_TABLE":
            return `Remove table ${tableName(operation.tableId)}`;
        case "UPDATE_TABLE":
            return `Update table ${tableName(operation.tableId)}: ${Object.keys(operation.changes).join(", ")}`;
        case "CREATE_FIELD":
            return `Add field ${tableName(operation.tableId)}.${operation.field.name}`;
        case "DELETE_FIELD":
            return `Remove field ${tableName(operation.tableId)}.${fieldName(operation.tableId, operation.fieldId)}`;
        case "UPDATE_FIELD":
            return `Update field ${tableName(operation.tableId)}.${fieldName(operation.tableId, operation.fieldId)}: ${Object.keys(operation.changes).join(", ")}`;
        case "CREATE_INDEX":
            return `Add index ${operation.index.name}`;
        case "DELETE_INDEX":
            return `Remove index from ${tableName(operation.tableId)}`;
        case "UPDATE_INDEX":
            return `Update index on ${tableName(operation.tableId)}: ${Object.keys(operation.changes).join(", ")}`;
        case "CREATE_RELATIONSHIP":
            return `Add relationship ${operation.relationship.name ?? operation.relationship.id}`;
        case "DELETE_RELATIONSHIP":
            return `Remove relationship ${operation.relationshipId}`;
        case "UPDATE_RELATIONSHIP":
            return `Update relationship: ${Object.keys(operation.changes).join(", ")}`;
        case "UPDATE_FIELD_INDICES":
            return `Update index columns on ${tableName(operation.tableId)}`;
        case "UPDATE_NUM_TABLES":
            return `Set table count to ${operation.value}`;
        case "RENAME_DATABASE":
            return `Rename database to ${operation.chnages.name}`;
    }
};

interface SqlPreviewProps {
    tableFilterIds?: string[];
    className?: string;
    // Editing replaces the entire current database with the parsed SQL, so it's
    // only offered when this preview isn't scoped to a filtered subset of tables -
    // applying edits from a partial view would read as deleting everything else.
    editable?: boolean;
    startEditing?: boolean;
}

const SqlPreview: React.FC<SqlPreviewProps> = ({ tableFilterIds, className, editable = false, startEditing = false }) => {
    const { database: currentDatabase } = useDatabase();
    const { data_types, executeDbDiffOps } = useDatabaseOperations();
    const [sqlCode, setSqlCode] = useState<string>("");
    const raise = useToast();
    const [circularDependency, setCircularDependency] = useState<CircularDependencyError | undefined>(undefined);

    const [isEditing, setIsEditing] = useState<boolean>(startEditing);
    const [draftSql, setDraftSql] = useState<string>("");
    const [isApplying, setIsApplying] = useState<boolean>(false);
    const [applyError, setApplyError] = useState<string | undefined>(undefined);
    const [preparedChange, setPreparedChange] = useState<PreparedSqlSchemaChange>();
    const [destructiveAccepted, setDestructiveAccepted] = useState(false);

    const database = useMemo(() => {
        if (!tableFilterIds) return currentDatabase;
        return {
            ...currentDatabase,
            tables: currentDatabase?.tables.filter((table: TableType) => tableFilterIds?.includes(table.id)),
            relationships: currentDatabase?.relationships.filter((relationship: RelationshipType) => tableFilterIds?.includes(relationship.sourceTableId) || tableFilterIds?.includes(relationship.targetTableId)),
        } as DatabaseType;
    }, [currentDatabase, tableFilterIds]);

    const { t } = useTranslation();

    useEffect(() => {
        (async () => {
            if (database?.dialect && data_types.length > 0) {
                try {
                    const renderer: BaseDatabaseRenderer = getRenderer(database.dialect, data_types);
                    const sql: string = await renderer.renderDDL(database);

                    setSqlCode(sql);
                    if (startEditing) setDraftSql((current) => current || sql);
                    setCircularDependency(undefined);
                } catch (error) {
                    if ((error as CircularDependencyError)?.cycle)
                        setCircularDependency((previousError) => {
                            if (!previousError) return error as CircularDependencyError;
                            else if (Array.isArray(previousError.cycle) && Array.isArray((error as CircularDependencyError).cycle) && !areArraysEqual(previousError.cycle, (error as CircularDependencyError).cycle)) return error as CircularDependencyError;
                            return previousError;
                        });
                }
            }
        })();
    }, [database, data_types, startEditing]);

    useEffect(() => {
        if (startEditing && editable) {
            setDraftSql((current) => current || sqlCode);
            setApplyError(undefined);
            setIsEditing(true);
        }
    }, [editable, sqlCode, startEditing]);

    useEffect(() => {
        if (circularDependency) raise(t("db_controller.circular_dependency.title"), t("db_controller.circular_dependency.description"), "ERROR");
    }, [circularDependency]);

    const onStartEdit = useCallback(() => {
        setDraftSql(sqlCode);
        setApplyError(undefined);
        setPreparedChange(undefined);
        setDestructiveAccepted(false);
        setIsEditing(true);
    }, [sqlCode]);

    const onCancelEdit = useCallback(() => {
        setIsEditing(false);
        setApplyError(undefined);
        setPreparedChange(undefined);
        setDestructiveAccepted(false);
    }, []);

    const onDraftChange = useCallback((nextSql: string) => {
        setDraftSql(nextSql);
        setApplyError(undefined);
        setPreparedChange(undefined);
        setDestructiveAccepted(false);
    }, []);

    const onApplyEdit = useCallback(async () => {
        if (!currentDatabase) return;
        setApplyError(undefined);

        if (!preparedChange) {
            try {
                const prepared = await prepareSqlSchemaChange(draftSql, currentDatabase, data_types);
                if (prepared.operations.length === 0) {
                    raise("No schema changes", "The pasted SQL already matches the current diagram.");
                    setIsEditing(false);
                    return;
                }
                setPreparedChange(prepared);
            } catch (error) {
                setApplyError(error instanceof Error ? error.message : String(error));
            }
            return;
        }

        if (preparedChange.destructiveOperations.length > 0 && !destructiveAccepted) return;

        setIsApplying(true);
        try {
            await executeDbDiffOps(preparedChange.operations);
            raise("SQL changes applied", `${preparedChange.operations.length} schema operation(s) completed in one transaction.`, "SUCCESS");

            setIsEditing(false);
            setPreparedChange(undefined);
            setDestructiveAccepted(false);
        } catch (error) {
            setApplyError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsApplying(false);
        }
    }, [currentDatabase, data_types, destructiveAccepted, draftSql, executeDbDiffOps, preparedChange, raise]);

    if (circularDependency) return <CircularDependencyAlert error={circularDependency} />;
    else
        return (
            <div className="flex flex-col w-full h-full min-w-0 !min-h-0">
                <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-2">
                    <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
                        <Code2 className="size-4 text-muted-foreground" />
                        <span>{isEditing ? "Paste or edit SQL" : "Generated SQL"}</span>
                    </div>
                    <div className="flex items-center gap-1">
                        {!isEditing && editable && (
                            <Button variant="ghost" size="sm" className="gap-1.5" onClick={onStartEdit}>
                                <Pencil className="size-3.5" /> Edit
                            </Button>
                        )}
                        {isEditing && (
                            <>
                                <Button variant="ghost" size="sm" className="gap-1.5" onClick={onCancelEdit} disabled={isApplying}>
                                    <X className="size-3.5" /> Cancel
                                </Button>
                                <Button size="sm" className="gap-1.5" variant={preparedChange?.destructiveOperations.length ? "destructive" : "default"} onClick={onApplyEdit} disabled={isApplying || !draftSql.trim() || Boolean(preparedChange?.destructiveOperations.length && !destructiveAccepted)}>
                                    {isApplying ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                                    {isApplying ? "Applying…" : preparedChange ? `Apply ${preparedChange.operations.length} change(s)` : "Review SQL"}
                                </Button>
                            </>
                        )}
                        <Clipboard text={isEditing ? draftSql : sqlCode} />
                    </div>
                </div>
                <div className="flex min-h-0 flex-1">
                    <CodeEditor
                        // Remount on entering/leaving edit mode - autoFocus only fires on
                        // mount, and the editor needs real keyboard focus for native
                        // select-all/copy/paste to land inside it instead of being
                        // caught by the app's global Ctrl+A/Ctrl+D shortcuts.
                        key={isEditing ? "editing" : "preview"}
                        defaultValue={isEditing ? draftSql : sqlCode}
                        value={isEditing ? draftSql : sqlCode}
                        onChange={isEditing ? onDraftChange : undefined}
                        readOnly={!isEditing}
                        autoFocus={isEditing}
                        className={className}
                    />
                </div>
                {preparedChange && (
                    <div className="space-y-2 border-t bg-muted/30 px-3 py-2 text-xs">
                        <p className="font-medium">{preparedChange.operations.length} schema change(s) ready to apply</p>
                        <p className="text-muted-foreground">{summarizeOperations(preparedChange.operations)}</p>
                        <ul className="max-h-28 space-y-1 overflow-auto rounded-md border bg-background p-2 text-muted-foreground">
                            {preparedChange.operations.map((operation, index) => (
                                <li key={`${operation.type}-${index}`}>
                                    {index + 1}. {describeSqlOperation(operation, currentDatabase, preparedChange)}
                                </li>
                            ))}
                        </ul>
                        {preparedChange.warnings.length > 0 && (
                            <p className="flex items-start gap-1.5 text-amber-600">
                                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                                The SQL parser reported {preparedChange.warnings.length} warning(s). Review the diagram after applying.
                            </p>
                        )}
                        {preparedChange.destructiveOperations.length > 0 && (
                            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
                                <input type="checkbox" className="mt-0.5 size-4 accent-destructive" checked={destructiveAccepted} onChange={(event) => setDestructiveAccepted(event.target.checked)} />
                                <span>
                                    <strong className="block">I reviewed the destructive changes</strong>
                                    {summarizeDestructiveOperations(preparedChange)} will be removed from the local schema.
                                </span>
                            </label>
                        )}
                    </div>
                )}
                {applyError && (
                    <p className="text-destructive text-sm flex items-center gap-1 border-t px-2 py-2">
                        <AlertCircleIcon className="size-4 shrink-0" /> {applyError}
                    </p>
                )}
            </div>
        );
};

export default React.memo(SqlPreview);
