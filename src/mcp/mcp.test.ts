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

    it("executes goforge_modernize_query and reports what it did and what it could not do", async () => {
        const call = async (args: Record<string, unknown>) =>
            server.handleMessage({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "goforge_modernize_query", arguments: args } });

        const converted = JSON.parse((await call({ query: "SELECT NVL(amount, 0) FROM dual", sourceDialect: "oracle" }))?.result.content[0].text);
        expect(converted.convertedSql).toBe("SELECT COALESCE(amount, 0)");
        expect(converted.rulesApplied.map((rule: { id: string }) => rule.id)).toEqual(["nvl", "dual"]);
        expect(converted.notConverted).toEqual([]);
        expect(converted).not.toHaveProperty("confidenceScore");

        const partial = JSON.parse((await call({ query: "SELECT ROWNUM, name FROM emp" }))?.result.content[0].text);
        expect(partial.notConverted.length).toBeGreaterThan(0);

        const unsupported = await call({ query: "SELECT 1", sourceDialect: "postgres" });
        expect(unsupported?.result.isError).toBe(true);
    });

    it("converts a whole script with one status per statement, and leaves procedures and DDL alone", async () => {
        const call = async (args: Record<string, unknown>) =>
            server.handleMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "goforge_modernize_query", arguments: args } });
        const script = `SET LINESIZE 80
SELECT NVL(bonus, 0) FROM emp;
SELECT TRUNC(hired) FROM emp;
SELECT name FROM emp WHERE id = 1;
CREATE TABLE t (a NUMBER);
CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;
/
SELECT * FROM emp WHERE ROWNUM <= 10 ORDER BY salary DESC;`;

        const answer = JSON.parse((await call({ script, sourceDialect: "oracle" }))?.result.content[0].text);
        expect(answer.summary.statements).toBe(7);
        expect(answer.summary.byStatus).toEqual({ converted: 1, unchanged: 1, review: 1, failed: 1, "out-of-scope": 3 });
        expect(answer.summary.checkedBy).toMatch(/grammar only/);
        // by default only what needs attention is listed
        expect(answer.statements.map((s: { status: string }) => s.status).sort()).toEqual(["failed", "out-of-scope", "out-of-scope", "out-of-scope", "review"]);
        const failed = answer.statements.find((s: { status: string }) => s.status === "failed");
        expect(failed.notConverted[0].construct).toMatch(/TRUNC/);
        expect(failed).not.toHaveProperty("convertedSql");
        expect(answer).not.toHaveProperty("convertedScript");
        expect(JSON.stringify(answer)).not.toMatch(/confidence/i);

        const all = JSON.parse((await call({ script, statements: "all", includeConvertedScript: true, includeReport: true }))?.result.content[0].text);
        expect(all.statements).toHaveLength(7);
        expect(all.statements.find((s: { status: string }) => s.status === "converted").convertedSql).toBe("SELECT COALESCE(bonus, 0) FROM emp");
        expect(all.convertedScript).toContain("SELECT COALESCE(bonus, 0) FROM emp;");
        expect(all.reportMarkdown).toMatch(/^# Migration report: pasted script \(Oracle to PostgreSQL\)/);

        const limited = JSON.parse((await call({ script, statements: "all", maxStatements: 2 }))?.result.content[0].text);
        expect(limited.statements).toHaveLength(2);
        expect(limited.statementsNotListed).toBe(5);

        const none = JSON.parse((await call({ script, statements: "none" }))?.result.content[0].text);
        expect(none.statements).toEqual([]);
        expect(none.summary.statements).toBe(7);
    });

    it("needs exactly one of query and script, and refuses a script that is too large", async () => {
        const call = async (args: Record<string, unknown>) =>
            server.handleMessage({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "goforge_modernize_query", arguments: args } });
        expect((await call({}))?.result.isError).toBe(true);
        expect((await call({ query: "SELECT 1", script: "SELECT 2" }))?.result.isError).toBe(true);
        expect((await call({ script: "x".repeat(5_000_001) }))?.result.isError).toBe(true);
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
