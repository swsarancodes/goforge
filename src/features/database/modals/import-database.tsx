import Modal, { ModalProps } from "@/components/modal"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { DatabaseDialect, ImportDatabaseMethod, ImportDatabaseOption, ImportMethodType, MARIADB_DUMP_EXAMPLE, MARIADB_DUMP_INSTRUCTIONS, MYSQL_DUMP_EXAMPLE, MYSQL_DUMP_INSTRUCTIONS, PG_DUMP_EXAMPLE, PG_DUMP_INSTRUCTIONS, SQLITE_DUMP_EXAMPLE, SQLITE_DUMP_INSRUCTION } from "@/lib/database";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { AlertCircleIcon, Code, HelpCircle, InfoIcon, Upload } from "lucide-react";
import Clipboard from "@/components/clipboard";
import { Trans } from 'react-i18next';
import { Node, useReactFlow } from "@xyflow/react";
import { adjustTablesPositions, getTableNextSequence } from "@/utils/tables";
import { TableInsertType } from "@/lib/schemas/table-schema";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { useTheme } from "@/providers/theme-provider/theme-provider";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { BaseSqlImporter } from "@/utils/import/base-sql-importer";
import { getImporter } from "@/utils/import/import-utils";
import CodeEditor from "@/components/code-editor";
import { MAX_IMPORT_FILE_BYTES, readTextFile } from "@/utils/file";
import useToast from "@/hooks/use-toast";
import { LiveDatabaseOption, useLiveDatabase } from "../components/live-database-option";
import { liveDatabaseCreatedText, liveTargetFromImport } from "../live-database";


const options: ImportDatabaseOption[] = [{
    dialect: DatabaseDialect.POSTGRES,
    methods: [{
        id: "pg_dump",
        name: "pg_dump",
        icon: <Code className="size-3.5 " />,
        type: ImportMethodType.DUMP,
        instruction: PG_DUMP_INSTRUCTIONS,
        example: PG_DUMP_EXAMPLE

    }, {
        id: "pg_admin",
        name: "Pg Admin",
        logo: "/postgresql_logo_small.png",
        type: ImportMethodType.DB_CLIENT,
        numberOfInstructions: 5,

    }]
}, {
    dialect: DatabaseDialect.MYSQL,
    methods: [{
        id: "mysql_dump",
        name: "mysqldump",
        icon: <Code className="size-3.5" />,
        type: ImportMethodType.DUMP,
        instruction: MYSQL_DUMP_INSTRUCTIONS,
        example: MYSQL_DUMP_EXAMPLE,
    }, {
        id: "workbench",
        name: "MySQL Workbench",
        logo: "/mysql_logo_small.png",
        type: ImportMethodType.DB_CLIENT,
        numberOfInstructions: 5,
    }]
}
    , {
    dialect: DatabaseDialect.MARIADB,
    methods: [{
        id: "mariadb-dump",
        name: "mariadb-dump",
        icon: <Code className="size-3.5" />,
        type: ImportMethodType.DUMP,
        instruction: MARIADB_DUMP_INSTRUCTIONS,
        example: MARIADB_DUMP_EXAMPLE,
    }, {
        id: "heidisql",
        name: "HeidiSQL",
        type: ImportMethodType.DB_CLIENT,
        numberOfInstructions: 5,
        logo: "/heidisqlL_logo.png",
    }, {
        id: "mysql_dump",
        name: "mysqldump",
        icon: <Code className="size-3.5" />,
        type: ImportMethodType.DUMP,
        instruction: MYSQL_DUMP_INSTRUCTIONS,
        example: MYSQL_DUMP_EXAMPLE,
    }, {
        id: "workbench",
        name: "MySQL Workbench",
        logo: "/mysql_logo_small.png",
        type: ImportMethodType.DB_CLIENT,
        numberOfInstructions: 5,
    }],

}, {
    dialect: DatabaseDialect.SQLITE,
    methods: [{
        id: "sqlite3",
        name: "Sqlite3",
        icon: <Code className="size-3.5" />,
        type: ImportMethodType.DUMP,
        instruction: SQLITE_DUMP_INSRUCTION,
        example: SQLITE_DUMP_EXAMPLE
    }, {
        id: "dbbrowser",
        name: "DB Browser",
        logo: "/dbbrowser.png",
        type: ImportMethodType.DB_CLIENT,
        numberOfInstructions: 5,
    }]
}
    , {
    dialect: DatabaseDialect.MSSQL,
    methods: [{
        id: "ssms",
        name: "SSMS",
        logo: "/ssms.png",
        type: ImportMethodType.DB_CLIENT,
        numberOfInstructions: 5,
    }]
}, {
    dialect: DatabaseDialect.ORACLE,
    methods: [{
        id: "sqldeveloper",
        name: "SQL Developer",
        logo: "/sqldeveloper.png",
        type: ImportMethodType.DB_CLIENT,
        numberOfInstructions: 6,
    }]
}
];

const getParseErrorMessage = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^Error:\s*/i, "").trim() || "Unknown SQL parsing error.";
};

const getLeadingQueryType = (sql: string) => {
    const withoutComments = sql
        .replace(/--.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trimStart();

    const directQuery = withoutComments.match(/^(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i);
    if (directQuery) return directQuery[1].toUpperCase();
    if (!/^WITH\b/i.test(withoutComments)) return undefined;

    let depth = 0;
    let quote: 'single' | 'double' | 'backtick' | 'bracket' | undefined;

    for (let index = 0; index < withoutComments.length; index++) {
        const character = withoutComments[index];
        const next = withoutComments[index + 1];

        if (quote === 'single') {
            if (character === "'") {
                if (next === "'") index++;
                else quote = undefined;
            }
            continue;
        }
        if (quote === 'double') {
            if (character === '"') {
                if (next === '"') index++;
                else quote = undefined;
            }
            continue;
        }
        if (quote === 'backtick') {
            if (character === '`') {
                if (next === '`') index++;
                else quote = undefined;
            }
            continue;
        }
        if (quote === 'bracket') {
            if (character === ']') {
                if (next === ']') index++;
                else quote = undefined;
            }
            continue;
        }

        if (character === "'") quote = 'single';
        else if (character === '"') quote = 'double';
        else if (character === '`') quote = 'backtick';
        else if (character === '[') quote = 'bracket';
        else if (character === '(') depth++;
        else if (character === ')') depth = Math.max(0, depth - 1);
        else if (depth === 0) {
            const query = withoutComments.slice(index).match(/^(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i);
            if (query) return query[1].toUpperCase();
        }
    }

    return undefined;
};

const isRawQuery = (sql: string) => getLeadingQueryType(sql) === "SELECT";

const ImportDatabaseModal: React.FC<ModalProps> = ({ isOpen, onOpenChange }) => {
    const { t } = useTranslation();

    const { theme: resolvedTheme } = useTheme();
    const { database, isLoading, isSwitchingDatabase } = useDatabase();
    const { data_types, importDatabase } = useDatabaseOperations();
    const [sqlCode, setSqlCode] = useState<string>("");
    const [parsedDatabase, setParsedDatabase] = useState<any | undefined>(undefined)
    const [error, setError] = useState<boolean>(false);
    const [parseError, setParseError] = useState<string | undefined>(undefined);
    const { fitView } = useReactFlow();
    const raise = useToast();
    const live = useLiveDatabase(database?.name, database?.dialect);
    const [liveError, setLiveError] = useState<string | undefined>(undefined);

    const [importer, setImporter] = useState<BaseSqlImporter | undefined>(undefined);

    useEffect(() => {
        if (isLoading || data_types.length == 0 || !database?.dialect)
            return;

        else if (data_types.length > 0) {
            setImporter(getImporter(database.dialect, data_types))
        }
    }, [isLoading, data_types]);

    let currentOption: ImportDatabaseOption | undefined = useMemo(() => {
        return options.find((option: ImportDatabaseOption) => option.dialect == database?.dialect)
    }, [database]);

    const [selectedMethodId, setSelectedMethodId] = useState<string | undefined>(undefined);

    useEffect(() => {
        setSelectedMethodId(currentOption ? currentOption.methods[0].id as string : undefined)
    }, [currentOption])

    const onImportMethodChange = (method: string) => {
        setSelectedMethodId(method);
    }

    const selectedImportMethod: ImportDatabaseMethod | undefined = useMemo(() => {
        return currentOption?.methods.find((method: ImportDatabaseMethod) => method.id == selectedMethodId) as ImportDatabaseMethod;
    }, [selectedMethodId, currentOption])


    const validateSql = useCallback((code: string) => {
        setParseError(undefined);
        if (isRawQuery(code)) {
            // Raw queries are valid SQL, but they do not describe schema objects
            // until the user explicitly converts them into a view definition.
            setParsedDatabase(undefined);
            setError(false);
            setSqlCode(code);
            return;
        }

        if (importer)
            try {
                const parsedDatabase = importer.parseSql(code);
                setParsedDatabase(parsedDatabase);
                setError(false);

            } catch (error) { 
                setError(true);
                setParsedDatabase(undefined)
                setParseError(getParseErrorMessage(error));
            }
        else {
            console.error("Importer not loaded");
        }
        setSqlCode(code)

    }, [database?.dialect, data_types, importer])

    const onImport = useCallback(async () => {

        let nextTableSequence: number = getTableNextSequence(database ? database.tables : []);
        if (!parsedDatabase) return;

        // The live database goes first: if the server refuses, nothing in the diagram has changed yet.
        setLiveError(undefined);
        let createdDatabase: string | undefined;
        if (live.active && database) {
            try {
                const created = await live.create(liveTargetFromImport(parsedDatabase, database, data_types), data_types);
                createdDatabase = liveDatabaseCreatedText(created.connection);
            } catch (caught) {
                setLiveError(caught instanceof Error ? caught.message : String(caught));
                return;
            }
        }

        {
            return new Promise(async (res, rej) => {
                try {
                    const nodes: Node[] = parsedDatabase.tables.map((table: TableInsertType) => ({
                        id: table.id,
                        data: {
                            table
                        }
                    }))

                    const adjustedTables = await adjustTablesPositions(nodes, parsedDatabase.relationships);

                    for (let index = 0; index < adjustedTables.length; index++) {
                        adjustedTables[index].sequence = nextTableSequence;
                        nextTableSequence += 1;
                    }

                    await importDatabase(adjustedTables, parsedDatabase.relationships, parsedDatabase.indexes, parsedDatabase.views, parsedDatabase.sequences);

                    onOpenChange && onOpenChange(false);
                    if (createdDatabase) raise("Database created", createdDatabase, "SUCCESS");

                    setTimeout(() => {
                        fitView({
                            duration: 500
                        });
                    }, 300);

                } catch (error) {

                    setError(true);
                    if (createdDatabase) setLiveError(`The live database "${createdDatabase}" was created, but the diagram could not be updated.`);
                    rej()
                }
            })
        }
    }, [parsedDatabase, database, live, data_types]);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [fileError, setFileError] = useState<string | undefined>(undefined);

    const loadFile = useCallback(async (file: File | undefined) => {
        if (!file) return;
        setFileError(undefined);
        if (file.size > MAX_IMPORT_FILE_BYTES) {
            setFileError(t("modals.import_database.file_too_large", { defaultValue: "This file is larger than 5 MB. Import a smaller .sql file." }));
            return;
        }
        try {
            const content = await readTextFile(file);
            // A NUL byte means this is a binary file, not SQL text.
            if (content.includes("\u0000")) {
                setFileError(t("modals.import_database.file_not_text", { defaultValue: "This file is not a text SQL file." }));
                return;
            }
            validateSql(content);
        } catch {
            setFileError(t("modals.import_database.file_read_error", { defaultValue: "Could not read the selected file." }));
        }
    }, [validateSql, t]);

    const convertRawQueryToView = useCallback(() => {
        const query = sqlCode.trim().replace(/;\s*$/, "");
        if (!query) return;

        validateSql(`CREATE VIEW my_custom_view AS\n${query};`);
    }, [sqlCode, validateSql]);


    if (isLoading || isSwitchingDatabase)
        return;

    const rawQueryDetected = isRawQuery(sqlCode);

    return (
         <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title={t("modals.import_database.title")}
            actionName={live.active ? "Import and create database" : t("modals.import_database.import")}
            className="lg:min-w-[860px] md:min-w-[560px] w-full max-h-screen overflow-auto "
            actionHandler={onImport}
            isDisabled={!parsedDatabase || Boolean(live.enabled && live.problem)}
        >
            <div className="flex flex-col gap-4 !min-w-0  ">
                <div className="w-full space-y-2 min-w-0 ">
                    <p className="text-sm text-muted-foreground">
                        {t("modals.import_database.import_options")}
                    </p>
                    <div className="flex flex-col lg:flex-row-reverse gap-2 justify-between items-center ">
                        {currentOption?.docUrl &&
                            <a
                                className={
                                    buttonVariants({
                                        variant: "outline"
                                    })
                                }
                                href={currentOption.docUrl}
                                target="_blank"
                            >
                                {t("modals.import_database.view_docs")}

                                <HelpCircle className="size-4 text-muted-foreground" />
                            </a>
                        }
                        {
                            <RadioGroup
                                onValueChange={onImportMethodChange}
                                value={selectedMethodId}
                                className="flex ">
                                {
                                    currentOption?.methods.map((method: ImportDatabaseMethod) => (
                                        <Label htmlFor={method.id}
                                            key={method.id}
                                            className={cn(" h-8  px-2 rounded-md border hover:bg-secondary cursor-pointer flex items-center gap-1 ",
                                                (selectedMethodId == method.id) ? "border-primary bg-primary/20 " : "",
                                            )}>
                                            <RadioGroupItem value={method.id} id={method.id} className="sr-only" />
                                            {
                                                method.icon &&

                                                <div >
                                                    {method.icon}
                                                </div>
                                            }
                                            <img
                                                src={method.logo}
                                                className="rounded-none h-4  "
                                            />
                                            <span >
                                                {method.name}
                                            </span>


                                        </Label>
                                    ))
                                }
                            </RadioGroup>

                        }

                    </div>
                    {
                        selectedImportMethod?.type == ImportMethodType.DUMP &&
                        <div className="space-y-2">
                            <h3 className=" text-medium ">
                                {t("import.instructions")}
                            </h3>
                            <ul className="list-decimal list-outside px-4 text-sm space-y-2 ">
                                <li>
                                    {t("import.install")}  <span className=" font-medium ">{selectedImportMethod?.name}</span> .
                                </li>
                                <li className="space-y-2">
                                    <div>
                                        {t("import.run_command")}
                                    </div>
                                    <div className="  font-normal w-full">
                                        <span className="border-1 border-border p-1 px-2  rounded-md  w-full flex items-center justify-between">
                                            {selectedImportMethod.instruction}
                                            <Clipboard text={selectedImportMethod.instruction} />
                                        </span>
                                    </div>

                                    <div>
                                        {t("import.example")}
                                    </div>


                                    <div className="  font-normal w-full">
                                        <span className="border-1 border-border  p-1 px-2  rounded-md  w-full flex items-center justify-between">
                                            {selectedImportMethod.example}
                                            <Clipboard text={selectedImportMethod.example} />
                                        </span>
                                    </div>

                                </li>
                                <li>
                                    {t("import.copy_code")}
                                </li>
                            </ul>
                        </div>
                    }
                    {
                        selectedImportMethod?.type == ImportMethodType.DB_CLIENT &&
                        <div className="space-y-2">
                            <h3 className=" text-medium ">
                                {t("import.instructions")}
                            </h3>
                            <ul className="list-decimal list-outside px-4  text-sm space-y-3 ">
                                {
                                    Array.from({ length: selectedImportMethod.numberOfInstructions as number }, (_, i) => i).map((index: number) => (
                                        <li>
                                            <Trans i18nKey={`import.${selectedImportMethod.id}.step${index + 1}`} components={{
                                                bold: <span className="font-medium" />,
                                                code: <span className="border-1 border-border bg-secondary p-1 px-2  rounded-md  " />
                                            }} />
                                        </li>
                                    ))
                                }

                            </ul>
                        </div>
                    }

                </div>
                <div
                    className="flex flex-1 flex-col relative"
                    onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
                    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setIsDragging(false); }}
                    onDrop={(event) => {
                        event.preventDefault();
                        setIsDragging(false);
                        void loadFile(event.dataTransfer.files?.[0]);
                    }}
                >
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".sql,.txt,.ddl,text/plain,application/sql"
                            className="sr-only"
                            data-testid="import-file-input"
                            onChange={(event) => {
                                void loadFile(event.target.files?.[0]);
                                // Allow re-selecting the same file after editing it.
                                event.target.value = "";
                            }}
                        />
                        <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => fileInputRef.current?.click()}>
                            <Upload className="size-3.5" />
                            {t("modals.import_database.upload_file", { defaultValue: "Upload .sql file" })}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                            {t("modals.import_database.drop_hint", { defaultValue: "or drop a file here, or paste below" })}
                        </span>
                    </div>
                    {fileError && (
                        <p className="mb-2 flex items-center gap-1 text-sm text-destructive">
                            <AlertCircleIcon className="size-4 shrink-0" /> {fileError}
                        </p>
                    )}
                    {isDragging && (
                        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/10 text-sm font-medium">
                            {t("modals.import_database.drop_active", { defaultValue: "Drop the .sql file to load it" })}
                        </div>
                    )}
                    <CodeEditor
                        className={
                            cn("flex w-full   border-1 rounded-md border-divider overflow-hidden ",
                                (error || parsedDatabase?.errors?.length > 0) ? "min-h-[360px] max-h-[360px]" : "min-h-[424px] max-h-[424px]"
                            )
                        }
                        value={sqlCode}
                        onChange={validateSql}
                        autoFocus
                    />

                    <div className="mt-4 space-y-3">
                        {parsedDatabase && <LiveDatabaseOption live={live} />}
                        {liveError && (
                            <Alert variant={"destructive"}>
                                <AlertCircleIcon />
                                <AlertTitle>Could not create the live database</AlertTitle>
                                <AlertDescription>
                                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs">{liveError}</pre>
                                </AlertDescription>
                            </Alert>
                        )}
                        {rawQueryDetected && (
                            <Alert className="mb-4 border-blue-500/40 text-blue-700 dark:text-blue-300">
                                <InfoIcon />
                                <AlertTitle>
                                    {t("modals.import_database.raw_query_title", { defaultValue: "Query detected" })}
                                </AlertTitle>
                                <AlertDescription>
                                    <p>
                                        {t("modals.import_database.raw_query_description", {
                                            defaultValue: "This importer reads schema DDL only: CREATE TABLE, CREATE VIEW, and CREATE SEQUENCE. To import a query as a view, wrap it like this:",
                                        })}
                                    </p>
                                    <code className="rounded-md border border-blue-500/30 bg-blue-500/5 px-2 py-1 font-mono text-xs">
                                        CREATE VIEW my_view AS SELECT ...;
                                    </code>
                                    <Button type="button" size="sm" variant="outline" onClick={convertRawQueryToView}>
                                        Convert to View
                                    </Button>
                                </AlertDescription>
                            </Alert>
                        )}
                        {
                            error &&
                            <Alert
                                variant={"destructive"}
                            >

                                <AlertCircleIcon />
                                <AlertTitle>
                                    {t("modals.import_database.import_error")}
                                </AlertTitle>
                                <AlertDescription>
                                    {t("modals.import_database.import_error_description")}
                                    {parseError && (
                                        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono text-xs">
                                            {parseError}
                                        </pre>
                                    )}
                                </AlertDescription>
                            </Alert>
                        }
                        {
                            (parsedDatabase?.errors && parsedDatabase?.errors?.length > 0) &&
                            <Alert
                                variant={"default"}
                                className="text-chart-4"
                            >

                                <AlertTitle>
                                    {t("modals.import_database.import_warning")}
                                </AlertTitle>
                                <AlertDescription className="text-chart-4 ">
                                    {t("modals.import_database.import_warning_description")}
                                    <ul className="mt-2 max-h-32 list-disc space-y-1 overflow-auto pl-4 font-mono text-xs">
                                        {parsedDatabase.errors.map((parseIssue: unknown, index: number) => (
                                            <li key={`${getParseErrorMessage(parseIssue)}-${index}`}>
                                                {getParseErrorMessage(parseIssue)}
                                            </li>
                                        ))}
                                    </ul>
                                </AlertDescription>

                            </Alert>
                        }
                    </div>
                </div>
            </div>
        </Modal>
    )
}


export default ImportDatabaseModal
