import Modal, { ModalProps } from "@/components/modal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import useToast from "@/hooks/use-toast";
import { data_types } from "@/lib/schemas/data-type-schema";
import { cn } from "@/lib/utils";
import { useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { db } from "@/providers/sync-provider/sync-provider";
import { MAX_IMPORT_FILE_BYTES, readTextFile } from "@/utils/file";
import { ProjectFile, ProjectFileError, parseProjectFile, projectToBundle, summarizeProject } from "@/utils/project-file";
import { eq } from "drizzle-orm";
import { AlertCircleIcon, FileJson, Upload } from "lucide-react";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { v4 } from "uuid";

const ImportProjectModal: React.FC<Omit<ModalProps, "title" | "children">> = ({ isOpen, onOpenChange }) => {
    const { t } = useTranslation();
    const raise = useToast();
    const { importProject, switchDatabase } = useDatabaseOperations();

    const inputRef = useRef<HTMLInputElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [file, setFile] = useState<ProjectFile | undefined>(undefined);
    const [fileName, setFileName] = useState<string | undefined>(undefined);
    const [name, setName] = useState("");
    const [error, setError] = useState<{ message: string; details: string[] } | undefined>(undefined);

    const loadFile = useCallback(async (selected: File | undefined) => {
        if (!selected) return;
        setError(undefined);
        setFile(undefined);
        setFileName(selected.name);
        try {
            if (selected.size > MAX_IMPORT_FILE_BYTES) throw new ProjectFileError("This file is larger than 5 MB.");
            const text = await readTextFile(selected);
            // Peek at the dialect first so type ids can be checked against the right catalogue.
            let dialect: string | undefined;
            try { dialect = JSON.parse(text)?.project?.dialect; } catch { /* reported by parseProjectFile */ }
            const knownTypeIds = dialect
                ? new Set((await db.select({ id: data_types.id }).from(data_types).where(eq(data_types.dialect, dialect as any))).map((row) => row.id as string))
                : undefined;
            const parsed = parseProjectFile(text, knownTypeIds && knownTypeIds.size > 0 ? knownTypeIds : undefined);
            setFile(parsed);
            setName(parsed.project.name);
        } catch (caught) {
            setError({
                message: caught instanceof Error ? caught.message : String(caught),
                details: caught instanceof ProjectFileError ? caught.details : [],
            });
        }
    }, []);

    const summary = useMemo(() => (file ? summarizeProject(file) : undefined), [file]);

    const onImport = useCallback(async () => {
        if (!file || !name.trim()) return;
        try {
            const newId = await importProject(projectToBundle(file, v4, name.trim()));
            switchDatabase(newId);
            onOpenChange?.(false);
            raise(t("modals.import_project.done", { defaultValue: "Project imported" }), name.trim(), "SUCCESS");
        } catch (caught) {
            raise(
                t("modals.import_project.failed", { defaultValue: "Could not import the project" }),
                caught instanceof Error ? caught.message : String(caught),
                "ERROR",
            );
        }
    }, [file, name, importProject, switchDatabase, onOpenChange, raise, t]);

    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title={t("modals.import_project.title", { defaultValue: "Import project" })}
            description={t("modals.import_project.description", { defaultValue: "Open a .goforge.json backup as a new project. Your current project is not changed." })}
            actionName={t("modals.import_project.import", { defaultValue: "Import" })}
            actionHandler={onImport}
            isDisabled={!file || !name.trim()}
            className="md:min-w-[520px] w-full"
        >
            <div className="flex flex-col gap-4">
                <input
                    ref={inputRef}
                    type="file"
                    accept=".json,application/json"
                    className="sr-only"
                    data-testid="import-project-input"
                    onChange={(event) => {
                        void loadFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={(event) => {
                        event.preventDefault();
                        setIsDragging(false);
                        void loadFile(event.dataTransfer.files?.[0]);
                    }}
                    className={cn(
                        "flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-8 text-sm text-muted-foreground hover:bg-secondary/50",
                        isDragging && "border-primary bg-primary/10",
                    )}
                >
                    {fileName ? <FileJson className="size-6" /> : <Upload className="size-6" />}
                    <span>{fileName ?? t("modals.import_project.drop", { defaultValue: "Drop a .goforge.json file here, or click to choose one" })}</span>
                </button>

                {error && (
                    <Alert variant="destructive">
                        <AlertCircleIcon />
                        <AlertTitle>{error.message}</AlertTitle>
                        {error.details.length > 0 && (
                            <AlertDescription>
                                <ul className="mt-1 max-h-32 list-disc space-y-1 overflow-auto pl-4 font-mono text-xs">
                                    {error.details.map((detail) => <li key={detail}>{detail}</li>)}
                                </ul>
                            </AlertDescription>
                        )}
                    </Alert>
                )}

                {file && summary && (
                    <div className="space-y-3">
                        <div className="space-y-2">
                            <Label htmlFor="import-project-name">{t("modals.import_project.name", { defaultValue: "Project name" })}</Label>
                            <Input id="import-project-name" value={name} onChange={(event) => setName(event.target.value)} />
                        </div>
                        <p className="text-sm text-muted-foreground" data-testid="import-project-summary">
                            {file.project.dialect} · {summary.tables} tables · {summary.fields} fields · {summary.relationships} relationships · {summary.indexes} indexes{summary.checks > 0 && ` · ${summary.checks} checks`}
                            {summary.views > 0 && ` · ${summary.views} views`}
                            {summary.sequences > 0 && ` · ${summary.sequences} sequences`}
                        </p>
                    </div>
                )}

                {file && (
                    <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => { setFile(undefined); setFileName(undefined); }}>
                        {t("modals.import_project.choose_another", { defaultValue: "Choose another file" })}
                    </Button>
                )}
            </div>
        </Modal>
    );
};

export default React.memo(ImportProjectModal);
