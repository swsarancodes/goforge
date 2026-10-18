import { describe, expect, it } from "vitest";
import { GoForgeMcpServer } from "./server";

describe("GoForge MCP Server (Model Context Protocol)", () => {
    const server = new GoForgeMcpServer();

    it("handles initialize handshake per MCP specification", async () => {
        const response = await server.handleMessage({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test-client", version: "1.0.0" },
            },
        });

        expect(response).toBeDefined();
        expect(response?.id).toBe(1);
        expect(response?.result.serverInfo.name).toBe("goforge-mcp");
        expect(response?.result.protocolVersion).toBe("2024-11-05");
        expect(response?.result.capabilities.tools).toBeDefined();
    });

    it("lists all available GoForge tools in tools/list", async () => {
        const response = await server.handleMessage({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
        });

        expect(response?.result.tools).toBeDefined();
        const toolNames = response?.result.tools.map((t: any) => t.name);
        expect(toolNames).toContain("goforge_lint_schema");
        expect(toolNames).toContain("goforge_detect_drift");
        expect(toolNames).toContain("goforge_modernize_query");
        expect(toolNames).toContain("goforge_convert_format");
        expect(toolNames).toContain("goforge_inspect_schema");
    });

    it("executes goforge_lint_schema via tools/call", async () => {
        const unkeyedSchema = {
            name: "Test DB",
            dialect: "postgres",
            tables: [
                {
                    id: "tbl-audit",
                    name: "audit_logs",
                    fields: [
                        { id: "f1", name: "action", type: { name: "text" }, isPrimary: false },
                    ],
                },
            ],
        };

        const response = await server.handleMessage({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
                name: "goforge_lint_schema",
                arguments: {
                    schema: unkeyedSchema,
                },
            },
        });

        expect(response?.result.content).toHaveLength(1);
        const data = JSON.parse(response?.result.content[0].text);
        expect(data.issues.length).toBeGreaterThan(0);
        expect(data.issues.some((i: any) => i.ruleId === "require-primary-key")).toBe(true);
    });

    it("executes goforge_detect_drift via tools/call", async () => {
        const canvasTables = [
            { id: "t1", name: "users", fields: [] },
        ];
        const liveTables = [
            { id: "t1", name: "users", fields: [] },
            { id: "t2", name: "payments", fields: [] },
        ];

        const response = await server.handleMessage({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: {
                name: "goforge_detect_drift",
                arguments: {
                    canvasTables,
                    liveTables,
                    dialect: "postgres",
                },
            },
        });

        const data = JSON.parse(response?.result.content[0].text);
        expect(data.driftReport.summary.addedInLive).toBe(1);
        expect(data.reconciliationPlan.pullOperations.length).toBeGreaterThan(0);
    });

    it("executes goforge_convert_format from json to drawio", async () => {
        const schema = {
            project: {
                name: "Demo",
                dialect: "postgres",
                tables: [
                    {
                        id: "t1",
                        name: "posts",
                        posX: 100,
                        posY: 100,
                        fields: [
                            { id: "f1", name: "id", type: { name: "uuid" }, isPrimary: true },
                        ],
                    },
                ],
                relationships: [],
            },
        };

        const response = await server.handleMessage({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: {
                name: "goforge_convert_format",
                arguments: {
                    content: JSON.stringify(schema),
                    from: "json",
                    to: "drawio",
                },
            },
        });

        const xml = response?.result.content[0].text;
        expect(xml).toContain("<mxfile");
        expect(xml).toContain("value=\"posts\"");
    });

    it("executes goforge_modernize_query with query swarm", async () => {
        const legacyQuery = "SELECT NVL(amount, 0) FROM dual";
        const response = await server.handleMessage({
            jsonrpc: "2.0",
            id: 6,
            method: "tools/call",
            params: {
                name: "goforge_modernize_query",
                arguments: {
                    query: legacyQuery,
                    sourceDialect: "oracle",
                    targetDialect: "postgres",
                },
            },
        });

        const data = JSON.parse(response?.result.content[0].text);
        expect(data.optimizedSql).toBeDefined();
        expect(data.confidenceScore).toBeGreaterThan(0);
    });

    it("executes goforge_inspect_schema", async () => {
        const schema = {
            name: "ECommerce",
            dialect: "postgres",
            tables: [
                {
                    id: "t1",
                    name: "products",
                    fields: [
                        { id: "f1", name: "id", isPrimary: true },
                        { id: "f2", name: "title", isPrimary: false },
                    ],
                },
            ],
            relationships: [],
        };

        const response = await server.handleMessage({
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: {
                name: "goforge_inspect_schema",
                arguments: {
                    schema,
                },
            },
        });

        const data = JSON.parse(response?.result.content[0].text);
        expect(data.tablesCount).toBe(1);
        expect(data.tables[0].name).toBe("products");
        expect(data.tables[0].columnsCount).toBe(2);
        expect(data.tables[0].primaryKeys).toEqual(["id"]);
    });

    it("returns JSON-RPC error for unknown methods", async () => {
        const response = await server.handleMessage({
            jsonrpc: "2.0",
            id: 99,
            method: "non_existent_method",
        });

        expect(response?.error?.code).toBe(-32601);
    });
});
