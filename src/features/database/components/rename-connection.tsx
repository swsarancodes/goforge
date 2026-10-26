import React, { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SavedConnection, renameSavedConnection } from "@/lib/live-connection-api";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { connectionOfDiagram, diagramsOfConnection, linkDiagram } from "../live-link";

interface RenameConnectionProps {
    connection: SavedConnection | undefined;
    /** Called with the renamed connection, so the page can show the new name. */
    onRenamed: (connection: SavedConnection) => void;
}

/**
 * A pencil beside a connection picker. A database made together with a diagram keeps the diagram's name in step: renaming it here renames
 * that diagram too. For one that is not linked yet, the open diagram can be renamed and linked in the same step.
 */
export const RenameConnection: React.FC<RenameConnectionProps> = ({ connection, onRenamed }) => {
    const { database } = useDatabase();
    const { editDatabase } = useDatabaseOperations();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [withDiagram, setWithDiagram] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    if (!connection) return null;

    const linkedHere = !!database && connectionOfDiagram(database.id) === connection.id;
    const offerDiagram = !!database && !linkedHere;

    const show = () => {
        setName(connection.name);
        setWithDiagram(false);
        setError(undefined);
        setOpen(true);
    };

    const save = async () => {
        const next = name.trim();
        if (!next || next === connection.name) return setOpen(false);
        setSaving(true);
        setError(undefined);
        try {
            const renamed = await renameSavedConnection(connection.id, next);
            onRenamed({ ...connection, ...renamed });
            const diagrams = new Set(diagramsOfConnection(connection.id));
            if (database && withDiagram) {
                diagrams.add(database.id);
                linkDiagram(database.id, connection.id);
            }
            for (const id of diagrams) await editDatabase({ id, name: next });
            setOpen(false);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" onClick={show} aria-label="Rename the database" title="Rename the database">
                <Pencil className="size-3.5" />
            </Button>
            <Dialog open={open} onOpenChange={(value) => !saving && setOpen(value)}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Rename the database</DialogTitle>
                        <DialogDescription>
                            {linkedHere ? `The diagram “${database?.name}” was made with this database and follows its name.` : "This changes the name GoForge shows for it. The data is not touched."}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <Label htmlFor="rename-connection-name" className="text-xs text-muted-foreground">Name</Label>
                            <Input id="rename-connection-name" value={name} maxLength={100} autoFocus onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void save()} />
                        </div>
                        {offerDiagram && (
                            <label htmlFor="rename-connection-diagram" className="flex cursor-pointer items-start gap-2 text-xs">
                                <Switch id="rename-connection-diagram" checked={withDiagram} onCheckedChange={setWithDiagram} className="mt-0.5" />
                                <span>
                                    <strong className="block">Also rename the open diagram “{database?.name}”</strong>
                                    <span className="text-muted-foreground">The two stay together: renaming either one renames the other.</span>
                                </span>
                            </label>
                        )}
                        {error && <p className="text-xs text-destructive">{error}</p>}
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
                        <Button onClick={() => void save()} disabled={saving || name.trim().length === 0}>Save</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
};
