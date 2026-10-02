

import { RelationshipInsertType, RelationshipType } from "@/lib/schemas/relationship-schema";
import { useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { useDiagramOps } from "@/providers/diagram-provider/diagram-provider"; 
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import hash from "object-hash";
import { getDefaultRelationshipName } from "@/utils/relationship";
import { AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { IconCheck, IconDotsVertical, IconFocus2, IconPencil, IconTrash } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";


interface RelationshipAccordionTriggerProps {
    isOpen?: boolean;
    relationship: RelationshipType
}

const RelationshipAccordionTrigger: React.FC<RelationshipAccordionTriggerProps> = ({ isOpen, relationship }) => {
    const defaultName: string = useMemo(() => {
        return getDefaultRelationshipName(relationship);
    }, [relationship])


    const [editMode, setEditMode] = useState<boolean>(false);

    const { editRelationship, deleteRelationship } = useDatabaseOperations();
    const { t } = useTranslation();

    
    const [name, setName] = useState<string>(relationship.name ? relationship.name : defaultName);
    const { focusOnRelationship } = useDiagramOps();


    const editRelationshipName = () => {
        if (relationship.name || name.trim().toLocaleLowerCase() != defaultName)
            editRelationship({
                id: relationship.id,
                name
            } as RelationshipInsertType);
        setEditMode(false);
    }

    const onDeleteRelationship = () => {
        deleteRelationship(relationship.id);

    }

    useEffect(() => {
        setName(relationship.name ? relationship.name : defaultName);
    }, [relationship.name]);

    return (
        <div className="group flex w-full items-center gap-2">
            {!editMode ? (
                <AccordionTrigger className="h-12 min-w-0 flex-1 py-3">
                    <div className="flex w-full min-w-0">
                        <span className="max-w-80 cursor-pointer truncate py-2 text-sm">
                            {relationship.name ? relationship.name : defaultName}
                        </span>
                    </div>
                </AccordionTrigger>
            ) : (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Input
                        placeholder="Relationship name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        onBlur={editRelationshipName}
                        autoFocus
                        type="text"
                        onClick={(event) => event.stopPropagation()}
                        className="h-8"
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") {
                                event.preventDefault();
                                editRelationshipName();
                                event.currentTarget.blur();
                            }
                        }}
                    />
                    <Button variant="ghost" size="icon" className="size-8 shrink-0 rounded-sm" onClick={(event) => {
                        event.stopPropagation();
                        editRelationshipName();
                    }}>
                        <IconCheck className="size-4 text-muted-foreground" />
                    </Button>
                </div>
            )}

            {!editMode && (
                <div className="flex shrink-0 flex-row gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button variant="outline" size="icon" className="size-8 shrink-0" aria-label={`Edit ${defaultName}`} onClick={(event) => {
                        event.stopPropagation();
                        setEditMode(true);
                    }}>
                        <IconPencil className="size-4 text-muted-foreground" />
                    </Button>
                    <Button variant="outline" size="icon" className="size-8 shrink-0" aria-label={`Focus ${defaultName}`} onClick={(event) => {
                        event.stopPropagation();
                        focusOnRelationship(relationship.id, true);
                    }}>
                        <IconFocus2 className="size-4 text-muted-foreground" />
                    </Button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8 shrink-0 rounded-sm" aria-label={`Actions for ${defaultName}`} onClick={(event) => event.stopPropagation()}>
                                <IconDotsVertical className="size-4 text-muted-foreground" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="min-w-[164px]">
                            <DropdownMenuLabel>{t("db_controller.actions")}</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={onDeleteRelationship}>
                                {t("db_controller.delete")}
                                <DropdownMenuShortcut>
                                    <IconTrash className="size-4 text-destructive" />
                                </DropdownMenuShortcut>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}
        </div>
 
    )
}


export default React.memo(RelationshipAccordionTrigger, (previousState, newState) => {
    return hash(previousState) == hash(newState);
});
