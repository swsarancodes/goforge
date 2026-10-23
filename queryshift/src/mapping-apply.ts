import { buildTree, isGroup, isPunct, isToken, isWord, print, splitTopLevel, tokenize, type Node, type Token } from "../../src/features/query-modernizer/engine/tokens";
import type { MappingRow } from "./mapping";

/**
 * Renames the legacy tables and columns in a query to their target names, from the schema mapping, and nothing else. The rule engine knows
 * SQL dialects, not this schema: its output still says CUST_MST and CUST_NM. This is the deterministic step between "the dialect is
 * converted" and "the query can run on the target tables".
 *
 * A column that is renamed and sits alone in a select list gets its legacy name back as an alias (`c.CUST_ID` becomes
 * `c.customer_id AS CUST_ID`), because the result's column names are part of what the original returned.
 * Anything it cannot decide (one legacy column name that maps to different target names in different tables) is returned as an issue,
 * and the query is left unrenamed rather than guessed at.
 */
export interface MappingApplied {
    sql: string;
    issues: string[];
}

export function applyMapping(sql: string, mapping: MappingRow[], dialect: "oracle" | "mssql" | "mysql" | "db2" = "oracle"): MappingApplied {
    const tables = new Map<string, string>();
    const columns = new Map<string, Set<string>>();
    for (const row of mapping) {
        tables.set(row.sourceTable.toLowerCase(), row.targetTable);
        const key = row.sourceColumn.toLowerCase();
        columns.set(key, new Set([...(columns.get(key) ?? []), row.targetColumn]));
    }

    const issues: string[] = [];
    let tree: Node[];
    try {
        tree = buildTree(tokenize(sql, dialect));
    } catch (error) {
        return { sql, issues: [`The query could not be read: ${error instanceof Error ? error.message : String(error)}`] };
    }

    const renamedColumn = (token: Token): string | undefined => {
        const targets = columns.get(token.text.toLowerCase());
        if (!targets) return undefined;
        if (targets.size > 1) {
            const message = `The legacy column ${token.text.toUpperCase()} maps to different columns in different tables (${[...targets].join(", ")}); it cannot be renamed without knowing which table it belongs to.`;
            if (!issues.includes(message)) issues.push(message);
            return undefined;
        }
        return [...targets][0];
    };

    // 1. a lone column in a select list keeps its legacy name as the output name
    const addAliases = (nodes: Node[]) => {
        for (let start = 0; start < nodes.length; start++) {
            if (!isWord(nodes[start], "SELECT")) continue;
            let from = start + 1;
            if (isWord(nodes[from], "DISTINCT", "ALL")) from++;
            let end = from;
            while (end < nodes.length && !isWord(nodes[end], "FROM", "UNION", "INTERSECT", "EXCEPT", "MINUS")) end++;
            const items = splitTopLevel(nodes.slice(from, end));
            const rebuilt: Node[] = [];
            items.forEach((item, index) => {
                const last = item[item.length - 1];
                const bare = (item.length === 1 && isToken(last) && last.kind === "word") || (item.length === 3 && isToken(item[0]) && item[0].kind === "word" && isPunct(item[1], ".") && isToken(last) && last.kind === "word");
                const target = bare && isToken(last) ? renamedColumn(last) : undefined;
                const withAlias = target && isToken(last) && target.toLowerCase() !== last.text.toLowerCase() ? [...item, { kind: "word", text: "AS" } as Token, { kind: "word", text: last.text } as Token] : item;
                if (index > 0) rebuilt.push({ kind: "punct", text: "," } as Token);
                rebuilt.push(...withAlias);
            });
            nodes.splice(from, end - from, ...rebuilt);
            start = from + rebuilt.length - 1;
        }
        for (const node of nodes) if (isGroup(node)) addAliases(node.items);
    };
    addAliases(tree);

    // 2. rename tables and columns, leaving function names and output aliases alone
    let previous: Token | undefined;
    const rename = (nodes: Node[]) => {
        nodes.forEach((node, index) => {
            if (isGroup(node)) {
                previous = node.open;
                rename(node.items);
                previous = node.close;
                return;
            }
            const token = node;
            const isFunction = isGroup(nodes[index + 1]);
            if (token.kind === "word" && !isFunction && !(previous && previous.kind === "word" && previous.text.toUpperCase() === "AS")) {
                const lower = token.text.toLowerCase();
                const table = tables.get(lower);
                const column = renamedColumn(token);
                if (table && column) {
                    const message = `${token.text.toUpperCase()} is both a legacy table and a legacy column name; it cannot be renamed safely.`;
                    if (!issues.includes(message)) issues.push(message);
                } else if (table) token.text = table;
                else if (column) token.text = column;
            }
            previous = token;
        });
    };
    rename(tree);

    if (issues.length > 0) return { sql, issues };
    return { sql: print(tree), issues };
}

