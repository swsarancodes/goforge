import { JsonRpcRequest, JsonRpcResponse } from "./types";
import { MCP_TOOLS, executeMcpTool } from "./tools";

export class GoForgeMcpServer {
    readonly name = "goforge-mcp";
    readonly version = "1.4.0";

    async handleMessage(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
        if (!request || typeof request !== "object") {
            return {
                jsonrpc: "2.0",
                error: { code: -32600, message: "Invalid Request" },
            };
        }

        const id = request.id;

        // Notification: notifications/initialized has no response
        if (request.method === "notifications/initialized") {
            return null;
        }

        switch (request.method) {
            case "initialize":
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        protocolVersion: "2024-11-05",
                        capabilities: {
                            tools: {},
                        },
                        serverInfo: {
                            name: this.name,
                            version: this.version,
                        },
                    },
                };

            case "ping":
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {},
                };

            case "tools/list":
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        tools: MCP_TOOLS,
                    },
                };

            case "tools/call": {
                const toolName = request.params?.name;
                const toolArgs = request.params?.arguments ?? {};

                if (!toolName) {
                    return {
                        jsonrpc: "2.0",
                        id,
                        error: {
                            code: -32602,
                            message: "Missing tool name in tools/call request",
                        },
                    };
                }

                const result = await executeMcpTool(toolName, toolArgs);
                return {
                    jsonrpc: "2.0",
                    id,
                    result,
                };
            }

            default:
                return {
                    jsonrpc: "2.0",
                    id,
                    error: {
                        code: -32601,
                        message: `Method not found: ${request.method}`,
                    },
                };
        }
    }

    startStdio(stdin: NodeJS.ReadableStream = process.stdin, stdout: NodeJS.WritableStream = process.stdout): void {
        let buffer = "";

        stdin.setEncoding("utf8");
        stdin.on("data", async (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                try {
                    const parsed: JsonRpcRequest = JSON.parse(trimmed);
                    const response = await this.handleMessage(parsed);
                    if (response) {
                        stdout.write(JSON.stringify(response) + "\n");
                    }
                } catch (err: any) {
                    const errorResponse: JsonRpcResponse = {
                        jsonrpc: "2.0",
                        error: {
                            code: -32700,
                            message: `Parse error: ${err?.message ?? String(err)}`,
                        },
                    };
                    stdout.write(JSON.stringify(errorResponse) + "\n");
                }
            }
        });
    }
}
