import Modal, { ModalProps } from "@/components/modal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import useToast from "@/hooks/use-toast";
import { DatabaseDialect, DBTypes } from "@/lib/database";
import { DataType, data_types } from "@/lib/schemas/data-type-schema";
import { cn } from "@/lib/utils";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { db } from "@/providers/sync-provider/sync-provider";
import { DbmlParseError, parseDbml } from "@/utils/dbml/from-dbml";
import { DbmlWarning, detectDbmlDialect } from "@/utils/dbml/dbml-shared";
import { layoutProjectFile } from "@/utils/dbml/layout-project";
import { parseDrawio } from "@/utils/drawio/from-drawio";
import { MAX_IMPORT_FILE_BYTES, readTextFile } from "@/utils/file";
import { prepareProjectFileChange, ProjectImportMode } from "@/utils/import/prepare-project-change";
import { summarizeSchemaChange } from "@/utils/import/summarize-schema-change";
import { useVersionHistoryActions } from "@/hooks/use-version-history";
import ImportReviewPanel from "./import-review-panel";
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
    const { database } = useDatabase();
    const { importProject, switchDatabase, data_types: currentDataTypes } = useDatabaseOperations();
    const { applyRecorded } = useVersionHistoryActions();

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
    // `new` opens the file as its own project; the others change the project that is open, after a review.
    const [mode, setMode] = useState<"new" | ProjectImportMode>("new");
    const [deletionsAccepted, setDeletionsAccepted] = useState(false);
    const [isApplying, setIsApplying] = useState(false);

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
        setMode("new");
        setDeletionsAccepted(false);
        setFileName(selected.name);
        try {
            if (selected.size > MAX_IMPORT_FILE_BYTES) throw new ProjectFileError("This file is larger than 5 MB.");
            const text = await readTextFile(selected);
            if (/\.dbml$/i.test(selected.name)) {
                await convertDbml(text, selected.name, detectDbmlDialect(text) ?? DatabaseDialect.POSTGRES);
                return;
            }
            if (/\.(drawio|xml)$/i.test(selected.name) || /<mxfile|<mxGraphModel/i.test(text)) {
                const targetDialect = database?.dialect ?? DatabaseDialect.POSTGRES;
                const dataTypes = await knownTypes(targetDialect);
                const result = parseDrawio(text, {
                    dialect: targetDialect,
                    dataTypes,
                    fallbackName: selected.name.replace(/\.(drawio|xml)$/i, ""),
                });
                const validated = parseProjectFile(JSON.stringify(result.file), new Set(dataTypes.map((type) => type.id as string)));
                setFile(validated);
                setName(validated.project.name);
                if (result.warnings.length > 0) {
                    setWarnings(result.warnings.map((w) => ({ code: w.code, message: w.message })));
                }
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

    // A file can only be compared with a project of the same dialect (type ids are per dialect).
    const canCompare = Boolean(database && file && file.project.dialect === database.dialect);
    const onModeChange = useCallback((next: "new" | ProjectImportMode) => {
        setMode(next);
        setDeletionsAccepted(false);
        // DBML carries no dialect of its own, so reading it against the open project is always possible.
        if (next !== "new" && dbml && database && dbml.dialect !== database.dialect) {
            void convertDbml(dbml.text, dbml.fileName, database.dialect);
        }
    }, [dbml, database, convertDbml]);

    const review = useMemo(() => {
        if (mode === "new" || !file || !database) return undefined;
        try {
            const change = prepareProjectFileChange(file, database, currentDataTypes, mode);
            return { change, summary: summarizeSchemaChange(change.operations, database, change.targetDatabase) };
        } catch (caught) {
            return { error: caught instanceof Error ? caught.message : String(caught) };
        }
    }, [mode, file, database, currentDataTypes]);

    const onApply = useCallback(async () => {
        if (!review || !("change" in review) || review.summary.isEmpty) return;
        setIsApplying(true);
        try {
            const recorded = await applyRecorded(review.change.operations, { name: `Import (${mode})`, origin: "import" });
            onOpenChange?.(false);
            raise(
                t("modals.import_project.applied", { defaultValue: "Import applied" }),
                `${database?.name ?? ""}${recorded.migrationId ? " · recorded in version history" : recorded.skippedReason ? ` · saved to version history without migration SQL: ${recorded.skippedReason.split(". ")[0]}.` : ""}`,
                "SUCCESS",
            );
        } catch (caught) {
            raise(
                t("modals.import_project.failed", { defaultValue: "Could not import the project" }),
                caught instanceof Error ? caught.message : String(caught),
                "ERROR",
            );
        } finally {
            setIsApplying(false);
        }
    }, [review, applyRecorded, mode, onOpenChange, raise, t, database?.name]);

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
            description={t("modals.import_project.description", { defaultValue: "Open a .goforge.json backup, .dbml file, or Draw.io (.drawio) diagram as a new project. Your current project is not changed." })}
            actionName={mode === "new" ? t("modals.import_project.import", { defaultValue: "Import" }) : t("modals.import_project.apply", { defaultValue: "Apply" })}
            actionHandler={mode === "new" ? onImport : onApply}
            isDisabled={mode === "new"
                ? !file || !name.trim()
                : !review || !("change" in review) || review.summary.isEmpty || isApplying || (review.change.destructiveOperations.length > 0 && !deletionsAccepted)}
            className="md:min-w-[520px] w-full"
        >
            <div className="flex flex-col gap-4">
                <input
                    ref={inputRef}
                    type="file"
                    accept=".json,.dbml,.drawio,.xml,application/json,application/xml"
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
                    <span>{fileName ?? t("modals.import_project.drop", { defaultValue: "Drop a .goforge.json, .dbml, or .drawio file here, or click to choose one" })}</span>
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

                {dbml && mode === "new" && (
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

                {file && database && (
                    <div className="space-y-2">
                        <Label>{t("modals.import_project.destination", { defaultValue: "Import as" })}</Label>
                        <RadioGroup
                            value={mode}
                            onValueChange={(value) => onModeChange(value as "new" | ProjectImportMode)}
                            className="flex flex-wrap gap-2"
                            data-testid="import-mode"
                        >
                            {([
                                ["new", t("modals.import_project.mode_new", { defaultValue: "New project" }), true],
                                ["merge", t("modals.import_project.mode_merge", { defaultValue: "Merge into this project" }), canCompare || Boolean(dbml)],
                                ["replace", t("modals.import_project.mode_replace", { defaultValue: "Replace this project's schema" }), canCompare || Boolean(dbml)],
                            ] as const).map(([value, label, enabled]) => (
                                <Label
                                    key={value}
                                    htmlFor={`import-mode-${value}`}
                                    className={cn(
                                        "h-8 rounded-md border px-3 flex items-center",
                                        enabled ? "cursor-pointer hover:bg-secondary" : "cursor-not-allowed opacity-50",
                                        mode === value && "border-primary bg-primary/20",
                                    )}
                                    title={enabled ? undefined : t("modals.import_project.mode_dialect", { defaultValue: "This file is a different SQL dialect from the open project." })}
                                >
                                    <RadioGroupItem id={`import-mode-${value}`} value={value} disabled={!enabled} className="sr-only" />
                                    {label}
                                </Label>
                            ))}
                        </RadioGroup>
                    </div>
                )}

                {mode !== "new" && review && "error" in review && (
                    <Alert variant="destructive"><AlertCircleIcon /><AlertTitle>{review.error}</AlertTitle></Alert>
                )}
                {mode !== "new" && review && "change" in review && (
                    <ImportReviewPanel
                        summary={review.summary}
                        destructiveCount={review.change.destructiveOperations.length}
                        accepted={deletionsAccepted}
                        onAcceptedChange={setDeletionsAccepted}
                    />
                )}

                {file && summary && mode === "new" && (
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
                    <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => { latestRequest.current++; setFile(undefined); setFileName(undefined); setDbml(undefined); setWarnings([]); setError(undefined); setMode("new"); }}>
                        {t("modals.import_project.choose_another", { defaultValue: "Choose another file" })}
                    </Button>
                )}
            </div>
        </Modal>
    );
};

export default React.memo(ImportProjectModal);
