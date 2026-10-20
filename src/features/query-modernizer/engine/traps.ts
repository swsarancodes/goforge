import { Ctx } from "./context";
import { Group, Node, Token, flatten, isGroup, isOp, isToken, isWord, textOf } from "./tokens";

/**
 * Differences that don't make the SQL fail but change what it returns. These are found from the original query, so the
 * warning is there whether or not a rule changed anything.
 */
export function detectSourceTraps(tokens: Token[], ctx: Ctx): void {
    const isName = (token: Token | undefined) => token !== undefined && (token.kind === "word" || token.kind === "ident");
    const has = (name: string) => tokens.some((token) => token.kind === "word" && token.text.toUpperCase() === name);

    if (ctx.dialect === "oracle") {
        if (tokens.some((token) => token.kind === "string" && token.value === "")) {
            ctx.trap({
                id: "oracle-empty-string",
                severity: "changes-results",
                title: "Oracle treats '' as NULL",
                explanation: "In Oracle an empty string is NULL, so col = '' is never true and col || '' can return NULL. In PostgreSQL '' is an empty string that compares equal to other empty strings. Check every place this query or the data it reads depends on it.",
            });
        }
        const concat = tokens.some((token, index) => token.kind === "op" && token.text === "||" && (isName(tokens[index - 1]) || isName(tokens[index + 1]) || tokens[index - 1]?.text === ")" || tokens[index + 1]?.text === "("));
        if (concat) {
            ctx.trap({
                id: "oracle-concat-null",
                severity: "changes-results",
                title: "|| with a NULL gives a different result",
                explanation: "Oracle treats NULL as an empty string in a || concatenation ('a' || NULL is 'a'). In PostgreSQL the result is NULL. Wrap nullable columns in COALESCE(col, '') or use concat().",
            });
        }
        if (tokens.filter((token) => token.kind === "word" && /^NEXTVAL$/i.test(token.text)).length > 1) {
            ctx.trap({
                id: "sequence-per-row",
                severity: "changes-results",
                title: "NEXTVAL used more than once in a statement",
                explanation: "Oracle returns the same sequence value for every reference to seq.NEXTVAL in one row. PostgreSQL calls nextval() each time it is written, so two references give two different numbers.",
            });
        }
        if (substrFromZero(tokens)) {
            ctx.trap({
                id: "substr-zero",
                severity: "changes-results",
                title: "SUBSTR(x, 0, n) starts one character earlier in PostgreSQL",
                explanation: "Oracle treats a start position of 0 as 1. PostgreSQL counts 0 as the position before the first character, so SUBSTR(x, 0, 3) returns two characters instead of three. Use a start of 1.",
            });
        }
    }

    if (ctx.dialect === "oracle" || ctx.dialect === "mysql") {
        if (has("GREATEST") || has("LEAST")) {
            ctx.trap({
                id: "greatest-least-null",
                severity: "changes-results",
                title: "GREATEST / LEAST and NULL",
                explanation: "In the source database a single NULL argument makes GREATEST / LEAST return NULL. PostgreSQL ignores NULL arguments and returns the greatest of the others.",
            });
        }
    }

    if (ctx.dialect === "mssql" || ctx.dialect === "mysql") {
        const compares = tokens.some((token, index) => {
            if (token.kind !== "string" || !/[A-Za-z]/.test(token.value ?? "")) return false;
            const before = tokens[index - 1];
            const after = tokens[index + 1];
            const isComparison = (candidate: Token | undefined) => candidate !== undefined && ((candidate.kind === "op" && ["=", "<>", "!="].includes(candidate.text)) || (candidate.kind === "word" && candidate.text.toUpperCase() === "LIKE"));
            return isComparison(before) || isComparison(after);
        });
        if (compares) {
            ctx.trap({
                id: "case-insensitive-compare",
                severity: "changes-results",
                title: "Text comparisons were case-insensitive",
                explanation: "With the default collation of the source database, 'abc' = 'ABC' and LIKE 'a%' matches 'Alice'. PostgreSQL compares text exactly, so the same query can return fewer rows. Use ILIKE, lower(col) = lower(value), or a case-insensitive collation (citext) where that was relied on.",
            });
        }
        if (tokens.some((token, index) => token.kind === "word" && token.text.toUpperCase() === "ORDER" && tokens[index + 1]?.text.toUpperCase() === "BY")) {
            ctx.trap({
                id: "null-order",
                severity: "check",
                title: "NULLs sort first here, last in PostgreSQL",
                explanation: "SQL Server and MySQL put NULLs first in ascending order. PostgreSQL puts them last. If the column can be NULL, add NULLS FIRST (ascending) or NULLS LAST (descending) to keep the old order.",
            });
        }
    }

    if (ctx.dialect === "mysql") {
        if (tokens.some((token) => token.kind === "op" && token.text === "||")) {
            ctx.trap({
                id: "mysql-pipes-or",
                severity: "changes-results",
                title: "|| means OR in MySQL",
                explanation: "Unless the server runs with PIPES_AS_CONCAT, MySQL reads a || b as a logical OR. PostgreSQL reads it as text concatenation, so the same text does something different.",
            });
        }
    }

    if ((ctx.dialect === "mysql" || ctx.dialect === "oracle") && tokens.some((token) => token.kind === "op" && token.text === "/")) {
        ctx.trap({
            id: "integer-division",
            severity: "check",
            title: "Dividing two integers",
            explanation: `${ctx.dialect === "oracle" ? "Oracle's numbers divide exactly" : "MySQL's / always returns a decimal"} (5 / 2 = 2.5). PostgreSQL returns an integer when both sides are integers (5 / 2 = 2). Cast one side to numeric where the fraction matters.`,
        });
    }
}

/** SUBSTR(<anything>, 0 ...) */
function substrFromZero(tokens: Token[]): boolean {
    for (let i = 0; i < tokens.length - 3; i++) {
        if (tokens[i].kind === "word" && /^SUBSTR(ING)?$/i.test(tokens[i].text) && tokens[i + 1].text === "(") {
            let depth = 0;
            for (let j = i + 2; j < tokens.length; j++) {
                const text = tokens[j].text;
                if (text === "(") depth++;
                else if (text === ")") {
                    if (depth === 0) break;
                    depth--;
                } else if (text === "," && depth === 0) {
                    if (tokens[j + 1]?.kind === "number" && tokens[j + 1].text === "0") return true;
                    break;
                }
            }
        }
    }
    return false;
}

const LEGACY_KEYWORDS: Record<string, { reason: string; hint?: string; dialects: string[] }> = {
    CONNECT_BY_ROOT: { reason: "CONNECT_BY_ROOT has no direct equivalent", hint: "Carry the root value through a recursive CTE.", dialects: ["oracle"] },
    CONNECT_BY_ISLEAF: { reason: "CONNECT_BY_ISLEAF has no direct equivalent", dialects: ["oracle"] },
    PRIOR: { reason: "PRIOR is only valid inside CONNECT BY", dialects: ["oracle"] },
    NOCYCLE: { reason: "NOCYCLE has no direct equivalent", dialects: ["oracle"] },
    PIVOT: { reason: "PIVOT has no PostgreSQL syntax", hint: "Use conditional aggregation: sum(CASE WHEN … END).", dialects: ["oracle", "mssql"] },
    UNPIVOT: { reason: "UNPIVOT has no PostgreSQL syntax", hint: "Use a LATERAL join over a VALUES list.", dialects: ["oracle", "mssql"] },
    MODEL: { reason: "The MODEL clause has no PostgreSQL equivalent", dialects: ["oracle"] },
    SAMPLE: { reason: "SAMPLE clause has no direct equivalent", hint: "Use TABLESAMPLE BERNOULLI (percent).", dialects: ["oracle"] },
};

/** Constructs that survived conversion but won't work in PostgreSQL. */
export function auditLeftovers(items: Node[], ctx: Ctx, converted: { hierarchy: boolean }): void {
    const visit = (list: Node[]) => {
        list.forEach((node, index) => {
            if (isGroup(node)) {
                visit(node.items);
                return;
            }
            if (node.kind === "outer") {
                ctx.unsupported(textOf(list.slice(Math.max(0, index - 3), index + 1)), "The (+) outer join marker was left in place");
                return;
            }
            if (node.kind !== "word") return;
            const name = node.text.toUpperCase();
            if (name === "ROWNUM" && isWord(node)) {
                ctx.unsupported(textOf(list.slice(Math.max(0, index - 1), index + 3)), "ROWNUM is used outside the patterns that can be converted (WHERE ROWNUM <= n, and the ROWNUM paging subquery)", "Use LIMIT, or row_number() OVER (ORDER BY …) if you need the number.");
            } else if (name === "ROWID") {
                ctx.unsupported(textOf(list.slice(Math.max(0, index - 1), index + 2)), "ROWID has no stable PostgreSQL equivalent (ctid changes when a row is updated or the table is rewritten)", "Use the table's primary key.");
            } else if (ctx.dialect === "oracle" && /^(DBMS_|UTL_|APEX_)/.test(name)) {
                ctx.unsupported(textOf(list.slice(Math.max(0, index - 1), index + 3)), `${node.text} is an Oracle built-in package; PostgreSQL has no equivalent`);
            } else if (LEGACY_KEYWORDS[name]) {
                const entry = LEGACY_KEYWORDS[name];
                if (entry.dialects.includes(ctx.dialect)) ctx.unsupported(textOf(list.slice(Math.max(0, index - 1), index + 3)), entry.reason, entry.hint);
            } else if (name === "LEVEL" && !converted.hierarchy && ctx.dialect === "oracle" && !isToken(list[index - 1])) {
                ctx.unsupported("LEVEL", "LEVEL is only available inside a hierarchical (CONNECT BY) query");
            }
        });
    };
    visit(items);
}

/** `@x`, `:name`, `?` and friends: bind variables. */
export function collectParameters(nodes: Node[]): string[] {
    const found = new Set<string>();
    for (const token of flatten(nodes)) if (token.kind === "param") found.add(token.text);
    return [...found];
}

export function replaceParameters(nodes: Node[]): Node[] {
    return nodes.map((node) => {
        if (isGroup(node)) return { ...node, items: replaceParameters(node.items) } as Group;
        if (isToken(node) && node.kind === "param") return { kind: "word", text: "NULL", ws: node.ws } as Token;
        return node;
    });
}
