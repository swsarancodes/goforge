import Modal, { ModalProps } from "@/components/modal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import useToast from "@/hooks/use-toast";
import { DatabaseDialect, DBTypes } from "@/lib/database";
import { DataType, data_types } from "@/lib/schemas/data-type-schema";
import { cn } from "@/lib/utils";
import { useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { db } from "@/providers/sync-provider/sync-provider";
import { DbmlParseError, parseDbml } from "@/utils/dbml/from-dbml";
import { DbmlWarning, detectDbmlDialect } from "@/utils/dbml/dbml-shared";
import { layoutProjectFile } from "@/utils/dbml/layout-project";
import { MAX_IMPORT_FILE_BYTES, readTextFile } from "@/utils/file";
import { ProjectFile, ProjectFileError, parseProjectFile, projectToBundle, summarizeProject } from "@/utils/project-file";
import { eq } from "drizzle-orm";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { AlertCircleIcon, AlertTriangle, FileJson, Upload } from "lucide-react";
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
    // A DBML file has no dialect of its own to trust, so keep the text and let the user re-read it as another dialect.
    const [dbml, setDbml] = useState<{ text: string; fileName: string; dialect: DatabaseDialect } | undefined>(undefined);
    const [warnings, setWarnings] = useState<DbmlWarning[]>([]);
    const latestRequest = useRef(0);

    const knownTypes = useCallback(
        async (dialect: string) => (await db.select().from(data_types).where(eq(data_types.dialect, dialect as any))) as unknown as DataType[],
        [],
    );

    const convertDbml = useCallback(async (text: string, fileName: string, dialect: DatabaseDialect) => {
        const request = ++latestRequest.current;
        setError(undefined);
        setFile(undefined);
        setWarnings([]);
        setDbml({ text, fileName, dialect });
        try {
            const dataTypes = await knownTypes(dialect);
            const result = await parseDbml(text, { dialect, dataTypes, fallbackName: fileName.replace(/\.dbml$/i, "") });
            // Same validation as a JSON project, so both formats are held to one standard.
            const validated = parseProjectFile(JSON.stringify(result.file), new Set(dataTypes.map((type) => type.id as string)));
            const laidOut = await layoutProjectFile(validated);
            if (request !== latestRequest.current) return;
            setFile(laidOut);
            setName(laidOut.project.name);
            setWarnings(result.warnings);
        } catch (caught) {
            if (request !== latestRequest.current) return;
            setError({
                message: caught instanceof Error ? caught.message : String(caught),
                details: caught instanceof DbmlParseError || caught instanceof ProjectFileError ? caught.details : [],
            });
        }
    }, [knownTypes]);

    const loadFile = useCallback(async (selected: File | undefined) => {
        if (!selected) return;
        setError(undefined);
        setFile(undefined);
        setDbml(undefined);
        setWarnings([]);
        setFileName(selected.name);
        try {
            if (selected.size > MAX_IMPORT_FILE_BYTES) throw new ProjectFileError("This file is larger than 5 MB.");
            const text = await readTextFile(selected);
            if (/\.dbml$/i.test(selected.name)) {
                await convertDbml(text, selected.name, detectDbmlDialect(text) ?? DatabaseDialect.POSTGRES);
                return;
            }
            // Peek at the dialect first so type ids can be checked against the right catalogue.
            let dialect: string | undefined;
            try { dialect = JSON.parse(text)?.project?.dialect; } catch { /* reported by parseProjectFile */ }
            const knownTypeIds = dialect
                ? new Set((await knownTypes(dialect)).map((row) => row.id as string))
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
    }, [convertDbml, knownTypes]);

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
            description={t("modals.import_project.description", { defaultValue: "Open a .goforge.json backup or a .dbml file as a new project. Your current project is not changed." })}
            actionName={t("modals.import_project.import", { defaultValue: "Import" })}
            actionHandler={onImport}
            isDisabled={!file || !name.trim()}
            className="md:min-w-[520px] w-full"
        >
            <div className="flex flex-col gap-4">
                <input
                    ref={inputRef}
                    type="file"
                    accept=".json,.dbml,application/json"
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
                    <span>{fileName ?? t("modals.import_project.drop", { defaultValue: "Drop a .goforge.json or .dbml file here, or click to choose one" })}</span>
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

                {dbml && (
                    <div className="space-y-2">
                        <Label>{t("modals.import_project.dialect", { defaultValue: "Read this DBML as" })}</Label>
                        <RadioGroup
                            value={dbml.dialect}
                            onValueChange={(value) => void convertDbml(dbml.text, dbml.fileName, value as DatabaseDialect)}
                            className="flex flex-wrap gap-2"
                            data-testid="import-dbml-dialect"
                        >
                            {DBTypes.map((type) => (
                                <Label
                                    key={type.dialect}
                                    htmlFor={`import-dialect-${type.dialect}`}
                                    className={cn("h-8 cursor-pointer rounded-md border px-3 flex items-center hover:bg-secondary", dbml.dialect === type.dialect && "border-primary bg-primary/20")}
                                >
                                    <RadioGroupItem id={`import-dialect-${type.dialect}`} value={type.dialect} className="sr-only" />
                                    {type.name}
                                </Label>
                            ))}
                        </RadioGroup>
                    </div>
                )}

                {warnings.length > 0 && (
                    <Alert data-testid="import-project-warnings">
                        <AlertTriangle />
                        <AlertTitle>
                            {t("modals.import_project.warnings", { count: warnings.length, defaultValue: "{{count}} things could not be carried over" })}
                        </AlertTitle>
                        <AlertDescription>
                            <ul className="mt-1 max-h-32 list-disc space-y-1 overflow-auto pl-4 text-xs">
                                {warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}
                            </ul>
                        </AlertDescription>
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
                    <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => { latestRequest.current++; setFile(undefined); setFileName(undefined); setDbml(undefined); setWarnings([]); setError(undefined); }}>
                        {t("modals.import_project.choose_another", { defaultValue: "Choose another file" })}
                    </Button>
                )}
            </div>
        </Modal>
    );
};

export default React.memo(ImportProjectModal);
