import { DatabaseDialect } from "@/lib/database";
import { SchemaLinter } from "@/utils/linter/linter";
import { detectDrift, buildReconciliationPlan } from "@/utils/drift/detector";
import { toDrawio } from "@/utils/drawio/to-drawio";
import { parseDrawio } from "@/utils/drawio/from-drawio";
import { toDbml } from "@/utils/dbml/to-dbml";
import { modernizeQuery } from "@/features/query-modernizer/orchestrator";
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
        description: "Modernize legacy SQL queries (Oracle/MSSQL/MySQL -> Modern PostgreSQL) using GoForge's multi-agent swarm with AST validation, reflection retry, SARGable optimizer, and equivalence scoring.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The legacy SQL query string to modernize.",
                },
                sourceDialect: {
                    type: "string",
                    description: "Source dialect (oracle, mssql, mysql, postgres). Defaults to oracle.",
                },
                targetDialect: {
                    type: "string",
                    description: "Target dialect. Defaults to postgres.",
                },
            },
            required: ["query"],
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
                const query = String(args.query ?? "");
                const sourceDialect = String(args.sourceDialect ?? "oracle");
                const targetDialect = String(args.targetDialect ?? "postgresql");
                const normalizedTarget = targetDialect === "postgres" ? "postgresql" : targetDialect;

                const result = await modernizeQuery({
                    legacySql: query,
                    sourceDialect: sourceDialect as any,
                    targetDialect: normalizedTarget as any,
                });

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    originalSql: result.originalSql,
                                    translatedSql: result.translatedSql,
                                    optimizedSql: result.optimizedSql,
                                    confidenceScore: result.confidenceScore,
                                    riskLevel: result.riskLevel,
                                    transformationsSummary: result.transformationsSummary,
                                    validationReport: result.validationReport,
                                    indexRecommendations: result.indexRecommendations,
                                    agentTracesCount: result.agentTraces?.length ?? 0,
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
