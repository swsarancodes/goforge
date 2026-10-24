import { skeleton } from "./sql-guard";
import type { SchemaTable } from "./database";

/**
 * Static checks on a candidate's text, with no data involved: the patterns by which a PostgreSQL query that runs and looks right is
 * different from the Oracle query it replaces. They read the parsed query (not regular expressions over text), know the target schema's
 * column types and nullability, and, where a pattern is only a problem when the legacy query did something specific, look at the legacy
 * query too, so a correct translation is not accused of a difference it does not have.
 *
 * They are deterministic and they point at a construct. They are not proofs and they are not complete: a query with no findings has not been
 * shown to be right, and one with findings may be right. What they are for: telling the model what to look at, telling a reviewer what a
 * passing query still deserves a second look for, and (for `blocking` findings only) stopping a query that matches the data because it
 * contains the data.
 */

export type RiskCategory = "date_or_time_semantics" | "null_type_or_aggregation_semantics" | "join_semantics" | "silent_executable_failure";

export interface Finding {
    id: string;
    category: RiskCategory;
    /** `blocking` is for the one pattern that is a fault in itself (a query fitted to the data); everything else is a warning. */
    severity: "warning" | "blocking";
    title: string;
    detail: string;
}

type Json = any;

let ready: Promise<typeof import("@guanmingchiu/sqlparser-ts")> | undefined;
const parser = () => (ready ??= import("@guanmingchiu/sqlparser-ts").then(async (module) => (await module.init(), module)));

// ---- reading the tree ------------------------------------------------------------------------------------------------------

const key = (node: Json): string | undefined => (node && typeof node === "object" && !Array.isArray(node) ? Object.keys(node)[0] : undefined);
const lower = (value: string) => value.toLowerCase();

function* walk(node: Json, enter: (node: Json) => boolean = () => true): Generator<Json> {
    if (!node || typeof node !== "object") return;
    yield node;
    if (!enter(node)) return;
    for (const child of Array.isArray(node) ? node : Object.values(node)) yield* walk(child, enter);
}

const ident = (part: Json): string => lower(part?.value ?? part?.Identifier?.value ?? "");
const functionName = (fn: Json): string => lower((fn.name ?? []).map(ident).join("."));
const functionArgs = (fn: Json): Json[] => (fn.args?.List?.args ?? []).map((arg: Json) => (arg.Unnamed === "Wildcard" ? "*" : arg.Unnamed?.Expr ?? arg.Named?.arg?.Expr ?? undefined));
const stringValue = (expr: Json): string | undefined => expr?.Value?.value?.SingleQuotedString ?? expr?.TypedString?.value?.value?.SingleQuotedString;
const numberValue = (expr: Json): string | undefined => expr?.Value?.value?.Number?.[0];

interface Scope {
    /** alias (or table name) -> table name, or undefined for a derived table or anything not in the schema. */
    tables: Map<string, string | undefined>;
    outer: Set<string>;
    schema: SchemaTable[];
}

function scopeOf(select: Json, schema: SchemaTable[]): Scope {
    const scope: Scope = { tables: new Map(), outer: new Set(), schema };
    const add = (relation: Json, outer: boolean) => {
        const table = relation?.Table;
        const derived = relation?.Derived;
        const alias = lower(table?.alias?.name?.value ?? derived?.alias?.name?.value ?? "");
        const name = table ? (table.name ?? []).map(ident).join(".").split(".").pop() : undefined;
        const resolved = name && schema.some((t) => lower(t.name) === name) ? name : undefined;
        const as = alias || name;
        if (!as) return;
        scope.tables.set(as, resolved);
        if (outer) scope.outer.add(as);
    };
    for (const from of select.from ?? []) {
        add(from.relation, false);
        for (const join of from.joins ?? []) add(join.relation, ["Left", "LeftOuter"].includes(key(join.join_operator) ?? ""));
    }
    return scope;
}

/** The table alias an expression's column belongs to, and the column's schema entry. */
function resolveColumn(expr: Json, scope: Scope): { alias?: string; column?: SchemaTable["columns"][number] } {
    const parts: string[] | undefined = expr?.CompoundIdentifier ? expr.CompoundIdentifier.map(ident) : expr?.Identifier ? [ident(expr.Identifier)] : undefined;
    if (!parts) return {};
    const name = parts[parts.length - 1];
    const lookup = (alias: string) => {
        const table = scope.tables.get(alias);
        return table ? scope.schema.find((t) => lower(t.name) === table)?.columns.find((c) => lower(c.name) === name) : undefined;
    };
    if (parts.length >= 2) return { alias: parts[parts.length - 2], column: lookup(parts[parts.length - 2]) };
    const owners = [...scope.tables.keys()].filter((alias) => lookup(alias));
    return owners.length === 1 ? { alias: owners[0], column: lookup(owners[0]) } : { alias: undefined };
}

function show(expr: Json): string {
    const k = key(expr);
    if (k === "Identifier") return expr.Identifier.value;
    if (k === "CompoundIdentifier") return expr.CompoundIdentifier.map((part: Json) => part.value).join(".");
    if (k === "Value") return stringValue(expr) !== undefined ? `'${stringValue(expr)}'` : (numberValue(expr) ?? "a value");
    if (k === "TypedString") return `${typeof expr.TypedString.data_type === "string" ? expr.TypedString.data_type.toUpperCase() : "TIMESTAMP"} '${stringValue(expr)}'`;
    if (k === "Nested") return `(${show(expr.Nested)})`;
    if (k === "IsNull") return `${show(expr.IsNull)} IS NULL`;
    if (k === "IsNotNull") return `${show(expr.IsNotNull)} IS NOT NULL`;
    if (k === "Function") return `${functionName(expr.Function).toUpperCase()}(…)`;
    if (k === "BinaryOp") return `${show(expr.BinaryOp.left)} ${({ Eq: "=", NotEq: "<>", Lt: "<", LtEq: "<=", Gt: ">", GtEq: ">=", And: "AND", Or: "OR", Divide: "/", StringConcat: "||", Plus: "+", Minus: "-", Multiply: "*" } as Record<string, string>)[expr.BinaryOp.op] ?? expr.BinaryOp.op} ${show(expr.BinaryOp.right)}`;
    if (k === "Between") return `${show(expr.Between.expr)} BETWEEN ${show(expr.Between.low)} AND ${show(expr.Between.high)}`;
    return "an expression";
}

const conjuncts = (expr: Json): Json[] => (expr?.BinaryOp?.op === "And" ? [...conjuncts(expr.BinaryOp.left), ...conjuncts(expr.BinaryOp.right)] : expr ? [expr] : []);

/** True for an expression whose type is certainly an integer: dividing two of them truncates in PostgreSQL and does not in Oracle. */
function isInteger(expr: Json, scope: Scope): boolean {
    const k = key(expr);
    if (k === "Nested") return isInteger(expr.Nested, scope);
    if (k === "Value") return numberValue(expr) !== undefined && !numberValue(expr)!.includes(".");
    if (k === "Cast") return /int/i.test(JSON.stringify(expr.Cast.data_type)) && !/interval/i.test(JSON.stringify(expr.Cast.data_type));
    if (k === "Identifier" || k === "CompoundIdentifier") return ["integer", "smallint", "bigint"].includes(resolveColumn(expr, scope).column?.type ?? "");
    if (k === "BinaryOp") return ["Plus", "Minus", "Multiply", "Divide", "Modulo"].includes(expr.BinaryOp.op) && isInteger(expr.BinaryOp.left, scope) && isInteger(expr.BinaryOp.right, scope);
    if (k === "Case") return [...(expr.Case.conditions ?? []).map((c: Json) => c.result), expr.Case.else_result].filter(Boolean).every((result: Json) => isInteger(result, scope));
    if (k === "Function") {
        const name = functionName(expr.Function);
        const args = functionArgs(expr.Function);
        if (name === "count") return true;
        if (["sum", "min", "max", "nullif"].includes(name)) return args[0] !== undefined && args[0] !== "*" && isInteger(args[0], scope);
        if (name === "coalesce") return args.length > 0 && args.every((arg) => arg !== "*" && isInteger(arg, scope));
    }
    return false;
}

/** What the legacy query contains, read from its text (it is not PostgreSQL, so it is not parsed). */
function legacyFacts(legacySql: string) {
    const flat = skeleton(legacySql) ?? legacySql.toLowerCase();
    const numbers = new Set((flat.replace(/'[^']*'/g, " ").match(/\b\d+(?:\.\d+)?\b/g) ?? []).map((n) => String(Number(n))));
    const strings = new Set([...legacySql.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replace(/''/g, "'")));
    // numbers the legacy query compares an id column with: `2` in ROUND(x, 2) does not make `customer_id = 2` a value the legacy query had
    const idLiterals = new Set<string>();
    for (const match of flat.matchAll(/[a-z0-9_.]*id\b\s*(?:=|<>|!=|<=|>=|<|>)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:=|<>|!=|<=|>=|<|>)\s*[a-z0-9_.]*id\b/g)) idLiterals.add(String(Number(match[1] ?? match[2])));
    return {
        outerJoin: /\(\s*\+\s*\)/.test(legacySql) || /\b(left|right|full)\s+(outer\s+)?join\b/.test(flat),
        countStar: /\bcount\s*\(\s*\*\s*\)/.test(flat),
        divides: flat.includes("/"),
        concatenates: flat.includes("||"),
        averagesNvl: /\bavg\s*\(\s*(nvl|coalesce|ifnull|isnull)\s*\(/.test(flat),
        truncates: /\btrunc\s*\(/.test(flat),
        addMonths: /\badd_months\s*\(/.test(flat),
        numbers,
        idLiterals,
        strings,
    };
}

// ---- the checks ------------------------------------------------------------------------------------------------------------

export interface AnalyzeInput {
    legacySql: string;
    sql: string;
    schema: SchemaTable[];
    /** The columns the query returned, when it was run (PostgreSQL's type ids). */
    resultColumns?: { name: string; typeOid?: number }[];
}

export async function analyzeCandidate(input: AnalyzeInput): Promise<Finding[]> {
    const findings: Finding[] = [];
    const seen = new Set<string>();
    const report = (finding: Finding, discriminator = "") => {
        const id = `${finding.id}|${discriminator}`;
        if (seen.has(id)) return;
        seen.add(id);
        findings.push(finding);
    };

    let statements: Json[];
    try {
        statements = (await parser()).parse(input.sql, "postgresql") as Json[];
    } catch (error) {
        return [{ id: "unanalyzed", category: "silent_executable_failure", severity: "warning", title: "The static checks could not read this query", detail: `The SQL parser said: ${error instanceof Error ? error.message : String(error)}` }];
    }
    const legacy = legacyFacts(input.legacySql);
    const root = statements;

    // anywhere in the query
    const usesMonthEndRule = [...walk(root)].some((node) => key(node) === "Function" && functionName(node.Function) === "date_trunc" && lower(String(stringValue(functionArgs(node.Function)[0]) ?? "")) === "month");
    if (legacy.addMonths && !usesMonthEndRule) {
        for (const node of walk(root)) {
            if (key(node) !== "Interval") continue;
            const text = String(stringValue(node.Interval.value) ?? "");
            if (/\b(month|months|mon|mons|year|years)\b/i.test(text))
                report({ id: "month_arithmetic_without_month_end_rule", category: "date_or_time_semantics", severity: "warning", title: "Month arithmetic without Oracle's month-end rule", detail: `The legacy query uses ADD_MONTHS, which returns the last day of the target month when the start date is the last day of its month (28 Feb + 6 months is 31 Aug). Adding INTERVAL '${text}' keeps the day number (28 Aug). Nothing in this query handles month ends.` });
        }
    }
    for (const column of input.resultColumns ?? []) {
        if (column.typeOid === 1186)
            report({ id: "interval_result", category: "date_or_time_semantics", severity: "warning", title: "A result column is an interval", detail: `Column ${column.name} comes back as an interval. Subtracting two dates in Oracle gives a number of days (with a fraction when there is a time of day); PostgreSQL gives an interval for timestamps.` }, column.name);
    }

    // per SELECT, with its own tables in scope
    for (const node of walk(root)) {
        if (key(node) !== "Select") continue;
        const select = node.Select;
        const scope = scopeOf(select, input.schema);
        // the select's own expressions, not the selects nested in them (those are visited on their own)
        const own: Json[] = [select.projection, select.selection, select.having, select.group_by, ...(select.from ?? []).flatMap((from: Json) => (from.joins ?? []).map((join: Json) => join.join_operator))];
        const exprs = own.flatMap((part) => [...walk(part, (child) => key(child) !== "Select")]);

        // join semantics: an outer-joined table filtered in WHERE
        if (legacy.outerJoin && scope.outer.size > 0) {
            for (const conjunct of conjuncts(select.selection)) {
                if (key(conjunct) === "IsNull") continue;
                const touched = new Set<string>();
                for (const part of walk(conjunct, (child) => key(child) !== "Select")) {
                    const { alias } = resolveColumn(part, scope);
                    if (alias && scope.outer.has(alias)) touched.add(alias);
                }
                for (const alias of touched)
                    report({ id: "outer_join_filtered_in_where", category: "join_semantics", severity: "warning", title: "The outer-joined table is filtered in WHERE", detail: `${alias} is LEFT JOINed, but \`${show(conjunct)}\` is in WHERE. Rows with no match in ${alias}, and rows whose match fails this test, are dropped, so the outer join behaves like an inner join. In Oracle a predicate marked (+) belongs in the join condition.` }, show(conjunct));
            }
        }
        for (const expr of exprs) {
            const k = key(expr);
            if (k === "Function") {
                const name = functionName(expr.Function);
                const args = functionArgs(expr.Function);
                if (name === "count" && args[0] === "*" && scope.outer.size > 0 && !legacy.countStar)
                    report({ id: "count_star_over_outer_join", category: "join_semantics", severity: "warning", title: "COUNT(*) over an outer join", detail: "COUNT(*) counts the row an outer join makes up for an unmatched row, so a group with nothing matched reports 1. The legacy query counted a column (COUNT(col) does not count NULL)." });
                if (name === "avg" && legacy.averagesNvl && args[0] !== "*" && !(key(args[0]) === "Function" && ["coalesce", "nvl", "ifnull"].includes(functionName(args[0].Function))))
                    report({ id: "average_ignores_nulls", category: "null_type_or_aggregation_semantics", severity: "warning", title: "AVG without the NULL substitution the legacy query had", detail: "The legacy query averaged NVL(x, 0), which counts a NULL as 0. AVG(x) skips NULLs, so the average is taken over fewer rows and comes out higher." });
            }
            if (k === "BinaryOp") {
                const { left, right, op } = expr.BinaryOp;
                if (op === "Divide" && legacy.divides && isInteger(left, scope) && isInteger(right, scope))
                    report({ id: "integer_division", category: "null_type_or_aggregation_semantics", severity: "warning", title: "Integer division", detail: `\`${show(expr)}\` divides two integers. PostgreSQL truncates the result (1/3 is 0); Oracle's NUMBER division keeps the fraction. Cast one side to numeric.` }, show(expr));
                if (op === "StringConcat" && legacy.concatenates) {
                    for (const operand of [left, right]) {
                        const { column } = resolveColumn(operand, scope);
                        if (column?.nullable)
                            report({ id: "null_in_concatenation", category: "null_type_or_aggregation_semantics", severity: "warning", title: "|| with a nullable column", detail: `${show(operand)} can be NULL. Oracle treats NULL as an empty string in ||; in PostgreSQL the whole result becomes NULL. Wrap it in COALESCE(…, '') or use CONCAT.` }, show(operand));
                    }
                }
                // a timestamp column against a DATE literal, where the legacy query truncated
                if (legacy.truncates && ["LtEq", "Eq"].includes(op)) {
                    const { column } = resolveColumn(left, scope);
                    if (column?.type.startsWith("timestamp") && key(right) === "TypedString" && right.TypedString.data_type === "Date")
                        report({ id: "timestamp_vs_date_boundary", category: "date_or_time_semantics", severity: "warning", title: "A timestamp compared with a date", detail: `\`${show(expr)}\`: ${show(left)} has a time of day, and ${op === "Eq" ? "only values at exactly midnight equal" : "values later on that day are greater than"} a DATE literal. The legacy query used TRUNC on the column. Compare against the next day with < instead.` }, show(expr));
                }
                // fitted to a literal: a comparison the legacy query does not contain
                if (["Eq", "NotEq", "Lt", "LtEq", "Gt", "GtEq"].includes(op)) {
                    for (const [column, literal] of [[left, right], [right, left]]) {
                        const text = numberValue(literal) ?? stringValue(literal);
                        if (text === undefined || key(column) === "Value" || key(column) === "TypedString") continue;
                        const isNumber = numberValue(literal) !== undefined;
                        const columnName = (resolveColumn(column, scope).column?.name ?? (key(column) === "Identifier" || key(column) === "CompoundIdentifier" ? show(column).split(".").pop() : "")) ?? "";
                        const isKey = /(^|_)id$/i.test(columnName);
                        const known = isNumber ? (isKey ? legacy.idLiterals : legacy.numbers).has(String(Number(text))) : legacy.strings.has(text);
                        if (!known && (op === "Eq" || op === "NotEq" || isKey))
                            report({ id: "fitted_to_a_literal", category: "silent_executable_failure", severity: "blocking", title: "A comparison with a value the legacy query does not contain", detail: `\`${show(expr)}\` compares with ${show(literal)}, which appears nowhere in the legacy query. A translation does not introduce values; a query that does is usually written around the rows it was checked on.` }, show(expr));
                    }
                }
            }
            if (k === "Between" && legacy.truncates && !expr.Between.negated) {
                const { column } = resolveColumn(expr.Between.expr, scope);
                const high = expr.Between.high;
                if (column?.type.startsWith("timestamp") && key(high) === "TypedString" && high.TypedString.data_type === "Date")
                    report({ id: "timestamp_vs_date_boundary", category: "date_or_time_semantics", severity: "warning", title: "A timestamp compared with a date", detail: `\`${show(expr)}\`: ${show(expr.Between.expr)} has a time of day, so values after midnight on the last day are outside the range. The legacy query used TRUNC on the column. Compare against the next day with < instead.` }, show(expr));
            }
        }
    }
    return findings;
}
