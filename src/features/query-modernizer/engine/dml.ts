import { Ctx } from "./context";
import { Group, Node, Token, group, isGroup, isOp, isPunct, isToken, isWord, normalize, print, splitTopLevel, textOf, tpl, upper } from "./tokens";

/**
 * INSERT / UPDATE / DELETE / MERGE. The queries inside them are converted by the generic walker; these rules handle the
 * statement shapes that differ: MySQL's INSERT IGNORE and ON DUPLICATE KEY UPDATE, DELETE without FROM, MERGE.
 */

const isNameToken = (node: Node | undefined): node is Token => isToken(node) && (node.kind === "word" || node.kind === "ident");

/** The table in INSERT INTO t / UPDATE t / DELETE FROM t. */
function tableAfter(items: Node[], start: number): { name: Token; end: number } | undefined {
    let i = start;
    let last: Token | undefined;
    while (isNameToken(items[i])) {
        last = items[i] as Token;
        i++;
        if (isPunct(items[i], ".") && isNameToken(items[i + 1])) i++;
        else break;
    }
    return last ? { name: last, end: i } : undefined;
}

export function rewriteInsert(items: Node[], ctx: Ctx): Node[] {
    if (ctx.dialect !== "mysql") return items;
    let out = items;

    // INSERT IGNORE INTO t ... -> INSERT INTO t ... ON CONFLICT DO NOTHING
    if (isWord(out[0], "INSERT") && isWord(out[1], "IGNORE")) {
        const before = textOf(out.slice(0, 3));
        out = [out[0], ...out.slice(2)];
        const semicolon = isPunct(out[out.length - 1], ";") ? out.pop() : undefined;
        out = [...out, ...tpl`ON CONFLICT DO NOTHING`, ...(semicolon ? [semicolon] : [])];
        ctx.apply("insert-ignore", before, "INSERT INTO … ON CONFLICT DO NOTHING");
        ctx.trap({
            id: "insert-ignore-errors",
            severity: "check",
            title: "INSERT IGNORE hid more than duplicate-key errors",
            explanation: "MySQL's INSERT IGNORE also turns data errors (values too long, bad conversions) into warnings. ON CONFLICT DO NOTHING only skips rows that violate the unique key; other errors now stop the statement.",
        });
        return out;
    }

    const dupIndex = out.findIndex((node, i) => isWord(node, "ON") && isWord(out[i + 1], "DUPLICATE") && isWord(out[i + 2], "KEY") && isWord(out[i + 3], "UPDATE"));
    if (dupIndex < 0) return out;

    const into = out.findIndex((node) => isWord(node, "INTO"));
    const table = into >= 0 ? tableAfter(out, into + 1) : undefined;
    const construct = textOf(out.slice(dupIndex));
    if (!table) {
        ctx.unsupported(construct, "Couldn't find the table of the INSERT");
        return out;
    }
    const tableName = (table.name.value ?? table.name.text).toLowerCase();
    const key = ctx.schema.primaryKey(tableName) ?? ctx.schema.uniqueColumns(tableName);
    if (!key) {
        ctx.unsupported(construct, `ON DUPLICATE KEY UPDATE needs the unique columns named in PostgreSQL, and ${tableName} is not on your canvas with a primary key`, "Write ON CONFLICT (columns) DO UPDATE SET … using EXCLUDED.column for the new values.");
        return out;
    }

    const end = isPunct(out[out.length - 1], ";") ? out.length - 1 : out.length;
    const assignments = splitTopLevel(out.slice(dupIndex + 4, end));
    const rewritten = assignments.map((assignment) => qualifyAssignment(assignment, tableName, ctx));
    const set: Node[] = [];
    rewritten.forEach((assignment, index) => {
        if (index > 0) set.push({ kind: "punct", text: "," });
        set.push(...normalize(assignment));
    });
    const result = [...out.slice(0, dupIndex), ...tpl`ON CONFLICT (${key.join(", ")}) DO UPDATE SET`, ...set, ...out.slice(end)];
    ctx.apply("on-duplicate-key", construct, `ON CONFLICT (${key.join(", ")}) DO UPDATE SET …`);
    return result;
}

/** `v = VALUES(v)` -> `v = EXCLUDED.v`; bare column names on the right are qualified with the table (PostgreSQL finds them ambiguous otherwise). */
function qualifyAssignment(assignment: Node[], table: string, ctx: Ctx): Node[] {
    const equals = assignment.findIndex((node) => isOp(node, "="));
    if (equals < 0) return assignment;
    const left = assignment.slice(0, equals + 1);
    const column = isNameToken(assignment[0]) ? ((assignment[0] as Token).value ?? (assignment[0] as Token).text).toLowerCase() : undefined;

    const visit = (list: Node[]): Node[] => {
        const out: Node[] = [];
        for (let i = 0; i < list.length; i++) {
            const node = list[i];
            if (isGroup(node)) {
                const isQuery = isWord(node.items[0], "SELECT", "WITH");
                out.push(isQuery ? node : { ...node, items: visit(node.items) });
                continue;
            }
            if (isWord(node, "VALUES") && isGroup(list[i + 1])) {
                const inner = (list[i + 1] as Group).items;
                out.push(...tpl`EXCLUDED.${textOf(inner)}`.map((token, index) => (index === 0 ? { ...token, ws: (node as Token).ws } : token)));
                i++;
                continue;
            }
            if (isNameToken(node) && !isPunct(list[i - 1], ".") && !isPunct(list[i + 1], ".") && !isGroup(list[i + 1])) {
                const name = (node.value ?? node.text).toLowerCase();
                if (name === column || ctx.schema.typeOf(name, table) !== undefined) {
                    out.push(...tpl`${table}.${node.text}`.map((token, index) => (index === 0 ? { ...token, ws: node.ws } : token)));
                    continue;
                }
            }
            out.push(node);
        }
        return out;
    };
    return [...left, ...visit(assignment.slice(equals + 1))];
}

export function rewriteDelete(items: Node[], ctx: Ctx): Node[] {
    // DELETE emp WHERE ...  ->  DELETE FROM emp WHERE ...
    if (!isWord(items[0], "DELETE")) return items;
    if (ctx.dialect === "mysql" && items.some((node) => isWord(node, "LIMIT", "ORDER"))) {
        ctx.unsupported(textOf(items), "DELETE with LIMIT or ORDER BY has no PostgreSQL syntax", "Delete by primary key from a subquery: DELETE FROM t WHERE id IN (SELECT id … LIMIT n).");
        return items;
    }
    if (ctx.dialect === "mssql" && items.some((node, i) => i > 1 && isWord(node, "FROM"))) {
        ctx.unsupported(textOf(items), "DELETE … FROM … JOIN has no PostgreSQL syntax", "Use DELETE FROM t USING other WHERE … .");
        return items;
    }
    if (isWord(items[1], "FROM")) return items;
    if (isNameToken(items[1])) {
        const out = [items[0], ...tpl`FROM`, ...items.slice(1)];
        ctx.apply("delete-from", "DELETE t", "DELETE FROM t");
        return out;
    }
    return items;
}

export function checkUpdate(items: Node[], ctx: Ctx): void {
    if (!isWord(items[0], "UPDATE")) return;
    if (ctx.dialect === "mssql" && items.some((node, i) => i > 0 && isWord(node, "FROM"))) {
        ctx.unsupported(textOf(items.slice(0, 6)) + " …", "UPDATE … FROM … JOIN is written differently in PostgreSQL", "Use UPDATE t SET … FROM other WHERE t.id = other.id.");
    }
    if (ctx.dialect === "mysql" && (items.some((node) => isWord(node, "JOIN")) || items.some((node) => isWord(node, "LIMIT")))) {
        ctx.unsupported(textOf(items.slice(0, 6)) + " …", "UPDATE with JOIN or LIMIT has no PostgreSQL syntax", "Use UPDATE t SET … FROM other WHERE …, or update by primary key from a subquery.");
    }
}

/** MERGE: strip table qualifiers from the columns on the left of SET. */
export function rewriteMerge(items: Node[], ctx: Ctx): Node[] {
    if (!isWord(items[0], "MERGE")) return items;
    if (items.some((node) => isWord(node, "OUTPUT"))) {
        ctx.unsupported(textOf(items.slice(0, 8)) + " …", "MERGE … OUTPUT has no PostgreSQL equivalent before version 17", "Use RETURNING with PostgreSQL 17+, or run the changes as separate statements.");
        return items;
    }
    const out: Node[] = [];
    let changed = false;
    for (let i = 0; i < items.length; i++) {
        const node = items[i];
        if (isWord(node, "DELETE") && isWord(items[i + 1], "WHERE") && isWord(items[i - 1], "UPDATE", "SET") === false) {
            ctx.unsupported(textOf(items.slice(i, i + 4)), "MERGE … DELETE WHERE inside WHEN MATCHED is written as a separate WHEN MATCHED AND … THEN DELETE clause in PostgreSQL");
        }
        if (isWord(node, "SET") && isWord(items[i - 1], "UPDATE")) {
            out.push(node);
            // assignments until the next WHEN / end
            let j = i + 1;
            const body: Node[] = [];
            while (j < items.length && !isWord(items[j], "WHEN") && !isPunct(items[j], ";")) {
                body.push(items[j]);
                j++;
            }
            const stripped = splitTopLevel(body).map((assignment) => {
                if (assignment.length >= 4 && isNameToken(assignment[0]) && isPunct(assignment[1], ".") && isNameToken(assignment[2])) {
                    changed = true;
                    return [{ ...(assignment[2] as Token), ws: (assignment[0] as Token).ws }, ...assignment.slice(3)];
                }
                return assignment;
            });
            stripped.forEach((assignment, index) => {
                if (index > 0) out.push({ kind: "punct", text: "," });
                out.push(...assignment);
            });
            i = j - 1;
            continue;
        }
        out.push(node);
    }
    ctx.apply("merge", "MERGE … SET t.col = …", "MERGE … SET col = …");
    void changed;
    ctx.trap({
        id: "merge-version",
        severity: "check",
        title: "MERGE needs PostgreSQL 15 or newer",
        explanation: "PostgreSQL added MERGE in version 15. On 14 and older, use INSERT … ON CONFLICT DO UPDATE instead.",
    });
    return out;
}

void group;
void print;
void upper;
