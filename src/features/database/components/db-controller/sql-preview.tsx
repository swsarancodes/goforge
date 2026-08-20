
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
import { AlertCircleIcon, Check, Loader2, Pencil, X } from "lucide-react";
import { getImporter } from "@/utils/import/import-utils";
import { reconcileWithDatabase } from "@/utils/import/reconcile-with-database";
import { normalizeDatabase, mapDiffToDBDiffOperation } from "@/utils/database";
import { compare } from "fast-json-patch";
import { getTableNextSequence } from "@/utils/tables";


interface SqlPreviewProps {
    tableFilterIds?: string[] ,
    className? : string ;
    // Editing replaces the entire current database with the parsed SQL, so it's
    // only offered when this preview isn't scoped to a filtered subset of tables -
    // applying edits from a partial view would read as deleting everything else.
    editable?: boolean;
}

const SqlPreview: React.FC<SqlPreviewProps> = ({ tableFilterIds , className, editable = false }) => {


    const { database: currentDatabase } = useDatabase();
    const { data_types, executeDbDiffOps } = useDatabaseOperations();
    const [sqlCode, setSqlCode] = useState<string>("");
    const raise = useToast();
    const [circularDependency, setCircularDependency] = useState<CircularDependencyError | undefined>(undefined);

    const [isEditing, setIsEditing] = useState<boolean>(false);
    const [draftSql, setDraftSql] = useState<string>("");
    const [isApplying, setIsApplying] = useState<boolean>(false);
    const [applyError, setApplyError] = useState<string | undefined>(undefined);

    const database = useMemo(() => {
        if (!tableFilterIds)
            return currentDatabase;
        return {
            ...currentDatabase,
            tables: currentDatabase?.tables.filter((table: TableType) => tableFilterIds?.includes(table.id)),
            relationships: currentDatabase?.relationships.filter((relationship: RelationshipType) =>
                tableFilterIds?.includes(relationship.sourceTableId) || tableFilterIds?.includes(relationship.targetFieldId)
            ),
        } as DatabaseType;
    }, [currentDatabase, tableFilterIds])
 
    const { t } = useTranslation();

    useEffect(() => {
        (async () => {

            if (database?.dialect && data_types.length > 0) {

                try {
                    const renderer: BaseDatabaseRenderer = getRenderer(database.dialect, data_types);
                    const sql: string = await renderer.renderDDL(database)

                    setSqlCode(sql);
                    setCircularDependency(undefined);

                } catch (error) {

                    if ((error as CircularDependencyError)?.cycle)
                        setCircularDependency((previousError) => {
                            if (!previousError)
                                return error as CircularDependencyError;
                            else if (Array.isArray(previousError.cycle) && Array.isArray((error as CircularDependencyError).cycle) && !(areArraysEqual(previousError.cycle, (error as CircularDependencyError).cycle)))

                                return error as CircularDependencyError;
                            return previousError;
                        })
                }
            }

        })()
    }, [database, data_types]);



    useEffect(() => {
        if (circularDependency)
            raise(
                t("db_controller.circular_dependency.title"),
                t("db_controller.circular_dependency.description"),
                "ERROR"
            );

    }, [circularDependency]);

    const onStartEdit = useCallback(() => {
        setDraftSql(sqlCode);
        setApplyError(undefined);
        setIsEditing(true);
    }, [sqlCode]);

    const onCancelEdit = useCallback(() => {
        setIsEditing(false);
        setApplyError(undefined);
    }, []);

    const onApplyEdit = useCallback(async () => {
        if (!currentDatabase) return;
        setIsApplying(true);
        setApplyError(undefined);
        try {
            const importer = getImporter(currentDatabase.dialect, data_types);
            if (!importer) throw new Error("No importer available for this dialect");

            const parsed = importer.parseSql(draftSql);
            if (parsed.tables.length === 0) throw new Error("Could not parse any tables from this SQL");

            const reconciled = reconcileWithDatabase(parsed, currentDatabase);

            // Genuinely new tables (no name match in reconcileWithDatabase) come back
            // with posX/posY undefined, which would default to (0, 0) for every one of
            // them - stacked on top of each other. Stagger them in a small grid past
            // the existing tables' bounding box instead.
            const existingTableIds = new Set(currentDatabase.tables.map((t) => t.id));
            const maxX = currentDatabase.tables.reduce((max, t) => Math.max(max, (t.posX ?? 0) + (t.width ?? 260)), 0);
            let nextSequence = getTableNextSequence(currentDatabase.tables);
            let newTableIndex = 0;

            const targetDatabase: DatabaseType = {
                ...currentDatabase,
                tables: reconciled.tables.map((table) => {
                    const indices = reconciled.indexes.filter((index) => index.tableId === table.id);
                    if (existingTableIds.has(table.id as string)) {
                        return { ...table, indices } as any;
                    }
                    const col = newTableIndex % 3;
                    const row = Math.floor(newTableIndex / 3);
                    newTableIndex += 1;
                    return {
                        ...table,
                        posX: table.posX ?? maxX + 80 + col * 320,
                        posY: table.posY ?? row * 280,
                        sequence: nextSequence++,
                        indices,
                    } as any;
                }),
                relationships: reconciled.relationships as any,
            };

            const differences = compare(normalizeDatabase(currentDatabase), normalizeDatabase(targetDatabase));
            if (differences.length > 0) {
                const operations = mapDiffToDBDiffOperation(differences);
                await executeDbDiffOps(operations);
            }

            setIsEditing(false);
        } catch (error) {
            setApplyError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsApplying(false);
        }
    }, [currentDatabase, data_types, draftSql, executeDbDiffOps]);

    if (circularDependency)
        return <CircularDependencyAlert error={circularDependency} />

    else
        return (
            <div className="flex flex-col w-full h-full min-w-0 !min-h-0 gap-2">
                <div className="flex w-full flex-1 relative min-w-0 !min-h-0">
                    <div className="absolute right-2 top-2 z-1 flex items-center gap-1">
                        {!isEditing && editable && (
                            <Button variant="ghost" size="icon" className="size-8" onClick={onStartEdit}>
                                <Pencil className="size-4" />
                            </Button>
                        )}
                        {isEditing && (
                            <>
                                <Button variant="ghost" size="icon" className="size-8" onClick={onCancelEdit} disabled={isApplying}>
                                    <X className="size-4" />
                                </Button>
                                <Button variant="ghost" size="icon" className="size-8" onClick={onApplyEdit} disabled={isApplying}>
                                    {isApplying ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4 text-primary" />}
                                </Button>
                            </>
                        )}
                        <Clipboard text={isEditing ? draftSql : sqlCode} />
                    </div>
                    <CodeEditor
                        // Remount on entering/leaving edit mode - autoFocus only fires on
                        // mount, and the editor needs real keyboard focus for native
                        // select-all/copy/paste to land inside it instead of being
                        // caught by the app's global Ctrl+A/Ctrl+D shortcuts.
                        key={isEditing ? "editing" : "preview"}
                        defaultValue={isEditing ? draftSql : sqlCode}
                        value={isEditing ? draftSql : sqlCode}
                        onChange={isEditing ? setDraftSql : undefined}
                        readOnly={!isEditing}
                        autoFocus={isEditing}
                        className={className}
                    />
                </div>
                {applyError && (
                    <p className="text-destructive text-sm flex items-center gap-1 px-2">
                        <AlertCircleIcon className="size-4 shrink-0" /> {applyError}
                    </p>
                )}
            </div>
        )

}



export default React.memo(SqlPreview); 