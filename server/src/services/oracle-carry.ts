import type oracledb from "oracledb";
import { oracledb as driver } from "./oracle-client.js";
import type { MigrationEdits, OracleTable, PlannedTable } from "./oracle-migration.js";
import { objectKey, oracleFamily, type OracleFamily } from "./oracle-type-edits.js";

/**
 * Indexes and CHECK constraints of an Oracle schema, and which of them the migration can carry into PostgreSQL faithfully. Nothing is
 * guessed: an index is carried when it is a plain B-tree on real columns, and a CHECK constraint only when its condition is written in a
 * small grammar whose meaning is the same in both databases (column and literal comparisons, IN, BETWEEN, IS NULL, AND, OR, NOT) over
 * columns whose type was not changed. Everything else stays behind with the reason. The person decides which of the carriable ones to
 * carry (edits.objects); by default none is, as before.
 */

export interface OracleIndex {
    name: string;
    table: string;
    unique: boolean;
    /** USER_INDEXES.INDEX_TYPE: NORMAL, BITMAP, FUNCTION-BASED NORMAL (also what a descending column makes it), ... */
    type: string;
    valid: boolean;
    partitioned: boolean;
    columns: { name: string; descending: boolean }[];
}

export interface OracleCheck {
    name: string;
    table: string;
    /** SEARCH_CONDITION_VC as Oracle stores it, as it was typed. */
    condition: string;
    enabled: boolean;
    validated: boolean;
}

export interface OracleObjects {
    indexes: OracleIndex[];
    checks: OracleCheck[];
}

export const NO_OBJECTS: OracleObjects = { indexes: [], checks: [] };

export type ObjectKind = "index" | "check";

export interface PlannedObject {
    kind: ObjectKind;
    oracleName: string;
    pgName: string;
    /** The Oracle table, and its PostgreSQL name. */
    table: string;
    pgTable: string;
    /** What it is, in a line: `on CLM_DTL (CLM_ID, CLM_DT), unique`, or `CLM_AMT >= 0`. */
    detail: string;
    /** It can be created in PostgreSQL with the same meaning. */
    carriable: boolean;
    /** Why it cannot; set when `carriable` is false. */
    reason?: string;
    /** The person asked for it, and it can be: it will be created. */
    carried: boolean;
    /** The PostgreSQL statement; present when it is carriable. */
    sql?: string;
}

// ---- reading ------------------------------------------------------------------------------------------------------------------------

export async function readOracleObjects(connection: oracledb.Connection): Promise<OracleObjects> {
    type Row = Record<string, unknown>;
    const run = async (sql: string): Promise<Row[]> => (await connection.execute(sql, [], { outFormat: driver.OUT_FORMAT_OBJECT })).rows as Row[];

    const indexRows = await run(
        `SELECT i.index_name, i.table_name, i.uniqueness, i.index_type, i.status, i.partitioned FROM user_indexes i
         WHERE i.table_name IN (SELECT table_name FROM user_tables WHERE secondary = 'N' AND temporary = 'N') AND i.table_name NOT LIKE 'BIN$%' AND i.index_type <> 'LOB'
           AND NOT EXISTS (SELECT 1 FROM user_constraints c WHERE c.index_name = i.index_name AND c.constraint_type IN ('P', 'U'))
         ORDER BY i.table_name, i.index_name`,
    );
    const columnRows = await run("SELECT index_name, column_name, descend FROM user_ind_columns ORDER BY index_name, column_position");
    const columnsOf = new Map<string, { name: string; descending: boolean }[]>();
    for (const row of columnRows) columnsOf.set(String(row.INDEX_NAME), [...(columnsOf.get(String(row.INDEX_NAME)) ?? []), { name: String(row.COLUMN_NAME), descending: row.DESCEND === "DESC" }]);

    const checkRows = await run(
        `SELECT constraint_name, table_name, search_condition_vc, status, validated FROM user_constraints
         WHERE constraint_type = 'C' AND table_name NOT LIKE 'BIN$%' AND NOT (generated = 'GENERATED NAME' AND search_condition_vc LIKE '"%" IS NOT NULL')
           AND table_name IN (SELECT table_name FROM user_tables WHERE secondary = 'N' AND temporary = 'N')
         ORDER BY table_name, constraint_name`,
    );
    return {
        indexes: indexRows.map((row) => ({
            name: String(row.INDEX_NAME),
            table: String(row.TABLE_NAME),
            unique: row.UNIQUENESS === "UNIQUE",
            type: String(row.INDEX_TYPE),
            valid: row.STATUS === "VALID",
            partitioned: row.PARTITIONED === "YES",
            columns: columnsOf.get(String(row.INDEX_NAME)) ?? [],
        })),
        checks: checkRows.map((row) => ({ name: String(row.CONSTRAINT_NAME), table: String(row.TABLE_NAME), condition: String(row.SEARCH_CONDITION_VC ?? "").trim(), enabled: row.STATUS === "ENABLED", validated: row.VALIDATED === "VALIDATED" })),
    };
}

// ---- translating a CHECK condition --------------------------------------------------------------------------------------------------

export interface CheckColumn {
    oracleName: string;
    pgName: string;
    family: OracleFamily;
    pgType: string;
    /** The person gave the column another type: a condition written for the old one no longer means the same. */
    typeEdited: boolean;
}

type Cls = "num" | "str" | `date:${string}`;
interface Operand {
    sql: string;
    cls: Cls;
    column?: CheckColumn;
    text?: string;
}
type Token = { kind: "word" | "quoted" | "number" | "string" | "op" | "punct"; text: string };

class Refused extends Error {}
const refuse = (reason: string): never => {
    throw new Refused(reason);
};

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let at = 0;
    while (at < text.length) {
        const rest = text.slice(at);
        let match: RegExpExecArray | null;
        if ((match = /^\s+/.exec(rest))) at += match[0].length;
        else if ((match = /^"(?:[^"]|"")+"/.exec(rest))) (tokens.push({ kind: "quoted", text: match[0] }), (at += match[0].length));
        else if ((match = /^'(?:[^']|'')*'/.exec(rest))) (tokens.push({ kind: "string", text: match[0] }), (at += match[0].length));
        else if ((match = /^(?:\d+(?:\.\d+)?|\.\d+)(?![\w.])/.exec(rest))) (tokens.push({ kind: "number", text: match[0] }), (at += match[0].length));
        else if ((match = /^[A-Za-z_][A-Za-z0-9_$#]*/.exec(rest))) (tokens.push({ kind: "word", text: match[0] }), (at += match[0].length));
        else if ((match = /^(?:<>|!=|\^=|<=|>=|=|<|>)/.exec(rest))) (tokens.push({ kind: "op", text: match[0] }), (at += match[0].length));
        else if ((match = /^[(),-]/.exec(rest))) (tokens.push({ kind: "punct", text: match[0] }), (at += match[0].length));
        else return refuse(`it contains "${rest.slice(0, 12).trim()}", which is not in the plain comparisons this migration translates`);
    }
    return tokens;
}

/**
 * The PostgreSQL form of an Oracle CHECK condition, or the reason it is not carried. Only comparisons of a column with a number or a text
 * literal, of two columns of the same type, IN, BETWEEN, IS [NOT] NULL, joined by AND, OR, NOT and parentheses. A function (UPPER, TO_DATE,
 * SYSDATE), a date literal, an ordering of text (the two databases sort it differently), a floating-point column and a column whose type
 * was changed are all refused: their meaning is not the same on both sides.
 */
export function translateCheck(condition: string, columns: CheckColumn[]): { sql: string } | { reason: string } {
    try {
        const tokens = tokenize(condition);
        if (tokens.length === 0) return { reason: "it has no condition" };
        let at = 0;
        const peek = () => tokens[at];
        const word = (value: string) => peek()?.kind === "word" && peek().text.toUpperCase() === value;
        const take = () => tokens[at++];
        const expectWord = (value: string) => (word(value) ? void take() : refuse(`expected ${value}`));

        const columnNamed = (token: Token): CheckColumn => {
            const quoted = token.kind === "quoted";
            const name = quoted ? token.text.slice(1, -1).replace(/""/g, '"') : token.text.toUpperCase();
            if (tokens[at]?.text === "(") return refuse(`it calls ${token.text}()`);
            const found = columns.find((column) => (quoted ? column.oracleName === name : column.oracleName.toUpperCase() === name));
            if (!found) return refuse(`${token.text} is not a column of the table`);
            return found;
        };
        const classOf = (column: CheckColumn): Cls => {
            if (column.typeEdited) return refuse(`you changed the type of ${column.oracleName}, and the condition was written for the Oracle type`);
            if (column.family === "number") return "num";
            if (column.family === "string") return "str";
            if (column.family === "date" || column.family === "timestamp") return `date:${column.pgType}`;
            return refuse(`${column.oracleName} is a ${column.family === "float" ? "floating-point" : column.family} column, which is not compared the same way in PostgreSQL`);
        };

        const operand = (): Operand => {
            const token = take();
            if (!token) return refuse("the condition stops where a value was expected");
            if (token.kind === "punct" && token.text === "-") {
                const number = take();
                if (number?.kind !== "number") return refuse("a minus sign that is not before a number");
                return { sql: `-${number.text}`, cls: "num" };
            }
            if (token.kind === "number") return { sql: token.text, cls: "num" };
            if (token.kind === "string") return { sql: token.text, cls: "str", text: token.text.slice(1, -1) };
            if (token.kind === "word" || token.kind === "quoted") {
                const column = columnNamed(token);
                return { sql: `"${column.pgName.replace(/"/g, '""')}"`, cls: classOf(column), column };
            }
            return refuse(`unexpected "${token.text}"`);
        };
        const literalOf = (value: Operand, other: Operand): void => {
            if (value.text === "") refuse("it compares with an empty string, which Oracle reads as NULL");
            if (!value.column && !other.column) refuse("it compares two constants");
            if (value.cls.startsWith("date:") && !value.column) refuse("it compares a date with a literal, which depends on Oracle's date format");
        };
        const same = (a: Operand, b: Operand): void => {
            if (a.cls !== b.cls) refuse(`it compares ${a.column?.oracleName ?? "a value"} (${a.cls.split(":")[0]}) with ${b.column?.oracleName ?? "a value"} (${b.cls.split(":")[0]})`);
            literalOf(a, b);
            literalOf(b, a);
        };
        const ordering = (a: Operand) => {
            if (a.cls === "str") refuse("it orders text, which the two databases sort differently");
        };

        const predicate = (): string => {
            if (peek()?.text === "(") {
                take();
                const inner = orExpr();
                if (take()?.text !== ")") return refuse("a bracket that is not closed");
                return `(${inner})`;
            }
            const left = operand();
            if (peek()?.kind === "op") {
                const op = take().text;
                const right = operand();
                same(left, right);
                if (op !== "=" && op !== "<>" && op !== "!=" && op !== "^=") ordering(left);
                return `${left.sql} ${op === "!=" || op === "^=" ? "<>" : op} ${right.sql}`;
            }
            if (word("IS")) {
                take();
                const negated = word("NOT") ? (take(), true) : false;
                expectWord("NULL");
                if (!left.column) return refuse("IS NULL on something that is not a column");
                return `${left.sql} IS ${negated ? "NOT " : ""}NULL`;
            }
            const negated = word("NOT") ? (take(), true) : false;
            if (word("IN")) {
                take();
                if (peek()?.text !== "(") return refuse("IN without a list");
                take();
                const items: Operand[] = [];
                do {
                    const item = operand();
                    same(left, item);
                    items.push(item);
                } while (peek()?.text === "," && take());
                if (take()?.text !== ")") return refuse("an IN list that is not closed");
                return `${left.sql} ${negated ? "NOT " : ""}IN (${items.map((item) => item.sql).join(", ")})`;
            }
            if (word("BETWEEN")) {
                take();
                const low = operand();
                expectWord("AND");
                const high = operand();
                same(left, low);
                same(left, high);
                ordering(left);
                return `${left.sql} ${negated ? "NOT " : ""}BETWEEN ${low.sql} AND ${high.sql}`;
            }
            return refuse("a value with nothing to say about it (a comparison, IN, BETWEEN or IS NULL was expected)");
        };
        const notExpr = (): string => (word("NOT") ? (take(), `NOT ${notExpr()}`) : predicate());
        const andExpr = (): string => {
            const parts = [notExpr()];
            while (word("AND")) (take(), parts.push(notExpr()));
            return parts.join(" AND ");
        };
        const orExpr = (): string => {
            const parts = [andExpr()];
            while (word("OR")) (take(), parts.push(andExpr()));
            return parts.join(" OR ");
        };

        const sql = orExpr();
        if (at < tokens.length) return { reason: `it continues after a complete condition, at "${tokens[at].text}"` };
        return { sql };
    } catch (error) {
        if (error instanceof Refused) return { reason: error.message };
        throw error;
    }
}

// ---- planning -----------------------------------------------------------------------------------------------------------------------

const MAX_NAME = 63;

/** What the indexes and CHECK constraints become, which can be carried, and the statements for the ones the person chose. */
export function planObjects(tables: OracleTable[], planned: PlannedTable[], found: OracleObjects, edits: MigrationEdits, fold: (name: string) => string): { objects: PlannedObject[]; objectSql: string[]; editProblems: string[] } {
    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const objects: PlannedObject[] = [];
    const editProblems: string[] = [];

    // relation names an index would have to be unique among: tables, the indexes behind PRIMARY KEY and UNIQUE, and the indexes carried first
    const relations = new Set<string>();
    const constraintsOf = new Map<string, Set<string>>();
    for (const table of tables) {
        const plan = planned.find((candidate) => candidate.oracleName === table.name);
        if (!plan) continue;
        relations.add(plan.pgName);
        relations.add(`${plan.pgName}_pkey`);
        const names = new Set<string>([`${plan.pgName}_pkey`]);
        for (const unique of table.uniques) (relations.add(fold(unique.name)), names.add(fold(unique.name)));
        for (const key of table.foreignKeys) names.add(fold(key.name));
        constraintsOf.set(table.name, names);
    }

    const chosen = (kind: ObjectKind, name: string) => edits.objects?.[objectKey(kind, name)]?.carry === true;
    const push = (object: Omit<PlannedObject, "carried">) => {
        const carried = object.carriable && chosen(object.kind, object.oracleName);
        if (!object.carriable && chosen(object.kind, object.oracleName)) editProblems.push(`${object.kind} ${object.oracleName} cannot be carried over: ${object.reason}.`);
        objects.push({ ...object, carried });
    };

    for (const index of found.indexes) {
        const table = tables.find((candidate) => candidate.name === index.table);
        const plan = planned.find((candidate) => candidate.oracleName === index.table);
        if (!table || !plan) continue;
        const pgName = fold(index.name);
        const columns = index.columns.map((column) => ({ ...column, planned: plan.columns.find((candidate) => candidate.oracleName === column.name) }));
        const detail = `on ${index.table} (${index.columns.map((column) => column.name).join(", ")})${index.unique ? ", unique" : ""}`;
        const base = { kind: "index" as const, oracleName: index.name, pgName, table: index.table, pgTable: plan.pgName, detail };
        let reason: string | undefined;
        if (index.type !== "NORMAL") reason = index.type === "BITMAP" ? "PostgreSQL has no bitmap indexes" : `it is a ${index.type.toLowerCase()} index (on an expression, or with a descending column), which this migration does not translate`;
        else if (!index.valid) reason = "Oracle marks it unusable";
        else if (index.partitioned) reason = "it is partitioned";
        else if (columns.some((column) => !column.planned)) reason = "it is on something that is not a plain column";
        else if (pgName.length > MAX_NAME) reason = `its name is longer than ${MAX_NAME} characters`;
        else if (index.unique && columns.some((column) => column.planned!.edited.includes("type"))) reason = "it is unique and you changed the type of one of its columns, so two values that differ in Oracle could be equal in PostgreSQL";
        else if (relations.has(pgName)) reason = `a table or key in PostgreSQL would already be called ${pgName}`;
        if (reason) {
            push({ ...base, carriable: false, reason });
            continue;
        }
        relations.add(pgName);
        // Oracle treats two rows of a unique composite key as equal when their NULLs and the other columns match; PostgreSQL never does, so it accepts every row Oracle accepts
        const note = index.unique && index.columns.length > 1 ? ". Rows with a NULL in the key are never equal in PostgreSQL, so it is no stricter than Oracle" : "";
        push({ ...base, detail: detail + note, carriable: true, sql: `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(pgName)} ON ${quote(plan.pgName)} (${columns.map((column) => quote(column.planned!.pgName)).join(", ")})` });
    }

    for (const check of found.checks) {
        const table = tables.find((candidate) => candidate.name === check.table);
        const plan = planned.find((candidate) => candidate.oracleName === check.table);
        if (!table || !plan) continue;
        const pgName = fold(check.name);
        const base = { kind: "check" as const, oracleName: check.name, pgName, table: check.table, pgTable: plan.pgName, detail: check.condition };
        const used = constraintsOf.get(check.table)!;
        let reason: string | undefined;
        if (!check.enabled) reason = "it is disabled in Oracle";
        else if (!check.validated) reason = "Oracle does not guarantee the rows already in the table satisfy it (it is not validated)";
        else if (pgName.length > MAX_NAME) reason = `its name is longer than ${MAX_NAME} characters`;
        else if (used.has(pgName)) reason = `another constraint on the table would already be called ${pgName}`;
        let translated: { sql: string } | { reason: string } | undefined;
        if (!reason) {
            const known: CheckColumn[] = plan.columns.map((column) => {
                const source = table.columns.find((candidate) => candidate.name === column.oracleName)!;
                return { oracleName: column.oracleName, pgName: column.pgName, family: oracleFamily(source), pgType: column.pgType, typeEdited: column.edited.includes("type") };
            });
            translated = translateCheck(check.condition, known);
            if ("reason" in translated) reason = translated.reason;
        }
        if (reason || !translated || "reason" in translated) {
            push({ ...base, carriable: false, reason: reason ?? "it could not be translated" });
            continue;
        }
        used.add(pgName);
        push({ ...base, carriable: true, sql: `ALTER TABLE ${quote(plan.pgName)} ADD CONSTRAINT ${quote(pgName)} CHECK (${translated.sql})` });
    }

    // a name in the edits that is no object of this schema
    for (const key of Object.keys(edits.objects ?? {})) {
        const [kind, ...rest] = key.split(":");
        if (!objects.some((object) => objectKey(object.kind, object.oracleName) === key)) editProblems.push(`There is no ${kind} ${rest.join(":")} in this schema to carry over.`);
    }
    return { objects, objectSql: objects.filter((object) => object.carried).map((object) => object.sql!), editProblems };
}
