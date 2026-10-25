import { DatabaseDialect } from "@/lib/database";
import { SchemaLinter } from "@/utils/linter/linter";
import { detectDrift, buildReconciliationPlan } from "@/utils/drift/detector";
import { toDrawio } from "@/utils/drawio/to-drawio";
import { parseDrawio } from "@/utils/drawio/from-drawio";
import { toDbml } from "@/utils/dbml/to-dbml";
import { convertQuery } from "@/features/query-modernizer/engine/convert";
import { checkPostgresSyntax } from "@/features/query-modernizer/engine/checks";
import { runBatch, STATUS_LABELS, type BatchItem } from "@/features/query-modernizer/batch";
import { convertedScript, readinessMarkdown } from "@/features/query-modernizer/batch-report";
import { LEGACY_DIALECTS, type LegacyDialect } from "@/features/query-modernizer/types";
import { McpToolDefinition, McpToolCallResult } from "./types";

export const MCP_TOOLS: McpToolDefinition[] = [
    {
        name: "goforge_lint_schema",
        description: "Run GoForge's schema linter rules to detect anti-patterns, missing primary keys, unindexed foreign keys, redundant indexes, naming violations, and reserved keyword collisions.",
        inputSchema: {
            type: "object",
            properties: {
                schema: {
                    type: "object",
                    description: "A GoForge ProjectFile or Database object containing tables, columns, indexes, and constraints.",
                },
                options: {
                    type: "object",
                    description: "Optional linter configuration (e.g. namingConvention: 'snake_case' | 'camelCase', disabledRules: string[]).",
                },
            },
            required: ["schema"],
        },
    },
    {
        name: "goforge_detect_drift",
        description: "Compare canvas schema tables against live database tables, producing an object-level drift report and a safe 3-way reconciliation plan (pull vs push SQL).",
        inputSchema: {
            type: "object",
            properties: {
                canvasTables: {
                    type: "array",
                    description: "List of tables defined on the canvas.",
                },
                liveTables: {
                    type: "array",
                    description: "List of tables freshly introspected from the live database.",
                },
                dialect: {
                    type: "string",
                    description: "Target database dialect (postgres, mysql, mariadb, sqlite, mssql, oracle).",
                },
            },
            required: ["canvasTables", "liveTables"],
        },
    },
    {
        name: "goforge_modernize_query",
        description:
            "Convert legacy SQL written for Oracle, SQL Server, MySQL or DB2 to PostgreSQL with named, tested rules. Pass `query` for one statement, or `script` for a whole file: the file is split into statements (`;`, a lone `/`, GO, DELIMITER), every query is converted, and each statement gets one status (converted, unchanged, review, failed, out-of-scope) with the facts behind it. Procedures, packages, schema statements and client commands are listed as out-of-scope, never converted. Statements are checked with a PostgreSQL grammar only (no database): nothing here proves the converted SQL returns the same rows.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "One legacy SQL statement to modernize. Use this or `script`.",
                },
                script: {
                    type: "string",
                    description: "The text of a whole legacy SQL file to convert statement by statement. Use this or `query`.",
                },
                sourceDialect: {
                    type: "string",
                    description: "Source dialect: oracle, mssql, mysql or db2. Defaults to oracle.",
                },
                statements: {
                    type: "string",
                    description: "For `script`: which statements to list in the answer: 'attention' (failed, review and out-of-scope, the default), 'all', or 'none' (summary only).",
                },
                maxStatements: {
                    type: "number",
                    description: "For `script`: the most statements to list (default 100). The summary always covers the whole file.",
                },
                includeConvertedScript: {
                    type: "boolean",
                    description: "For `script`: also return the whole converted file (what did not convert is kept as comments).",
                },
                includeReport: {
                    type: "boolean",
                    description: "For `script`: also return the migration report as Markdown.",
                },
            },
        },
    },
    {
        name: "goforge_convert_format",
        description: "Convert database schemas between canonical formats: Project JSON, DBML, and Draw.io XML (.drawio).",
        inputSchema: {
            type: "object",
            properties: {
                content: {
                    type: "string",
                    description: "The input document string (JSON, DBML, or Draw.io XML).",
                },
                from: {
                    type: "string",
                    description: "Source format ('json', 'dbml', 'drawio').",
                },
                to: {
                    type: "string",
                    description: "Target format ('json', 'dbml', 'drawio').",
                },
            },
            required: ["content", "from", "to"],
        },
    },
    {
        name: "goforge_inspect_schema",
        description: "Inspect a schema JSON document and return a structured summary of tables, columns, primary keys, foreign keys, indexes, and constraint counts.",
        inputSchema: {
            type: "object",
            properties: {
                schema: {
                    type: "object",
                    description: "A GoForge ProjectFile or Database object.",
                },
            },
            required: ["schema"],
        },
    },
];

export async function executeMcpTool(name: string, args: Record<string, any>): Promise<McpToolCallResult> {
    try {
        switch (name) {
            case "goforge_lint_schema": {
                const rawSchema = args.schema?.project ?? args.schema ?? {};
                const schema = {
                    name: rawSchema.name ?? "database",
                    dialect: rawSchema.dialect ?? DatabaseDialect.POSTGRES,
                    tables: rawSchema.tables ?? [],
                    relationships: rawSchema.relationships ?? [],
                };
                const options = args.options ?? {};
                const linter = new SchemaLinter(options);
                const result = linter.lint(schema as any);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            case "goforge_detect_drift": {
                const canvasTables = args.canvasTables ?? [];
                const liveTables = args.liveTables ?? [];
                const dialect = (args.dialect as DatabaseDialect) ?? DatabaseDialect.POSTGRES;

                const canvasDb: any = {
                    name: "canvas",
                    dialect,
                    tables: canvasTables,
                    relationships: args.canvasRelationships ?? [],
                };
                const liveDb: any = {
                    name: "live",
                    dialect,
                    tables: liveTables,
                    relationships: args.liveRelationships ?? [],
                };

                const driftReport = detectDrift(canvasDb, liveDb);
                const pullItems = driftReport.items.filter(i => i.resolution === "pull");
                const pushItems = driftReport.items.filter(i => i.resolution === "push");
                const ignoredItems = driftReport.items.filter(i => i.resolution === "ignore");

                const pullOperations = pullItems.map(item => ({
                    status: item.status,
                    category: item.category,
                    targetName: item.targetName,
                    details: item.details,
                }));

                const pushOperations = pushItems.map(item => ({
                    status: item.status,
                    category: item.category,
                    targetName: item.targetName,
                    details: item.details,
                }));

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    driftReport,
                                    reconciliationPlan: {
                                        pullOperations,
                                        pushOperations,
                                        pullCount: pullItems.length,
                                        pushCount: pushItems.length,
                                        ignoredCount: ignoredItems.length,
                                    },
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            }

            case "goforge_modernize_query": {
                const sourceDialect = String(args.sourceDialect ?? "oracle").toLowerCase();
                if (!LEGACY_DIALECTS.some((option) => option.value === sourceDialect)) {
                    return { isError: true, content: [{ type: "text", text: `Unsupported source dialect '${sourceDialect}'. Use one of: ${LEGACY_DIALECTS.map((option) => option.value).join(", ")}. The target is always PostgreSQL.` }] };
                }
                const hasQuery = typeof args.query === "string" && args.query.length > 0;
                const hasScript = typeof args.script === "string" && args.script.length > 0;
                if (hasQuery === hasScript) {
                    return { isError: true, content: [{ type: "text", text: "Pass exactly one of `query` (one statement) or `script` (a whole file)." }] };
                }

                if (hasScript) {
                    const script = String(args.script);
                    if (script.length > 5_000_000) return { isError: true, content: [{ type: "text", text: "The script is larger than 5 MB; split it and convert it in parts." }] };
                    const result = await runBatch({ script, dialect: sourceDialect as LegacyDialect }, { syntax: checkPostgresSyntax });
                    const which = String(args.statements ?? "attention");
                    const limit = Math.max(0, Math.min(Number(args.maxStatements ?? 100) || 100, 2000));
                    const listed = (which === "none" ? [] : which === "all" ? result.items : result.items.filter((item) => item.status === "failed" || item.status === "review" || item.status === "out-of-scope")).slice(0, limit);
                    const describe = (item: BatchItem) => ({
                        statement: item.unit.index + 1,
                        lines: [item.unit.startLine, item.unit.endLine],
                        kind: item.unit.kind,
                        status: item.status,
                        statusMeaning: STATUS_LABELS[item.status],
                        reasons: item.reasons,
                        notes: item.notes,
                        originalSql: item.unit.text,
                        ...(item.outcome && item.status !== "failed"
                            ? { convertedSql: item.outcome.sql, rulesApplied: item.outcome.engine.applied.map((rule) => ({ id: rule.id, title: rule.title, count: rule.count })), behaviourDifferences: item.outcome.engine.traps.map((trap) => ({ id: trap.id, severity: trap.severity, title: trap.title })) }
                            : {}),
                        ...(item.outcome && item.status === "failed" ? { notConverted: item.outcome.engine.unconverted } : {}),
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        sourceDialect,
                                        target: "postgresql",
                                        summary: { statements: result.summary.units, lines: result.lineCount, byStatus: result.summary.byStatus, byKind: result.summary.byKind, checkedBy: "a PostgreSQL grammar only; no database was asked", topRules: result.summary.rules.slice(0, 10), topUnconverted: result.summary.unconverted, behaviourDifferences: result.summary.traps },
                                        warnings: result.warnings,
                                        statementsListed: listed.length,
                                        statementsNotListed: Math.max(0, (which === "all" ? result.items.length : result.items.filter((item) => item.status === "failed" || item.status === "review" || item.status === "out-of-scope").length) - listed.length),
                                        statements: listed.map(describe),
                                        ...(args.includeConvertedScript === true ? { convertedScript: convertedScript(result) } : {}),
                                        ...(args.includeReport === true ? { reportMarkdown: readinessMarkdown(result, { generatedAt: new Date().toISOString() }) } : {}),
                                        note: "Statuses are facts about checks, not a probability. 'converted' means the rules finished and a grammar accepts the result; it does not mean the new statement returns the same rows. Run it against PostgreSQL (EXPLAIN) and compare results on real data.",
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                    };
                }

                const query = String(args.query);
                const result = convertQuery({ sql: query, dialect: sourceDialect as LegacyDialect });

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    originalSql: query,
                                    convertedSql: result.sql,
                                    syntaxError: result.syntaxError,
                                    rulesApplied: result.applied.map((rule) => ({ id: rule.id, title: rule.title, count: rule.count, why: rule.why })),
                                    notConverted: result.unconverted,
                                    behaviourDifferences: result.traps,
                                    bindVariables: result.parameters,
                                    note: "Not checked against a database. Run the converted query through PostgreSQL (EXPLAIN) and compare results on real data before relying on it.",
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            }

            case "goforge_convert_format": {
                const content = String(args.content ?? "");
                const from = String(args.from ?? "").toLowerCase();
                const to = String(args.to ?? "").toLowerCase();

                let projectFile: any;

                if (from === "json") {
                    projectFile = JSON.parse(content);
                } else if (from === "drawio") {
                    const parsed = parseDrawio(content, { dataTypes: [] });
                    projectFile = parsed.file;
                } else {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Conversion from format '${from}' is not currently supported. Supported from: 'json', 'drawio'.`,
                            },
                        ],
                    };
                }

                const dbObj = projectFile?.project ?? projectFile;

                if (to === "drawio") {
                    const result = toDrawio(dbObj);
                    return {
                        content: [{ type: "text", text: result.xml }],
                    };
                } else if (to === "dbml") {
                    const result = toDbml(dbObj);
                    return {
                        content: [{ type: "text", text: result.dbml }],
                    };
                } else if (to === "json") {
                    return {
                        content: [{ type: "text", text: JSON.stringify(projectFile, null, 2) }],
                    };
                } else {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Target format '${to}' is unsupported. Supported to: 'drawio', 'dbml', 'json'.`,
                            },
                        ],
                    };
                }
            }

            case "goforge_inspect_schema": {
                const schema = args.schema?.project ?? args.schema;
                const tables = schema?.tables ?? [];
                const relationships = schema?.relationships ?? [];

                const tableSummaries = tables.map((t: any) => ({
                    id: t.id,
                    name: t.namespace ? `${t.namespace}.${t.name}` : t.name,
                    columnsCount: (t.fields ?? []).length,
                    primaryKeys: (t.fields ?? []).filter((f: any) => f.isPrimary).map((f: any) => f.name),
                    indexesCount: (t.indices ?? []).length,
                    checksCount: (t.checks ?? []).length,
                }));

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    name: schema.name ?? "Database",
                                    dialect: schema.dialect ?? "postgres",
                                    tablesCount: tables.length,
                                    relationshipsCount: relationships.length,
                                    tables: tableSummaries,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            }

            default:
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Unknown tool: "${name}"`,
                        },
                    ],
                };
        }
    } catch (err: any) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: `Error executing tool "${name}": ${err?.message ?? String(err)}`,
                },
            ],
        };
    }
}
