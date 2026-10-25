/**
 * A stand-in for the OpenAI Responses endpoint, to try the Schema Change page without an OpenAI key or a model:
 *
 *   server/node_modules/.bin/tsx scripts/fake-model-server.ts          # listens on 127.0.0.1:4010
 *   then start the API with
 *     OPENAI_BASE_URL=http://127.0.0.1:4010/v1 OPENAI_API_KEY=fake OPENAI_MODEL=fake-model npm --prefix server run dev
 *
 * The API sends its real requests to it, so the whole path from the page to the wire is the one a real model would use.
 * It does no thinking. For a plan request it reads the tables it was shown and proposes a few operations that exist on them (a nullable column,
 * an index, NOT NULL on a nullable column, a wider integer), so the page has something real to compile. It reports no token usage, which makes
 * the page show its own estimate. Nothing here says anything about what a real model would answer.
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 4010);

interface Table {
    name: string;
    rows: number | null;
    columns: { name: string; type: string; notNull: boolean }[];
    primaryKey: string[];
    indexes: { name: string; columns: string[] }[];
}

/** "add a testimonials table ..." / "create a new table for reviews": a create_table, linked to the first existing table it was told about. */
function createTablePlan(input: { request: string; tables: Table[]; otherTables?: string[] }) {
    const named = input.request.match(/\b([a-z][a-z0-9_]*)\s+table\b/i)?.[1] ?? input.request.match(/\btable\s+(?:for|called|named)\s+([a-z][a-z0-9_]*)/i)?.[1] ?? "new_table";
    const name = ["a", "new", "the", "another"].includes(named.toLowerCase()) ? "new_table" : named.toLowerCase();
    const parent = input.tables[0]?.name ?? input.otherTables?.[0];
    const parentBare = parent?.split(".").pop() ?? "";
    const operations: unknown[] = [
        {
            type: "create_table",
            table: {
                name: parent?.includes(".") ? `${parent.split(".")[0]}.${name}` : name,
                fields: [
                    { name: "id", dataType: "bigint", primaryKey: true, autoIncrement: true },
                    ...(parent ? [{ name: `${parentBare.replace(/s$/, "")}_id`, dataType: "bigint", nullable: false }] : []),
                    { name: "body", dataType: "text" },
                    { name: "created_at", dataType: "timestamptz", nullable: false, defaultValue: "now()" },
                ],
            },
        },
    ];
    if (parent) operations.push({ type: "add_relationship", relationship: { sourceTable: parent, sourceColumn: "id", targetTable: parent.includes(".") ? `${parent.split(".")[0]}.${name}` : name, targetColumn: `${parentBare.replace(/s$/, "")}_id` } });
    return { summary: `Create ${name}${parent ? `, linked to ${parent}` : ""} (a stand-in answer, not a model's).`, assumptions: [], warnings: [], clarifyingQuestions: [], operations };
}

/** "remove the default from ..." : the first column the facts say has a default, with the default dropped (written as strict mode makes a model write it). */
function dropDefaultPlan(input: { tables: (Table & { columns: { name: string; hasDefault?: boolean }[] })[] }) {
    for (const table of input.tables) {
        const column = table.columns.find((candidate) => candidate.hasDefault);
        if (column) return { summary: `Remove the default of ${table.name}.${column.name} (a stand-in answer, not a model's).`, assumptions: [], warnings: [], clarifyingQuestions: [], operations: [{ type: "alter_column", tableName: table.name, columnName: column.name, changes: { dropDefault: true } }] };
    }
    return { summary: "No column has a default.", assumptions: [], warnings: [], clarifyingQuestions: ["Which column should lose its default?"], operations: [] };
}

function planFor(input: { request: string; tables: Table[]; otherTables?: string[] }) {
    if (/\bdefault\b/i.test(input.request) && /\b(remove|drop|delete)\b/i.test(input.request)) return dropDefaultPlan(input as never);
    if (/\b(create|add|new)\b[^.]*\btable\b/i.test(input.request)) return createTablePlan(input);
    // the biggest table it was shown that has an integer column, else the biggest one
    const tables = [...input.tables].sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0) || Number(b.columns.some((c) => c.type === "integer")) - Number(a.columns.some((c) => c.type === "integer")) || a.name.localeCompare(b.name));
    const operations: unknown[] = [];
    const first = tables[0];
    if (first) {
        const taken = new Set(first.columns.map((column) => column.name));
        if (!taken.has("reviewed_at")) operations.push({ type: "add_column", tableName: first.name, field: { name: "reviewed_at", dataType: "timestamptz" } });
        const candidate = first.columns.find((column) => !first.primaryKey.includes(column.name) && !first.indexes.some((index) => index.columns[0] === column.name) && !column.type.startsWith("text"));
        if (candidate) operations.push({ type: "add_index", tableName: first.name, index: { name: `fake_${first.name.replace(/[^a-z0-9_]/gi, "_").slice(-30)}_${candidate.name}_idx`, columns: [candidate.name] } });
        const nullable = first.columns.find((column) => !column.notNull && !first.primaryKey.includes(column.name) && /(_id|status|code)$/.test(column.name));
        if (nullable) operations.push({ type: "alter_column", tableName: first.name, columnName: nullable.name, changes: { nullable: false } });
        const integer = first.columns.find((column) => column.type === "integer");
        if (integer) operations.push({ type: "alter_column", tableName: first.name, columnName: integer.name, changes: { dataType: "bigint" } });
    }
    return { summary: `Proposed ${operations.length} change${operations.length === 1 ? "" : "s"} to ${first?.name ?? "nothing"} (a stand-in answer, not a model's).`, assumptions: [], warnings: [], clarifyingQuestions: operations.length === 0 ? ["Which table should change?"] : [], operations };
}

function summaryFor(input: { findings: { id: string; category: string; table: string | null; object: string | null; bytes: number | null }[] }) {
    const sorted = [...input.findings].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 4);
    return {
        headline: `${input.findings.length} findings were shown to this stand-in; it ordered them by size.`,
        priorities: sorted.map((finding) => ({ findingIds: [finding.id], why: `${finding.category} on ${finding.table ?? finding.object ?? "the database"}${finding.bytes ? ` involves ${finding.bytes} bytes` : ""}.` })),
    };
}

/** A value that satisfies a JSON schema, for a prompt this stand-in has no answer for: placeholder text, true, 0, empty lists, null where allowed. */
function placeholderFor(schema: any): unknown {
    if (!schema || typeof schema !== "object") return null;
    if (Array.isArray(schema.anyOf)) return placeholderFor(schema.anyOf.find((candidate: any) => candidate.type !== "null") ?? schema.anyOf[0]);
    if (schema.const !== undefined) return schema.const;
    if (Array.isArray(schema.enum)) return schema.enum[0];
    if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key, (child as any)?.nullable ? null : placeholderFor(child)]));
    if (schema.type === "array") return [];
    if (schema.type === "string") return "check";
    if (schema.type === "boolean") return true;
    return 0;
}

/**
 * What a model that was given a strict JSON schema would send: every key of every object present, the ones the answer does not use as
 * null. This stand-in fills its (loose) answers out the same way, so the page is tried with the shape a real model is held to.
 */
function completeToSchema(value: unknown, schema: any): unknown {
    if (!schema || typeof schema !== "object") return value;
    if (Array.isArray(schema.anyOf)) {
        const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
        const variant = schema.anyOf.find((candidate: any) => candidate.properties?.type?.const !== undefined && candidate.properties.type.const === record?.type) ?? schema.anyOf.find((candidate: any) => candidate.type !== "null");
        return value === null || value === undefined ? null : completeToSchema(value, variant);
    }
    if (schema.type === "array") return Array.isArray(value) ? value.map((item) => completeToSchema(item, schema.items)) : value;
    if (schema.type === "object" && schema.properties) {
        const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, key in record && record[key] !== undefined ? completeToSchema(record[key], child) : null]));
    }
    return value;
}

http
    .createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const reply = (status: number, body: unknown) => {
                response.writeHead(status, { "Content-Type": "application/json" });
                response.end(JSON.stringify(body));
            };
            if (request.method === "GET" && request.url === "/v1/models") return reply(200, { object: "list", data: [{ id: "fake-model", object: "model", owned_by: "stand-in" }] });
            if (request.method !== "POST" || request.url !== "/v1/responses") return reply(404, { error: { message: "only POST /v1/responses and GET /v1/models", type: "invalid_request_error", code: null } });
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { instructions?: string; input?: string; text?: { format?: { type?: string; schema?: unknown } } };
                const system = body.instructions ?? "";
                const user = body.input ?? "";
                // Anything it has no answer for is a placeholder that satisfies the schema it was given (or {"ok": true} when it was given none).
                const requested = body.text?.format;
                let answer: unknown = requested?.type === "json_schema" ? placeholderFor(requested.schema) : { ok: true };
                if (system.startsWith("You are GoForge's schema change planner")) answer = planFor(JSON.parse(user));
                else if (system.startsWith("You are GoForge's database schema planning engine")) {
                    // the diagram's AI Schema panel: the same kind of plan, from a differently shaped request
                    const asked = JSON.parse(user) as { userRequest: string; currentSchema: { tables: { name: string }[] } };
                    answer = createTablePlan({ request: asked.userRequest, tables: asked.currentSchema.tables as never });
                } else if (system.startsWith("You summarise a PostgreSQL schema health report")) answer = summaryFor(JSON.parse(user));
                else if (system.startsWith("You are GoForge's SQL migration engine")) {
                    const asked = JSON.parse(user) as { originalQuery: string; ruleBasedDraft?: { sql?: string } | null };
                    answer = { sql: asked.ruleBasedDraft?.sql ?? asked.originalQuery, summary: "Kept the rules' draft (a stand-in answer, not a model's).", changes: [], risks: [], unsupported: [] };
                }
                // With a schema the answer is held to it, as it would be by OpenAI; without one it is left as it is.
                const format = body.text?.format;
                if (format?.type === "json_schema") answer = completeToSchema(answer, format.schema);
                reply(200, { id: "resp_stand_in", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] });
            } catch (error) {
                reply(400, { error: { message: error instanceof Error ? error.message : String(error), type: "invalid_request_error", code: null } });
            }
        });
    })
    .listen(PORT, "127.0.0.1", () => console.log(`fake OpenAI endpoint on http://127.0.0.1:${PORT}/v1`));
