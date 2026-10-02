
import React, { useCallback, useEffect, useState } from "react";

import { useTranslation } from "react-i18next";
import { TableInsertType, TableType } from "@/lib/schemas/table-schema";
import { useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { v4 } from "uuid";
import { getNextSequence } from "@/utils/field";
import { useDiagram, useDiagramOps } from "@/providers/diagram-provider/diagram-provider";
import hash from "object-hash";
import { cloneTable } from "@/utils/tables";
import { IndexInsertType } from "@/lib/schemas/index-schema";
import { FieldInsertType } from "@/lib/schemas/field-schema";
import { AccordionTrigger } from "@/components/ui/accordion";
import { IconBolt, IconCheck, IconCopy, IconDotsVertical, IconFocus2, IconFolder, IconGripVertical, IconPencil, IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenuTrigger, DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem, DropdownMenuShortcut } from "@/components/ui/dropdown-menu";
import { useSortable } from "@dnd-kit/sortable";



export interface TableAccordionHeaderProps {
    table: TableType,
    isOpen?: boolean,
}


const TableAccordionHeader: React.FC<TableAccordionHeaderProps> = ({ table, isOpen }) => {

    const { editTable, deleteTable, createField, createTable, createIndex, getInteger } = useDatabaseOperations();

    const [tableName, setTableName] = useState<string>(table.name);
    const { t } = useTranslation();
    const [editMode, setEditMode] = useState<boolean>(false);
    const { focusOnTable } = useDiagramOps();
    const { aiPreview } = useDiagram();
    const aiPreviewActive = Boolean(aiPreview);

    useEffect(() => {
        setTableName(table.name);
    }, [table.name])

    const saveTableName = useCallback(async () => {
        await editTable({ id: table.id, name: tableName } as TableInsertType);
        setEditMode(false);
    }, [tableName])

    const onDeleteTable = useCallback(async (event: any) => {
        event.stopPropagation();
        await deleteTable(table.id);

    }, [deleteTable, table.id]);

    const addField = useCallback((event: any) => {
        event.stopPropagation();


        createField({
            id: v4(),
            name: `field_${table.fields.length + 1}`,
            tableId: table.id,
            sequence: getNextSequence(table.fields),
            nullable: true,
            typeId: getInteger()?.id
        } as FieldInsertType)

    }, [table, getInteger])

    const addIndex = useCallback((event: any) => {
        event.stopPropagation();
        createIndex({
            id: v4(),
            name: `index_${table.indices.length + 1}`,
            unique: false,
            tableId: table.id
        } as IndexInsertType);
 
    }, [table])

    const duplicate = useCallback(async (event : any) => {
        event.stopPropagation()
        const clonedTable: TableType = cloneTable(table);
        await createTable(clonedTable)
        focusOnTable(clonedTable.id);
    }, [table]);


    const { listeners } = useSortable({ id: table.id });




    return (
        <div className="group flex w-full items-center gap-2">
            {!editMode ? (
                <AccordionTrigger
                    className="h-12 min-w-0 flex-1 py-3"
                    leftContent={
                        <div
                            className="h-full w-1 shrink-0 rounded-lg bg-secondary bg-primary"
                            style={{ backgroundColor: table.color as string }}
                        />
                    }
                >
                    <div {...listeners} onClick={(event) => event.stopPropagation()}>
                        <IconGripVertical className="size-4 shrink-0 cursor-move text-muted-foreground hover:text-foreground" />
                    </div>
                    <div className="flex min-w-0 w-full items-center">
                        <span
                            className="max-w-60 cursor-pointer truncate py-2 text-sm"
                            onDoubleClick={(event) => {
                                event.stopPropagation();
                                setEditMode(true);
                            }}
                        >
                            {table.namespace ? `${table.namespace}.${tableName}` : tableName}
                        </span>
                    </div>
                </AccordionTrigger>
            ) : (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div {...listeners} onClick={(event) => event.stopPropagation()}>
                        <IconGripVertical className="size-4 shrink-0 cursor-move text-muted-foreground hover:text-foreground" />
                    </div>
                    <Input
                        placeholder="Table name"
                        value={tableName}
                        onChange={(event) => setTableName(event.target.value)}
                        onBlur={saveTableName}
                        autoFocus
                        type="text"
                        onClick={(event) => event.stopPropagation()}
                        className="h-8"
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") {
                                event.preventDefault();
                                saveTableName();
                                event.currentTarget.blur();
                            }
                        }}
                    />
                    <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 rounded-sm"
                        aria-label={`Save ${table.name}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            saveTableName();
                        }}
                    >
                        <IconCheck className="size-4 text-muted-foreground" />
                    </Button>
                </div>
            )}

            {!aiPreviewActive && !editMode && (
                <div className="flex shrink-0 flex-row gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button
                        variant="outline"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label={`Edit ${table.name}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            setEditMode(true);
                        }}
                    >
                        <IconPencil className="size-4 text-muted-foreground" />
                    </Button>
                    <Button
                        variant="outline"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label={`Focus ${table.name}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            focusOnTable(table.id, true);
                        }}
                    >
                        <IconFocus2 className="size-4 text-muted-foreground" />
                    </Button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="size-8 shrink-0 rounded-sm"
                                aria-label={`Actions for ${table.name}`}
                                onClick={(event) => event.stopPropagation()}
                            >
                                <IconDotsVertical className="size-4 text-muted-foreground" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="min-w-[164px]">
                            <DropdownMenuLabel>{t("db_controller.table_actions")}</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={addField}>
                                {t("db_controller.add_field")}
                                <DropdownMenuShortcut><IconFolder className="size-4" /></DropdownMenuShortcut>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={addIndex}>
                                {t("db_controller.add_index")}
                                <DropdownMenuShortcut><IconBolt className="size-4" /></DropdownMenuShortcut>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={duplicate}>
                                {t("db_controller.duplicate")}
                                <DropdownMenuShortcut><IconCopy className="size-4" /></DropdownMenuShortcut>
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={onDeleteTable}>
                                {t("db_controller.delete_table")}
                                <DropdownMenuShortcut><IconTrash className="size-4 text-destructive" /></DropdownMenuShortcut>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}
        </div>
    )
}


export default React.memo(TableAccordionHeader, (prevState, newState) => {
    return hash(prevState) == hash(newState);
});
