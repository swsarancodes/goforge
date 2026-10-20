import { Ctx, isAtom } from "./context";
import {
    Group,
    Node,
    Token,
    buildTree,
    flatten,
    identifierText,
    isGroup,
    isOp,
    isPunct,
    isToken,
    isWord,
    normalize,
    paren,
    print,
    splitTopLevel,
    textOf,
    tpl,
    upper,
    word,
} from "./tokens";

/**
 * Expression-level rewrites: function calls, date/time keywords, sequences, string concatenation, hints and names.
 * Everything is a pure function from tokens to tokens; whatever a rule doesn't recognise is left exactly as written
 * and, if it is known to be a problem, reported through `ctx.unsupported`.
 */

interface Call {
    /** Upper-case function name. */
    name: string;
    nameTok: Token;
    /** Identifier parts before the name (a schema or package), if any. */
    qualifier: Token[];
    group: Group;
    args: Node[][];
    /** The nodes after the call in the same list. */
    rest: Node[];
}

interface CallResult {
    nodes: Node[];
    /** How many of the following nodes were used as well (WITHIN GROUP (...), OVER (...)). */
    consumed?: number;
}

type Handler = (call: Call, ctx: Ctx) => CallResult | Node[] | undefined;

const argsOf = (group: Group): Node[][] => (group.items.length === 0 ? [] : splitTopLevel(group.items));
const rename = (call: Call, name: string): Node[] => [{ ...call.nameTok, text: name }, call.group];
const isInteger = (nodes: Node[]): number | undefined => {
    if (nodes.length === 1 && isToken(nodes[0]) && nodes[0].kind === "number" && /^\d+$/.test(nodes[0].text)) return Number(nodes[0].text);
    if (nodes.length === 2 && isOp(nodes[0], "-") && isToken(nodes[1]) && nodes[1].kind === "number" && /^\d+$/.test(nodes[1].text)) return -Number(nodes[1].text);
    return undefined;
};
const stringValue = (nodes: Node[]): string | undefined => (nodes.length === 1 && isToken(nodes[0]) && nodes[0].kind === "string" ? (nodes[0].value ?? "") : undefined);
const isNullLiteral = (nodes: Node[]) => nodes.length === 1 && isWord(nodes[0], "NULL");
const isLiteral = (nodes: Node[]) => nodes.length === 1 && isToken(nodes[0]) && (nodes[0].kind === "string" || nodes[0].kind === "number");
const bare = (nodes: Node[]) => normalize(nodes);
const fragment = (text: string): Node[] => tpl`${text}`;

// ---- unit and format tables -------------------------------------------------------------------------------------

const MSSQL_UNITS: Record<string, string> = {
    year: "year", yy: "year", yyyy: "year", quarter: "quarter", qq: "quarter", q: "quarter", month: "month", mm: "month", m: "month",
    dayofyear: "day", dy: "day", y: "day", day: "day", dd: "day", d: "day", week: "week", wk: "week", ww: "week",
    hour: "hour", hh: "hour", minute: "minute", mi: "minute", n: "minute", second: "second", ss: "second", s: "second", millisecond: "millisecond", ms: "millisecond",
};

const MYSQL_UNITS: Record<string, string> = { year: "year", quarter: "quarter", month: "month", week: "week", day: "day", hour: "hour", minute: "minute", second: "second", microsecond: "microsecond" };

const MSSQL_STYLES: Record<number, string> = {
    20: "YYYY-MM-DD HH24:MI:SS", 120: "YYYY-MM-DD HH24:MI:SS", 21: "YYYY-MM-DD HH24:MI:SS.MS", 121: "YYYY-MM-DD HH24:MI:SS.MS", 23: "YYYY-MM-DD",
    126: 'YYYY-MM-DD"T"HH24:MI:SS.MS', 112: "YYYYMMDD", 101: "MM/DD/YYYY", 103: "DD/MM/YYYY", 102: "YYYY.MM.DD", 104: "DD.MM.YYYY", 105: "DD-MM-YYYY",
    110: "MM-DD-YYYY", 111: "YYYY/MM/DD", 108: "HH24:MI:SS", 114: "HH24:MI:SS:MS", 106: "DD Mon YYYY", 107: "Mon DD, YYYY",
};

const MYSQL_FORMAT: Record<string, string> = {
    Y: "YYYY", y: "YY", m: "MM", c: "FMMM", d: "DD", e: "FMDD", H: "HH24", k: "FMHH24", h: "HH12", I: "HH12", l: "FMHH12", i: "MI", s: "SS", S: "SS", f: "US",
    p: "AM", M: "FMMonth", b: "Mon", a: "Dy", W: "FMDay", j: "DDD", T: "HH24:MI:SS", r: "HH12:MI:SS AM", "%": "%",
};

/** MySQL date format (%Y-%m-%d) to a PostgreSQL template (YYYY-MM-DD). `undefined` if a code has no equivalent. */
export function mysqlFormatToPostgres(format: string): string | undefined {
    let out = "";
    for (let i = 0; i < format.length; i++) {
        const ch = format[i];
        if (ch === "%") {
            const mapped = MYSQL_FORMAT[format[i + 1]];
            if (mapped === undefined) return undefined;
            out += mapped;
            i++;
        } else if (/[A-Za-z]/.test(ch)) out += `"${ch}"`;
        else out += ch;
    }
    return out;
}

const TRUNC_FORMATS: Record<string, string> = { Y: "year", YY: "year", YYYY: "year", YEAR: "year", SYYYY: "year", Q: "quarter", MM: "month", MON: "month", MONTH: "month", RM: "month", DD: "day", DDD: "day", J: "day", HH: "hour", HH12: "hour", HH24: "hour", MI: "minute", IW: "week", W: "week", WW: "week" };

const CAST_TYPES: Record<string, string> = {
    varchar2: "varchar", nvarchar2: "varchar", nvarchar: "varchar", nchar: "char", number: "numeric", clob: "text", nclob: "text", blob: "bytea", long: "text", raw: "bytea",
    datetime: "timestamp", datetime2: "timestamp", smalldatetime: "timestamp", bit: "boolean", tinyint: "smallint", money: "numeric(19,4)", smallmoney: "numeric(10,4)",
    uniqueidentifier: "uuid", binary_double: "double precision", binary_float: "real", float: "double precision", ntext: "text", image: "bytea", datetimeoffset: "timestamptz",
    signed: "bigint", unsigned: "bigint", mediumtext: "text", longtext: "text", tinytext: "text", mediumint: "integer", double: "double precision",
};

/** Maps the tokens of a type name (after AS in CAST, or the first argument of CONVERT) to PostgreSQL. */
function mapType(nodes: Node[], ctx: Ctx): Node[] | undefined {
    if (nodes.length === 0 || !isToken(nodes[0]) || nodes[0].kind !== "word") return undefined;
    const name = nodes[0].text.toLowerCase();
    // VARCHAR(MAX) / NVARCHAR(MAX)
    if (nodes[1] && isGroup(nodes[1]) && nodes[1].items.length === 1 && isWord(nodes[1].items[0], "MAX") && /varchar|char/.test(name)) return tpl`text`;
    if (name === "date" && ctx.dialect === "oracle") return tpl`timestamp(0)`;
    if (name === "number" && nodes[1] && isGroup(nodes[1]) && /^\s*\*\s*,/.test(print(nodes[1].items))) return tpl`numeric`;
    const mapped = CAST_TYPES[name];
    if (!mapped) return undefined;
    // A target that already has its own length ("numeric(19,4)") can't take the source's brackets.
    if (mapped.includes("(") && nodes[1] && isGroup(nodes[1])) return undefined;
    return [{ ...nodes[0], text: mapped }, ...nodes.slice(1)];
}

// ---- the call table ---------------------------------------------------------------------------------------------

function nvl(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length === 2) {
        const out = rename(call, "COALESCE");
        ctx.apply("nvl", [...call.qualifier, call.nameTok, call.group], out);
        return out;
    }
    if (call.args.length === 1 && ctx.dialect === "mysql" && call.name === "ISNULL") {
        const out = tpl`(${bare(call.args[0])} IS NULL)::int`;
        ctx.apply("nvl", [call.nameTok, call.group], out);
        return out;
    }
    return undefined;
}

function decode(call: Call, ctx: Ctx): Node[] | undefined {
    const { args } = call;
    if (args.length < 3) return undefined;
    const subject = args[0];
    const pairs: { search: Node[]; result: Node[] }[] = [];
    let index = 1;
    for (; index + 1 < args.length; index += 2) pairs.push({ search: args[index], result: args[index + 1] });
    const fallback = index < args.length ? args[index] : undefined;

    const allLiteral = pairs.every((pair) => isLiteral(pair.search));
    let out: Node[];
    if (allLiteral) {
        // CASE x WHEN 'A' THEN ... : a NULL subject matches nothing, exactly like DECODE against a non-NULL value.
        out = tpl`CASE ${bare(subject)}`;
        for (const pair of pairs) out.push(...tpl`WHEN ${bare(pair.search)} THEN ${bare(pair.result)}`);
    } else {
        out = tpl`CASE`;
        for (const pair of pairs) {
            const test = isNullLiteral(pair.search) ? tpl`${paren(bare(subject))} IS NULL` : isLiteral(pair.search) ? tpl`${paren(bare(subject))} = ${bare(pair.search)}` : tpl`${paren(bare(subject))} IS NOT DISTINCT FROM ${paren(bare(pair.search))}`;
            out.push(...tpl`WHEN ${test} THEN ${bare(pair.result)}`);
        }
    }
    if (fallback) out.push(...tpl`ELSE ${bare(fallback)}`);
    out.push(...tpl`END`);
    ctx.apply("decode", [call.nameTok, call.group], out);
    return out;
}

function nvl2(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 3) return undefined;
    const out = tpl`CASE WHEN ${bare(call.args[0])} IS NOT NULL THEN ${bare(call.args[1])} ELSE ${bare(call.args[2])} END`;
    ctx.apply("nvl2", [call.nameTok, call.group], out);
    return out;
}

function iif(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 3) return undefined;
    const out = tpl`CASE WHEN ${bare(call.args[0])} THEN ${bare(call.args[1])} ELSE ${bare(call.args[2])} END`;
    ctx.apply("iif", [call.nameTok, call.group], out);
    return out;
}

function addMonths(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 2) return undefined;
    const months = isInteger(call.args[1]);
    const out = months !== undefined ? tpl`(${bare(call.args[0])} + INTERVAL '${String(months)} months')` : tpl`(${bare(call.args[0])} + ${paren(bare(call.args[1]))} * INTERVAL '1 month')`;
    ctx.apply("add-months", [call.nameTok, call.group], out);
    ctx.trap({
        id: "add-months-month-end",
        severity: "changes-results",
        title: "ADD_MONTHS keeps month-end dates at month end",
        explanation: "In Oracle, ADD_MONTHS(DATE '2021-02-28', 1) is 2021-03-31 because Feb 28 is the last day of its month. PostgreSQL's date + interval gives 2021-03-28. Dates that are not the last day of a month give the same result.",
    });
    return out;
}

function lastDay(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 1) return undefined;
    const out = tpl`(date_trunc('month', ${bare(call.args[0])}) + INTERVAL '1 month' - INTERVAL '1 day')::date`;
    ctx.apply("last-day", [call.nameTok, call.group], out);
    return out;
}

function truncFn(call: Call, ctx: Ctx): Node[] | undefined {
    const [subject, format] = call.args;
    if (call.args.length === 2) {
        const text = stringValue(format);
        if (text !== undefined) {
            const unit = TRUNC_FORMATS[text.toUpperCase()];
            if (!unit) {
                ctx.unsupported([call.nameTok, call.group], `TRUNC format '${text}' has no date_trunc equivalent`);
                return undefined;
            }
            // Oracle's TRUNC returns a DATE; date_trunc returns a timestamp (with a time zone for a date argument)
            const out = unit === "hour" || unit === "minute" ? tpl`date_trunc('${unit}', CAST(${bare(subject)} AS timestamp))` : tpl`CAST(date_trunc('${unit}', ${bare(subject)}) AS date)`;
            ctx.apply("trunc", [call.nameTok, call.group], out);
            return out;
        }
        return undefined; // TRUNC(number, digits) is the same in PostgreSQL
    }
    if (call.args.length !== 1) return undefined;
    const subjectText = print(normalize(subject)).trim().toUpperCase();
    if (subjectText === "CURRENT_TIMESTAMP" || subjectText === "SYSDATE") {
        const out = tpl`CURRENT_DATE`;
        ctx.apply("trunc", [call.nameTok, call.group], out);
        return out;
    }
    const kind = valueKind(subject, ctx);
    if (kind === "date") {
        const out = tpl`CAST(${bare(subject)} AS date)`;
        ctx.apply("trunc", [call.nameTok, call.group], out);
        return out;
    }
    if (kind === "number") return undefined; // trunc(number) is unchanged
    ctx.unsupported([call.nameTok, call.group], "TRUNC(x) cuts a date to midnight or a number to a whole number, and the type of x is not known here", "Use CAST(x AS date) if x is a date or timestamp; leave trunc(x) if it is a number.");
    return undefined;
}

type ValueKind = "date" | "number" | "text" | "unknown";

/** A best guess at what an expression is, from the tokens and (if there is one) the user's schema. */
function valueKind(nodes: Node[], ctx: Ctx): ValueKind {
    const flat = flatten(nodes);
    if (flat.length === 0) return "unknown";
    if (flat.length === 1 && flat[0].kind === "number") return "number";
    if (flat.length === 1 && flat[0].kind === "string") return "text";
    const first = nodes[0];
    if (isToken(first) && first.kind === "word" && nodes.length === 2 && isToken(nodes[1]) && nodes[1].kind === "string" && /^(DATE|TIMESTAMP)$/i.test(first.text)) return "date";
    if (isToken(first) && first.kind === "word") {
        const name = first.text.toUpperCase();
        if (nodes.length === 1 && /^(CURRENT_TIMESTAMP|CURRENT_DATE|LOCALTIMESTAMP|SYSDATE|SYSTIMESTAMP)$/.test(name)) return "date";
        if (isGroup(nodes[1]) && /^(TO_DATE|TO_TIMESTAMP|ADD_MONTHS|LAST_DAY|DATE_TRUNC|NOW)$/.test(name)) return "date";
        if (isGroup(nodes[1]) && /^(TO_CHAR|UPPER|LOWER|SUBSTR|SUBSTRING|TRIM|LTRIM|RTRIM|REPLACE|CONCAT|LPAD|RPAD)$/.test(name)) return "text";
        if (isGroup(nodes[1]) && /^(LENGTH|ABS|ROUND|FLOOR|CEIL|CEILING|MOD|COUNT|SUM|AVG|TO_NUMBER)$/.test(name)) return "number";
    }
    // a column: [table.]column
    const parts = flat.filter((token) => token.kind === "word" || token.kind === "ident");
    if (flat.every((token) => token.kind === "word" || token.kind === "ident" || (token.kind === "punct" && token.text === ".")) && parts.length >= 1 && parts.length <= 3) {
        const column = parts[parts.length - 1].value ?? parts[parts.length - 1].text;
        const table = parts.length >= 2 ? undefined : undefined;
        if (ctx.schema.isDateColumn(column, table)) return "date";
        if (ctx.schema.isNumericColumn(column, table)) return "number";
        if (ctx.schema.isTextColumn(column, table)) return "text";
    }
    return "unknown";
}

function toChar(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length === 1) {
        const out = tpl`CAST(${bare(call.args[0])} AS text)`;
        ctx.apply("to-char", [call.nameTok, call.group], out);
        return out;
    }
    return undefined;
}

function toNumber(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length === 1) {
        const out = tpl`CAST(${bare(call.args[0])} AS numeric)`;
        ctx.apply("to-char", [call.nameTok, call.group], out);
        return out;
    }
    return undefined;
}

const TIME_FORMAT = /HH|MI|SS|FF|AM|PM|A\.M\./i;

function toDate(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length === 1) {
        ctx.unsupported([call.nameTok, call.group], "TO_DATE with no format depends on the database's NLS_DATE_FORMAT setting", "Give the format explicitly, e.g. to_date(x, 'YYYY-MM-DD'), or use a date literal.");
        return undefined;
    }
    const format = call.args[1] && stringValue(call.args[1]);
    if (format !== undefined) {
        if (/RR/i.test(format)) {
            ctx.unsupported([call.nameTok, call.group], "The RR / RRRR year formats pivot two-digit years in a way PostgreSQL does not", "Write the year as YYYY.");
            return undefined;
        }
        if (call.name === "TO_DATE" && TIME_FORMAT.test(format)) {
            // Oracle's DATE has a time part; PostgreSQL's date does not, so a format with a time must produce a timestamp.
            const out = tpl`${[{ ...call.nameTok, text: "to_timestamp", ws: undefined } as Node, call.group]}::timestamp`;
            ctx.apply("to-date", [call.nameTok, call.group], out);
            return out;
        }
    }
    return undefined;
}

function dateadd(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 3) return undefined;
    const unitName = upper(call.args[0][0]).toLowerCase();
    const unit = MSSQL_UNITS[unitName];
    if (!unit || call.args[0].length !== 1) {
        ctx.unsupported([call.nameTok, call.group], `DATEADD unit "${print(call.args[0]).trim()}" is not recognised`);
        return undefined;
    }
    const n = isInteger(call.args[1]);
    const [multiplier, pgUnit] = unit === "quarter" ? [3, "month"] : [1, unit];
    let out: Node[];
    if (n !== undefined) out = tpl`(${bare(call.args[2])} + INTERVAL '${String(n * multiplier)} ${pgUnit}')`;
    else out = tpl`(${bare(call.args[2])} + ${paren(bare(call.args[1]))} * INTERVAL '${String(multiplier)} ${pgUnit}')`;
    ctx.apply("dateadd", [call.nameTok, call.group], out);
    return out;
}

function datediff(call: Call, ctx: Ctx): Node[] | undefined {
    if (ctx.dialect === "mysql") {
        if (call.args.length !== 2) return undefined;
        const out = tpl`(CAST(${bare(call.args[0])} AS date) - CAST(${bare(call.args[1])} AS date))`;
        ctx.apply("datediff", [call.nameTok, call.group], out);
        return out;
    }
    if (call.args.length !== 3) return undefined;
    const unit = call.args[0].length === 1 ? MSSQL_UNITS[upper(call.args[0][0]).toLowerCase()] : undefined;
    const a = bare(call.args[1]);
    const b = bare(call.args[2]);
    let out: Node[] | undefined;
    if (unit === "day") out = tpl`(CAST(${b} AS date) - CAST(${a} AS date))`;
    else if (unit === "year") out = tpl`(EXTRACT(YEAR FROM ${b}) - EXTRACT(YEAR FROM ${a}))::int`;
    else if (unit === "month") out = tpl`((EXTRACT(YEAR FROM ${b}) - EXTRACT(YEAR FROM ${a})) * 12 + (EXTRACT(MONTH FROM ${b}) - EXTRACT(MONTH FROM ${a})))::int`;
    else if (unit === "hour" || unit === "minute" || unit === "second") {
        const divisor = unit === "hour" ? 3600 : unit === "minute" ? 60 : 1;
        out = tpl`(EXTRACT(EPOCH FROM (date_trunc('${unit}', ${b}) - date_trunc('${unit}', ${a}))) / ${String(divisor)})::bigint`;
    }
    if (!out) {
        ctx.unsupported([call.nameTok, call.group], `DATEDIFF in ${unit ?? print(call.args[0]).trim()} has no exact PostgreSQL equivalent`, "Compute it from EXTRACT or age() once you know which boundary rule you need.");
        return undefined;
    }
    ctx.apply("datediff", [call.nameTok, call.group], out);
    ctx.trap({
        id: "datediff-boundaries",
        severity: "check",
        title: "DATEDIFF counts boundaries, not elapsed time",
        explanation: "SQL Server's DATEDIFF counts how many unit boundaries lie between the two values (Dec 31 23:59 to Jan 1 00:01 is 1 day, 1 month and 1 year). The replacement counts boundaries the same way, so results match, but they can differ from an elapsed-time difference you may expect.",
    });
    return out;
}

const DATEPART_UNITS: Record<string, string> = { year: "YEAR", yy: "YEAR", yyyy: "YEAR", quarter: "QUARTER", qq: "QUARTER", q: "QUARTER", month: "MONTH", mm: "MONTH", m: "MONTH", dayofyear: "DOY", dy: "DOY", y: "DOY", day: "DAY", dd: "DAY", d: "DAY", hour: "HOUR", hh: "HOUR", minute: "MINUTE", mi: "MINUTE", n: "MINUTE", second: "SECOND", ss: "SECOND", s: "SECOND" };

function datepart(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 2) return undefined;
    const part = call.args[0].length === 1 ? DATEPART_UNITS[upper(call.args[0][0]).toLowerCase()] : undefined;
    if (!part) {
        ctx.unsupported([call.nameTok, call.group], `DATEPART(${print(call.args[0]).trim()}, …) depends on server settings (DATEFIRST / ISO week) or has no direct equivalent`);
        return undefined;
    }
    const out = tpl`EXTRACT(${part} FROM ${bare(call.args[1])})::int`;
    ctx.apply("datepart", [call.nameTok, call.group], out);
    return out;
}

const datePartShortcut =
    (part: string): Handler =>
    (call, ctx) => {
        if (call.args.length !== 1) return undefined;
        const out = tpl`EXTRACT(${part} FROM ${bare(call.args[0])})::int`;
        ctx.apply("datepart", [call.nameTok, call.group], out);
        return out;
    };

function convertFn(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length < 2) return undefined;
    const mappedType = mapType(call.args[0], ctx);
    const typeNodes = mappedType ?? call.args[0];
    const lengthGroup = call.args[0][1] && isGroup(call.args[0][1]) ? call.args[0][1] : undefined;
    const length = lengthGroup && lengthGroup.items.length === 1 && isToken(lengthGroup.items[0]) ? Number(lengthGroup.items[0].text) : undefined;
    const isChar = /^(var)?char|^nvarchar|^nchar/i.test(print(call.args[0]).trim());

    if (call.args.length === 3) {
        const style = isInteger(call.args[2]);
        const template = style !== undefined ? MSSQL_STYLES[style] : undefined;
        if (!template || !isChar) {
            ctx.unsupported([call.nameTok, call.group], `CONVERT with style ${print(call.args[2]).trim()} has no known PostgreSQL template`, "Use to_char(x, 'template') with the format you need.");
            return undefined;
        }
        const formatted = tpl`to_char(${bare(call.args[1])}, '${template}')`;
        const out = length !== undefined && Number.isFinite(length) ? tpl`left(${formatted}, ${String(length)})` : formatted;
        ctx.apply("convert", [call.nameTok, call.group], out);
        return out;
    }
    const out = tpl`CAST(${bare(call.args[1])} AS ${bare(typeNodes)})`;
    ctx.apply("convert", [call.nameTok, call.group], out);
    return out;
}

function castFn(call: Call, ctx: Ctx): Node[] | undefined {
    const items = call.group.items;
    const asIndex = items.findIndex((node) => isWord(node, "AS"));
    if (asIndex < 0) return undefined;
    const typeNodes = items.slice(asIndex + 1);
    const mapped = mapType(typeNodes, ctx);
    if (!mapped) return undefined;
    const out: Node[] = [call.nameTok, { ...call.group, items: [...items.slice(0, asIndex + 1), ...mapped.map((node, index) => (index === 0 ? ({ ...node, ws: typeNodes[0] && isToken(typeNodes[0]) ? typeNodes[0].ws : undefined } as Node) : node))] }];
    ctx.apply("cast-types", [call.nameTok, call.group], out);
    return out;
}

function aggregateOrder(items: Node[]): { before: Node[]; order: Node[] | undefined } {
    const index = items.findIndex((node, i) => isWord(node, "ORDER") && isWord(items[i + 1], "BY"));
    return index < 0 ? { before: items, order: undefined } : { before: items.slice(0, index), order: items.slice(index) };
}

function listagg(call: Call, ctx: Ctx): CallResult | undefined {
    // LISTAGG(x [, sep]) WITHIN GROUP (ORDER BY ...)
    const rest = call.rest;
    let order: Node[] | undefined;
    let consumed = 0;
    if (isWord(rest[0], "WITHIN") && isWord(rest[1], "GROUP") && isGroup(rest[2])) {
        order = rest[2].items;
        consumed = 3;
    }
    if (call.args.length < 1 || call.args.length > 2) return undefined;
    const distinct = isWord(call.args[0][0], "DISTINCT");
    const value = distinct ? call.args[0].slice(1) : call.args[0];
    const separator = call.args[1] ? bare(call.args[1]) : tpl`''`;
    const orderClause = order ? tpl` ${bare(order)}` : [];
    const out = tpl`string_agg(${distinct ? "DISTINCT " : ""}${paren(bare(value))}::text, ${separator}${orderClause})`;
    ctx.apply("listagg", [call.nameTok, call.group], out);
    return { nodes: out, consumed };
}

function groupConcat(call: Call, ctx: Ctx): Node[] | undefined {
    const items = call.group.items;
    const sepIndex = items.findIndex((node) => isWord(node, "SEPARATOR"));
    const separator = sepIndex >= 0 ? items.slice(sepIndex + 1) : tpl`','`;
    const head = sepIndex >= 0 ? items.slice(0, sepIndex) : items;
    const { before, order } = aggregateOrder(head);
    const distinct = isWord(before[0], "DISTINCT");
    const values = splitTopLevel(distinct ? before.slice(1) : before);
    if (values.length !== 1) {
        ctx.unsupported([call.nameTok, call.group], "GROUP_CONCAT over several expressions has no direct string_agg equivalent", "Concatenate the expressions first, then aggregate the result.");
        return undefined;
    }
    const orderClause = order ? tpl` ${bare(order)}` : [];
    const out = tpl`string_agg(${distinct ? "DISTINCT " : ""}${paren(bare(values[0]))}::text, ${bare(separator)}${orderClause})`;
    ctx.apply("listagg", [call.nameTok, call.group], out);
    return out;
}

function stringAgg(call: Call, ctx: Ctx): CallResult | undefined {
    const rest = call.rest;
    if (!(isWord(rest[0], "WITHIN") && isWord(rest[1], "GROUP") && isGroup(rest[2]))) {
        if (call.args.length === 2) {
            const out = tpl`string_agg(${paren(bare(call.args[0]))}::text, ${bare(call.args[1])})`;
            ctx.apply("listagg", [call.nameTok, call.group], out);
            return { nodes: out };
        }
        return undefined;
    }
    if (call.args.length !== 2) return undefined;
    const out = tpl`string_agg(${paren(bare(call.args[0]))}::text, ${bare(call.args[1])} ${bare(rest[2].items)})`;
    ctx.apply("listagg", [call.nameTok, call.group], out);
    return { nodes: out, consumed: 3 };
}

function concatFn(call: Call, ctx: Ctx): Node[] | undefined {
    if (ctx.dialect !== "mysql" || call.args.length < 2) return undefined;
    const parts = call.args.map((arg) => (isLiteral(arg) && stringValue(arg) !== undefined ? bare(arg) : ctx.schema.isTextColumn(print(arg).trim().split(".").pop() ?? "") ? paren(bare(arg)) : tpl`${paren(bare(arg))}::text`));
    const out: Node[] = [];
    parts.forEach((part, index) => {
        if (index > 0) out.push(...tpl`||`);
        out.push(...part);
    });
    const wrapped = [{ kind: "group", open: { kind: "punct", text: "(" }, close: { kind: "punct", text: ")" }, items: out } as Group];
    ctx.apply("concat-function", [call.nameTok, call.group], wrapped);
    return wrapped;
}

function lenFn(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 1) return undefined;
    if (ctx.dialect === "mssql" && call.name === "LEN") {
        const out = tpl`length(rtrim(${bare(call.args[0])}))`;
        ctx.apply("length", [call.nameTok, call.group], out);
        return out;
    }
    if (ctx.dialect === "mysql" && call.name === "LENGTH") {
        const out = tpl`octet_length(${bare(call.args[0])})`;
        ctx.apply("length", [call.nameTok, call.group], out);
        return out;
    }
    return undefined;
}

function charindex(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length === 2) {
        const out = tpl`strpos(${bare(call.args[1])}, ${bare(call.args[0])})`;
        ctx.apply("position", [call.nameTok, call.group], out);
        return out;
    }
    ctx.unsupported([call.nameTok, call.group], "CHARINDEX with a start position has no direct strpos equivalent", "Use strpos(substr(s, start), sub) + start - 1 once you have confirmed how a missing match (0) should behave.");
    return undefined;
}

function instr(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length === 2) {
        const out = tpl`strpos(${bare(call.args[0])}, ${bare(call.args[1])})`;
        ctx.apply("position", [call.nameTok, call.group], out);
        return out;
    }
    ctx.unsupported([call.nameTok, call.group], "INSTR with a start position or occurrence has no direct strpos equivalent");
    return undefined;
}

function locate(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length === 2) {
        const out = tpl`strpos(${bare(call.args[1])}, ${bare(call.args[0])})`;
        ctx.apply("position", [call.nameTok, call.group], out);
        return out;
    }
    ctx.unsupported([call.nameTok, call.group], "LOCATE with a start position has no direct strpos equivalent");
    return undefined;
}

function regexpLike(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length < 2 || call.args.length > 3) return undefined;
    const flags = call.args[2] ? stringValue(call.args[2]) : "";
    if (flags === undefined || /[^icn]/.test(flags)) {
        ctx.unsupported([call.nameTok, call.group], "REGEXP_LIKE match options other than i/c are not supported");
        return undefined;
    }
    const operator = flags.includes("i") ? "~*" : "~";
    const out = tpl`(${paren(bare(call.args[0]))} ${operator} ${paren(bare(call.args[1]))})`;
    ctx.apply("regexp", [call.nameTok, call.group], out);
    return out;
}

function regexpReplace(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length === 2) {
        const out = tpl`regexp_replace(${bare(call.args[0])}, ${bare(call.args[1])}, '', 'g')`;
        ctx.apply("regexp", [call.nameTok, call.group], out);
        return out;
    }
    if (call.args.length === 3) {
        const out = tpl`regexp_replace(${bare(call.args[0])}, ${bare(call.args[1])}, ${bare(call.args[2])}, 'g')`;
        ctx.apply("regexp", [call.nameTok, call.group], out);
        return out;
    }
    ctx.unsupported([call.nameTok, call.group], "REGEXP_REPLACE with a start position, occurrence or flags is not converted");
    return undefined;
}

function regexpSubstr(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 2) {
        ctx.unsupported([call.nameTok, call.group], "REGEXP_SUBSTR with a position, occurrence or flags is not converted");
        return undefined;
    }
    const out = tpl`substring(${bare(call.args[0])} from ${bare(call.args[1])})`;
    ctx.apply("regexp", [call.nameTok, call.group], out);
    return out;
}

function renameTo(name: string, rule: "string-functions" | "uuid-random" | "unix-time" | "sysdate" | "nvl"): Handler {
    return (call, ctx) => {
        const out = rename(call, name);
        ctx.apply(rule, [call.nameTok, call.group], out);
        return out;
    };
}

function replaceWith(rule: "sysdate" | "uuid-random" | "unix-time", text: string, onlyWithNoArgs = true): Handler {
    return (call, ctx) => {
        if (onlyWithNoArgs && call.args.length !== 0) return undefined;
        const out = fragment(text);
        ctx.apply(rule, [call.nameTok, call.group], out);
        return out;
    };
}

function mysqlDateFormat(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 2) return undefined;
    const format = stringValue(call.args[1]);
    const pg = format !== undefined ? mysqlFormatToPostgres(format) : undefined;
    if (pg === undefined) {
        ctx.unsupported([call.nameTok, call.group], "DATE_FORMAT format could not be translated (it is not a literal, or uses a code such as %D, %U or %w)");
        return undefined;
    }
    const out = tpl`to_char(${bare(call.args[0])}, '${pg.replace(/'/g, "''")}')`;
    ctx.apply("date-format", [call.nameTok, call.group], out);
    return out;
}

function mysqlStrToDate(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 2) return undefined;
    const format = stringValue(call.args[1]);
    const pg = format !== undefined ? mysqlFormatToPostgres(format) : undefined;
    if (pg === undefined) {
        ctx.unsupported([call.nameTok, call.group], "STR_TO_DATE format could not be translated");
        return undefined;
    }
    const hasTime = /HH|MI|SS/.test(pg);
    const out = hasTime ? tpl`to_timestamp(${bare(call.args[0])}, '${pg}')::timestamp` : tpl`to_date(${bare(call.args[0])}, '${pg}')`;
    ctx.apply("date-format", [call.nameTok, call.group], out);
    return out;
}

/** DATE_ADD(d, INTERVAL n UNIT) and DATE_SUB. */
function mysqlDateAdd(sign: "+" | "-"): Handler {
    return (call, ctx) => {
        if (call.args.length !== 2) return undefined;
        const interval = call.args[1];
        if (!isWord(interval[0], "INTERVAL") || interval.length < 3) {
            // ADDDATE(d, n) means days
            if (call.name === "ADDDATE" || call.name === "SUBDATE") {
                const out = tpl`(${bare(call.args[0])} ${sign} ${paren(bare(call.args[1]))} * INTERVAL '1 day')`;
                ctx.apply("date-interval", [call.nameTok, call.group], out);
                return out;
            }
            return undefined;
        }
        const unit = MYSQL_UNITS[upper(interval[interval.length - 1]).toLowerCase()];
        if (!unit) {
            ctx.unsupported([call.nameTok, call.group], `INTERVAL unit "${print(interval.slice(-1)).trim()}" is not converted`);
            return undefined;
        }
        const amount = interval.slice(1, -1);
        const n = isInteger(amount);
        const out = n !== undefined ? tpl`(${bare(call.args[0])} ${sign} INTERVAL '${String(n)} ${unit}')` : tpl`(${bare(call.args[0])} ${sign} ${paren(bare(amount))} * INTERVAL '1 ${unit}')`;
        ctx.apply("date-interval", [call.nameTok, call.group], out);
        return out;
    };
}

function timestampDiff(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 3 || call.args[0].length !== 1) return undefined;
    const unit = upper(call.args[0][0]).toLowerCase();
    const a = bare(call.args[1]);
    const b = bare(call.args[2]);
    let out: Node[] | undefined;
    const seconds: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };
    if (seconds[unit]) out = tpl`trunc(EXTRACT(EPOCH FROM (CAST(${b} AS timestamp) - CAST(${a} AS timestamp))) / ${String(seconds[unit])})::bigint`;
    else if (unit === "month") out = tpl`(EXTRACT(YEAR FROM age(CAST(${b} AS timestamp), CAST(${a} AS timestamp))) * 12 + EXTRACT(MONTH FROM age(CAST(${b} AS timestamp), CAST(${a} AS timestamp))))::bigint`;
    else if (unit === "year") out = tpl`EXTRACT(YEAR FROM age(CAST(${b} AS timestamp), CAST(${a} AS timestamp)))::bigint`;
    if (!out) {
        ctx.unsupported([call.nameTok, call.group], `TIMESTAMPDIFF in ${unit} has no direct equivalent`);
        return undefined;
    }
    ctx.apply("datediff", [call.nameTok, call.group], out);
    return out;
}

function timestampAdd(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 3 || call.args[0].length !== 1) return undefined;
    const unit = MYSQL_UNITS[upper(call.args[0][0]).toLowerCase()];
    if (!unit) {
        ctx.unsupported([call.nameTok, call.group], `TIMESTAMPADD unit ${print(call.args[0]).trim()} is not converted`);
        return undefined;
    }
    const n = isInteger(call.args[1]);
    const out = n !== undefined ? tpl`(${bare(call.args[2])} + INTERVAL '${String(n)} ${unit}')` : tpl`(${bare(call.args[2])} + ${paren(bare(call.args[1]))} * INTERVAL '1 ${unit}')`;
    ctx.apply("date-interval", [call.nameTok, call.group], out);
    return out;
}

function unixTimestamp(call: Call, ctx: Ctx): Node[] | undefined {
    const out = call.args.length === 0 ? tpl`EXTRACT(EPOCH FROM now())::bigint` : call.args.length === 1 ? tpl`EXTRACT(EPOCH FROM ${bare(call.args[0])})::bigint` : undefined;
    if (out) ctx.apply("unix-time", [call.nameTok, call.group], out);
    return out;
}

function fromUnixtime(call: Call, ctx: Ctx): Node[] | undefined {
    if (call.args.length !== 1) return undefined;
    const out = tpl`to_timestamp(${bare(call.args[0])})::timestamp`;
    ctx.apply("unix-time", [call.nameTok, call.group], out);
    return out;
}

function ifFn(call: Call, ctx: Ctx): Node[] | undefined {
    return call.args.length === 3 ? iif(call, ctx) : undefined;
}

function sysContext(call: Call, ctx: Ctx): Node[] | undefined {
    ctx.unsupported([call.nameTok, call.group], "SYS_CONTEXT reads Oracle session settings that don't exist in PostgreSQL");
    return undefined;
}

/** Functions that have no PostgreSQL counterpart, with what to do instead. They are reported and left as written. */
const LEGACY_ONLY: Record<string, { reason: string; hint?: string; dialects?: string[] }> = {
    MONTHS_BETWEEN: { reason: "MONTHS_BETWEEN returns a fractional number of months using a 31-day month, which PostgreSQL has no function for", hint: "age(a, b) gives years, months and days; combine EXTRACT(YEAR/MONTH FROM age(a, b)) if whole months are enough.", dialects: ["oracle"] },
    NEXT_DAY: { reason: "NEXT_DAY has no PostgreSQL function", dialects: ["oracle"] },
    STUFF: { reason: "STUFF has no PostgreSQL function", hint: "Use overlay(s placing r from start for length).", dialects: ["mssql"] },
    FORMAT: { reason: "FORMAT uses .NET format strings, which PostgreSQL does not understand", hint: "Use to_char(value, 'template').", dialects: ["mssql"] },
    ISNUMERIC: { reason: "ISNUMERIC has no equivalent", hint: "Test with a regular expression: value ~ '^[0-9.]+$'.", dialects: ["mssql"] },
    TRY_CONVERT: { reason: "TRY_CONVERT returns NULL instead of an error; PostgreSQL has no function for that", dialects: ["mssql"] },
    TRY_CAST: { reason: "TRY_CAST returns NULL instead of an error; PostgreSQL has no function for that", dialects: ["mssql"] },
    CHOOSE: { reason: "CHOOSE has no PostgreSQL function", hint: "Use CASE.", dialects: ["mssql"] },
    SCOPE_IDENTITY: { reason: "SCOPE_IDENTITY has no equivalent", hint: "Use INSERT … RETURNING id.", dialects: ["mssql"] },
    IDENT_CURRENT: { reason: "IDENT_CURRENT has no equivalent", hint: "Use currval('sequence_name').", dialects: ["mssql"] },
    OBJECT_ID: { reason: "OBJECT_ID looks into SQL Server's catalog", hint: "Use to_regclass('schema.table').", dialects: ["mssql"] },
    SUBSTRING_INDEX: { reason: "SUBSTRING_INDEX has no PostgreSQL function", hint: "Use split_part(s, delimiter, n).", dialects: ["mysql"] },
    FOUND_ROWS: { reason: "FOUND_ROWS has no equivalent", hint: "Run a COUNT(*) query, or use count(*) OVER () in the same query.", dialects: ["mysql"] },
    LAST_INSERT_ID: { reason: "LAST_INSERT_ID has no direct equivalent", hint: "Use INSERT … RETURNING id, or lastval().", dialects: ["mysql"] },
    SYS_CONNECT_BY_PATH: { reason: "SYS_CONNECT_BY_PATH has no direct equivalent", hint: "Build the path inside the recursive part of a WITH RECURSIVE query.", dialects: ["oracle"] },
    CONNECT_BY_ROOT: { reason: "CONNECT_BY_ROOT has no direct equivalent", hint: "Carry the root value through a recursive CTE.", dialects: ["oracle"] },
    WM_CONCAT: { reason: "WM_CONCAT is undocumented and has no equivalent", hint: "Use string_agg.", dialects: ["oracle"] },
    NLS_UPPER: { reason: "NLS_* functions depend on Oracle's language settings", dialects: ["oracle"] },
    NLS_LOWER: { reason: "NLS_* functions depend on Oracle's language settings", dialects: ["oracle"] },
    NLS_SORT: { reason: "NLS_* functions depend on Oracle's language settings", dialects: ["oracle"] },
    USERENV: { reason: "USERENV reads Oracle session settings", dialects: ["oracle"] },
    LENGTHB: { reason: "LENGTHB counts bytes", hint: "Use octet_length(x).", dialects: ["oracle"] },
    REGEXP_INSTR: { reason: "REGEXP_INSTR has no PostgreSQL function", dialects: ["oracle"] },
    REGEXP_COUNT: { reason: "REGEXP_COUNT has no PostgreSQL function", hint: "Use (SELECT count(*) FROM regexp_matches(s, p, 'g')).", dialects: ["oracle"] },
    SYS_GUID: { reason: "SYS_GUID returns 16 raw bytes (32 hex characters); PostgreSQL has no RAW type", hint: "Use gen_random_uuid() and a uuid column.", dialects: ["oracle"] },
    FORMATMESSAGE: { reason: "FORMATMESSAGE has no equivalent", dialects: ["mssql"] },
    KEEP: { reason: "KEEP (DENSE_RANK FIRST/LAST …) has no PostgreSQL syntax", hint: "Use (array_agg(x ORDER BY y))[1], or DISTINCT ON, or a window function with row_number().", dialects: ["oracle"] },
    FIND_IN_SET: { reason: "FIND_IN_SET has no PostgreSQL function", hint: "Use value = ANY (string_to_array(list, ',')).", dialects: ["mysql"] },
    PIVOT: { reason: "PIVOT has no PostgreSQL syntax", hint: "Use conditional aggregation: sum(CASE WHEN … END).", dialects: ["oracle", "mssql"] },
    UNPIVOT: { reason: "UNPIVOT has no PostgreSQL syntax", hint: "Use a LATERAL join over a VALUES list.", dialects: ["oracle", "mssql"] },
};

const HANDLERS: Record<string, Handler> = {
    NVL: (call, ctx) => (ctx.dialect === "oracle" || ctx.dialect === "db2" ? nvl(call, ctx) : undefined),
    ISNULL: (call, ctx) => (ctx.dialect === "mssql" || ctx.dialect === "mysql" ? nvl(call, ctx) : undefined),
    IFNULL: (call, ctx) => (ctx.dialect === "mysql" ? nvl(call, ctx) : undefined),
    VALUE: (call, ctx) => (ctx.dialect === "db2" ? nvl(call, ctx) : undefined),
    NVL2: nvl2,
    DECODE: (call, ctx) => (ctx.dialect === "oracle" || ctx.dialect === "db2" ? decode(call, ctx) : undefined),
    IIF: (call, ctx) => (ctx.dialect === "mssql" ? iif(call, ctx) : undefined),
    IF: (call, ctx) => (ctx.dialect === "mysql" ? ifFn(call, ctx) : undefined),
    ADD_MONTHS: addMonths,
    LAST_DAY: lastDay,
    TRUNC: (call, ctx) => (ctx.dialect === "oracle" ? truncFn(call, ctx) : undefined),
    TO_CHAR: (call, ctx) => (ctx.dialect === "oracle" ? toChar(call, ctx) : undefined),
    TO_NUMBER: (call, ctx) => (ctx.dialect === "oracle" ? toNumber(call, ctx) : undefined),
    TO_DATE: (call, ctx) => (ctx.dialect === "oracle" ? toDate(call, ctx) : undefined),
    TO_TIMESTAMP: (call, ctx) => (ctx.dialect === "oracle" ? toDate(call, ctx) : undefined),
    GETDATE: replaceWith("sysdate", "CURRENT_TIMESTAMP"),
    SYSDATETIME: replaceWith("sysdate", "CURRENT_TIMESTAMP"),
    GETUTCDATE: replaceWith("sysdate", "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')"),
    CURDATE: replaceWith("sysdate", "CURRENT_DATE"),
    CURTIME: replaceWith("sysdate", "CURRENT_TIME"),
    SYSDATE: (call, ctx) => (ctx.dialect === "mysql" ? replaceWith("sysdate", "clock_timestamp()")(call, ctx) : undefined),
    DATEADD: dateadd,
    DATEDIFF: datediff,
    DATEPART: datepart,
    YEAR: datePartShortcut("YEAR"),
    MONTH: datePartShortcut("MONTH"),
    DAY: datePartShortcut("DAY"),
    DAYOFMONTH: datePartShortcut("DAY"),
    HOUR: datePartShortcut("HOUR"),
    MINUTE: datePartShortcut("MINUTE"),
    SECOND: datePartShortcut("SECOND"),
    QUARTER: datePartShortcut("QUARTER"),
    WEEK: (call, ctx) => (ctx.dialect === "mysql" ? undefined : undefined),
    CONVERT: (call, ctx) => (ctx.dialect === "mssql" ? convertFn(call, ctx) : undefined),
    CAST: castFn,
    LISTAGG: listagg,
    GROUP_CONCAT: (call, ctx) => (ctx.dialect === "mysql" ? groupConcat(call, ctx) : undefined),
    STRING_AGG: (call, ctx) => (ctx.dialect === "mssql" ? stringAgg(call, ctx) : undefined),
    CONCAT: concatFn,
    LEN: lenFn,
    LENGTH: lenFn,
    CHARINDEX: (call, ctx) => (ctx.dialect === "mssql" ? charindex(call, ctx) : undefined),
    INSTR: (call, ctx) => (ctx.dialect === "oracle" || ctx.dialect === "mysql" ? instr(call, ctx) : undefined),
    LOCATE: (call, ctx) => (ctx.dialect === "mysql" ? locate(call, ctx) : undefined),
    REGEXP_LIKE: regexpLike,
    REGEXP_REPLACE: (call, ctx) => (ctx.dialect === "oracle" ? regexpReplace(call, ctx) : undefined),
    REGEXP_SUBSTR: regexpSubstr,
    REPLICATE: renameTo("repeat", "string-functions"),
    LCASE: renameTo("lower", "string-functions"),
    UCASE: renameTo("upper", "string-functions"),
    CHAR: (call, ctx) => (ctx.dialect === "mssql" && call.args.length === 1 ? renameTo("chr", "string-functions")(call, ctx) : undefined),
    SPACE: (call, ctx) => {
        if (call.args.length !== 1) return undefined;
        const out = tpl`repeat(' ', ${bare(call.args[0])})`;
        ctx.apply("string-functions", [call.nameTok, call.group], out);
        return out;
    },
    NEWID: replaceWith("uuid-random", "gen_random_uuid()"),
    UUID: replaceWith("uuid-random", "gen_random_uuid()"),
    RAND: (call, ctx) => (ctx.dialect === "mysql" || ctx.dialect === "mssql" ? replaceWith("uuid-random", "random()")(call, ctx) : undefined),
    DATE_FORMAT: mysqlDateFormat,
    STR_TO_DATE: mysqlStrToDate,
    DATE_ADD: mysqlDateAdd("+"),
    DATE_SUB: mysqlDateAdd("-"),
    ADDDATE: mysqlDateAdd("+"),
    SUBDATE: mysqlDateAdd("-"),
    TIMESTAMPDIFF: timestampDiff,
    TIMESTAMPADD: timestampAdd,
    UNIX_TIMESTAMP: unixTimestamp,
    FROM_UNIXTIME: fromUnixtime,
    SYS_CONTEXT: sysContext,
    COUNT_BIG: renameTo("count", "string-functions"),
    DATE: (call, ctx) => {
        if (ctx.dialect !== "mysql" || call.args.length !== 1) return undefined;
        const out = tpl`CAST(${bare(call.args[0])} AS date)`;
        ctx.apply("date-format", [call.nameTok, call.group], out);
        return out;
    },
};

// ---- keyword-level rules ----------------------------------------------------------------------------------------

const IGNORED_NON_CALLS = new Set([
    "IN", "EXISTS", "AND", "OR", "NOT", "ON", "AS", "FROM", "JOIN", "WHERE", "SELECT", "VALUES", "UNION", "ALL", "ANY", "SOME", "USING", "WITH", "BY", "CASE", "WHEN", "THEN", "ELSE", "BETWEEN", "LIKE", "IS",
    "INTO", "SET", "OVER", "LATERAL", "LIMIT", "OFFSET", "HAVING", "EXCEPT", "INTERSECT", "MINUS", "CROSS", "INNER", "OUTER", "FULL", "NATURAL", "RETURNING", "DISTINCT", "TABLE", "WITHIN", "GROUP", "ORDER",
    "PARTITION", "FILTER", "UPDATE", "INSERT", "DELETE", "DEFAULT", "KEY", "INDEX", "APPLY", "ON", "REGEXP", "RLIKE", "TOP", "FETCH", "ROWS", "ONLY",
]);

/** Reads `a.b.c` starting at index i. Returns the name parts and the index after the last one. */
function readChain(items: Node[], start: number): { parts: Token[]; end: number } | undefined {
    const first = items[start];
    if (!isToken(first) || (first.kind !== "word" && first.kind !== "ident")) return undefined;
    const parts: Token[] = [first];
    let end = start + 1;
    while (isPunct(items[end], ".") && isToken(items[end + 1]) && ((items[end + 1] as Token).kind === "word" || (items[end + 1] as Token).kind === "ident")) {
        parts.push(items[end + 1] as Token);
        end += 2;
    }
    return { parts, end };
}

const SEQUENCE_PART = /^(NEXTVAL|CURRVAL)$/i;

function sequenceName(parts: Token[]): string {
    return parts
        .map((part) => (part.kind === "ident" && part.quote === "double" ? `"${part.value}"` : (part.value ?? part.text).toLowerCase()))
        .join(".");
}

const HINT_WORDS = /^(NOLOCK|READUNCOMMITTED|READCOMMITTED|REPEATABLEREAD|SERIALIZABLE|ROWLOCK|PAGLOCK|TABLOCK|TABLOCKX|UPDLOCK|XLOCK|HOLDLOCK|READPAST|NOWAIT|NOEXPAND|FORCESEEK|FORCESCAN|INDEX|SNAPSHOT)$/i;

const TEXT_FUNCTIONS = new Set(["LPAD", "RPAD", "SUBSTR", "SUBSTRING", "LENGTH", "UPPER", "LOWER", "TRIM", "LTRIM", "RTRIM", "REPLACE", "INITCAP", "INSTR", "LEFT", "RIGHT", "CHARINDEX", "LEN"]);

/** Oracle and SQL Server convert a number or date to text on their own when a text function needs it; PostgreSQL does not. */
function castFirstArgument(call: Call, ctx: Ctx): Call {
    const first = call.args[0];
    if (!first || first.length === 0) return call;
    const kind = valueKind(first, ctx);
    if (kind !== "number" && kind !== "date") return call;
    const wrapped = tpl`CAST(${bare(first)} AS text)`;
    const group: Group = { ...call.group, items: [...wrapped.map((node, index) => (index === 0 ? ({ ...node, ws: isToken(first[0]) ? first[0].ws : undefined } as Node) : node)), ...call.group.items.slice(first.length)] };
    ctx.apply("implicit-cast", print(first), print(wrapped));
    return { ...call, group, args: argsOf(group) };
}

/** Rewrites one list of nodes (the children have already been rewritten). */
export function rewriteExpressions(items: Node[], ctx: Ctx): Node[] {
    const out: Node[] = [];
    let i = 0;

    while (i < items.length) {
        const node = items[i];

        // Oracle optimizer hints
        if (isToken(node) && node.kind === "hint") {
            ctx.apply("hints", node.text, "");
            i++;
            continue;
        }

        if (isToken(node) && (node.kind === "word" || node.kind === "ident")) {
            const chain = readChain(items, i);
            if (chain) {
                const { parts, end } = chain;
                for (const part of parts) if (part.kind === "ident" && (part.quote === "bracket" || part.quote === "backtick" || part.converted)) ctx.apply("quoted-names", part.quote === "bracket" ? `[${part.value}]` : part.quote === "backtick" ? `\`${part.value}\`` : `"${part.value}"`, part.text);
                const last = parts[parts.length - 1];
                const lastName = (last.value ?? last.text).toUpperCase();

                if (ctx.dialect === "oracle" && parts.length === 2 && /^DBMS_RANDOM$/i.test(parts[0].text) && /^VALUE$/i.test(lastName) && !isGroup(items[end])) {
                    const replacement = tpl`random()`;
                    ctx.apply("uuid-random", print(items.slice(i, end)), print(replacement));
                    out.push({ ...(replacement[0] as Token), ws: node.ws }, ...replacement.slice(1));
                    i = end;
                    continue;
                }

                // Oracle sequences: seq.NEXTVAL, schema.seq.NEXTVAL
                if (parts.length >= 2 && SEQUENCE_PART.test(lastName) && (ctx.dialect === "oracle" || ctx.dialect === "db2")) {
                    const fn = lastName === "NEXTVAL" ? "nextval" : "currval";
                    const replacement = tpl`${fn}('${sequenceName(parts.slice(0, -1)).replace(/'/g, "''")}')`;
                    ctx.apply("sequence", print(items.slice(i, end)), print(replacement));
                    out.push({ ...(replacement[0] as Token), ws: node.ws }, ...replacement.slice(1));
                    i = end;
                    continue;
                }

                // DB2: NEXT VALUE FOR seq
                if (ctx.dialect === "db2" && parts.length === 1 && lastName === "NEXT" && isWord(items[i + 1], "VALUE") && isWord(items[i + 2], "FOR")) {
                    const target = readChain(items, i + 3);
                    if (target) {
                        const replacement = tpl`nextval('${sequenceName(target.parts)}')`;
                        ctx.apply("sequence", print(items.slice(i, target.end)), print(replacement));
                        out.push({ ...(replacement[0] as Token), ws: node.ws }, ...replacement.slice(1));
                        i = target.end;
                        continue;
                    }
                }

                // Function calls
                if (isGroup(items[end]) && items[end].open.text === "(" && node.kind === "word" && !(parts.length === 1 && IGNORED_NON_CALLS.has(lastName)) && last.kind === "word") {
                    const group = items[end] as Group;
                    const qualifier = parts.slice(0, -1);
                    let call: Call = { name: lastName, nameTok: { ...last, ws: qualifier.length ? last.ws : node.ws }, qualifier, group, args: argsOf(group), rest: items.slice(end + 1) };
                    if (qualifier.length === 0 && TEXT_FUNCTIONS.has(lastName)) call = castFirstArgument(call, ctx);

                    if (qualifier.length === 0) {
                        const legacy = LEGACY_ONLY[lastName];
                        if (legacy && legacy.dialects?.includes(ctx.dialect)) ctx.unsupported([call.nameTok, group], legacy.reason, legacy.hint);

                        const handler = HANDLERS[lastName];
                        const result = handler?.(call, ctx);
                        if (result) {
                            const nodes = Array.isArray(result) ? result : result.nodes;
                            const consumed = Array.isArray(result) ? 0 : (result.consumed ?? 0);
                            const first = nodes[0];
                            out.push(isToken(first) ? { ...first, ws: node.ws } : first, ...nodes.slice(1));
                            i = end + 1 + consumed;
                            continue;
                        }
                    } else if (/^(DBMS_|UTL_|SYS)/i.test(parts[0].text) && ctx.dialect === "oracle") {
                        if (/^DBMS_RANDOM$/i.test(parts[0].text) && /^VALUE$/i.test(lastName) && call.args.length === 0) {
                            const out2 = tpl`random()`;
                            ctx.apply("uuid-random", print(items.slice(i, end + 1)), print(out2));
                            out.push({ ...(out2[0] as Token), ws: node.ws }, ...out2.slice(1));
                            i = end + 1;
                            continue;
                        }
                        ctx.unsupported([...parts, group] as Node[], `${parts[0].text} is an Oracle built-in package; PostgreSQL has no equivalent`);
                    }
                    // not rewritten: keep the call as written (with the text cast, if one was added)
                    if (call.group !== group) out.push(...items.slice(i, end), call.group);
                    else out.push(...items.slice(i, end + 1));
                    i = end + 1;
                    continue;
                }

                // Date / time keywords
                if (parts.length === 1 && node.kind === "word") {
                    const name = lastName;
                    if (ctx.dialect === "oracle" && (name === "SYSDATE" || name === "SYSTIMESTAMP") && !isGroup(items[end])) {
                        ctx.apply("sysdate", node.text, "CURRENT_TIMESTAMP");
                        out.push({ kind: "word", text: "CURRENT_TIMESTAMP", ws: node.ws, value: "sysdate" });
                        i = end;
                        continue;
                    }
                    if (ctx.dialect === "db2" && name === "CURRENT" && isWord(items[i + 1], "DATE", "TIMESTAMP", "TIME")) {
                        const unit = upper(items[i + 1]);
                        const text = unit === "DATE" ? "CURRENT_DATE" : unit === "TIME" ? "CURRENT_TIME" : "CURRENT_TIMESTAMP";
                        ctx.apply("sysdate", `CURRENT ${unit}`, text);
                        out.push({ kind: "word", text, ws: node.ws });
                        i += 2;
                        continue;
                    }
                    if (ctx.dialect === "mysql" && name === "CURRENT_DATE" && isGroup(items[end]) && (items[end] as Group).items.length === 0) {
                        ctx.apply("sysdate", "CURRENT_DATE()", "CURRENT_DATE");
                        out.push(node);
                        i = end + 1;
                        continue;
                    }
                }

                // not a call or a special name: copy the chain as it is
                out.push(...items.slice(i, end));
                i = end;
                continue;
            }
        }

        out.push(node);
        i++;
    }

    return postOperators(out, ctx);
}

// ---- operators ---------------------------------------------------------------------------------------------------

/** Rules that look at the operators between operands: + as string concatenation, date ± days, <=>, REGEXP. */
function postOperators(items: Node[], ctx: Ctx): Node[] {
    let out = items;
    if (ctx.dialect === "mssql") out = concatPlus(out, ctx);
    if (ctx.dialect === "oracle") out = dateArithmetic(out, ctx);
    if (ctx.dialect === "mysql") out = mysqlOperators(out, ctx);
    if (ctx.dialect === "db2") out = db2Durations(out, ctx);
    return out;
}

/** Operands of `a + b + c` chains, as index ranges into the list. */
function additiveChains(items: Node[]): { start: number; end: number; plusAt: number[] }[] {
    const chains: { start: number; end: number; plusAt: number[] }[] = [];
    let start = 0;
    let plusAt: number[] = [];
    const flush = (end: number) => {
        if (plusAt.length > 0) chains.push({ start, end, plusAt });
        plusAt = [];
    };
    const BREAKERS = new Set(["AND", "OR", "NOT", "WHEN", "THEN", "ELSE", "CASE", "END", "WHERE", "ON", "SELECT", "FROM", "BETWEEN", "IN", "LIKE", "IS", "AS", "BY", "HAVING", "SET", "VALUES", "AT"]);
    for (let i = 0; i < items.length; i++) {
        const node = items[i];
        if (isOp(node, "+")) plusAt.push(i);
        else if (isPunct(node, ",") || (isToken(node) && node.kind === "word" && BREAKERS.has(node.text.toUpperCase())) || (isOp(node) && !isOp(node, "+", "-", "*", "/", "%", "::", "||"))) {
            flush(i);
            start = i + 1;
        }
    }
    flush(items.length);
    return chains;
}

function isTextOperand(nodes: Node[], ctx: Ctx): boolean {
    if (nodes.length === 0) return false;
    if (nodes.length === 1 && isToken(nodes[0]) && nodes[0].kind === "string") return true;
    const first = nodes[0];
    if (isToken(first) && first.kind === "word" && isGroup(nodes[1])) {
        const name = first.text.toUpperCase();
        if (/^(UPPER|LOWER|LTRIM|RTRIM|TRIM|SUBSTRING|SUBSTR|REPLACE|LEFT|RIGHT|STR|REPLICATE|REPEAT|CHR|CHAR|CONCAT|LPAD|RPAD)$/.test(name)) return true;
        if (name === "CAST") {
            const text = print((nodes[1] as Group).items).toLowerCase();
            return /\bas\s+(n?var)?char|\bas\s+text/.test(text);
        }
    }
    return valueKind(nodes, ctx) === "text";
}

function concatPlus(items: Node[], ctx: Ctx): Node[] {
    const chains = additiveChains(items);
    if (chains.length === 0) return items;
    const out = [...items];
    for (const chain of chains) {
        // operand ranges
        const bounds = [chain.start - 1, ...chain.plusAt, chain.end];
        const operands: Node[][] = [];
        for (let k = 0; k < bounds.length - 1; k++) operands.push(items.slice(bounds[k] + 1, bounds[k + 1]));
        // a chain that mixes + with - or * can't be judged as a whole; only operands that stand alone count
        if (operands.some((operand) => operand.length > 0 && isTextOperand(operand, ctx))) {
            for (const index of chain.plusAt) {
                const plus = items[index] as Token;
                out[index] = { ...plus, text: "||" };
            }
            ctx.apply("concat-plus", "a + b", "a || b");
        }
    }
    return out;
}

/** SYSDATE + 7, SYSDATE - 1/24: Oracle adds days as numbers; PostgreSQL needs an interval. */
function dateArithmetic(items: Node[], ctx: Ctx): Node[] {
    const out: Node[] = [];
    let i = 0;
    const isSysdate = (node: Node | undefined) => isToken(node) && node.kind === "word" && node.value === "sysdate";
    while (i < items.length) {
        const node = items[i];
        if (isSysdate(node) && isOp(items[i + 1], "+", "-")) {
            const sign = (items[i + 1] as Token).text;
            // operand: numbers and arithmetic on numbers/bind variables, up to the next token that can't be part of it
            let j = i + 2;
            const operand: Node[] = [];
            while (j < items.length) {
                const candidate = items[j];
                if (isToken(candidate) && (candidate.kind === "number" || candidate.kind === "param")) operand.push(candidate);
                else if (isOp(candidate, "*", "/")) operand.push(candidate);
                else if (isGroup(candidate) && candidate.items.every((child) => (isToken(child) && (child.kind === "number" || child.kind === "param" || child.kind === "op")) || isGroup(child))) operand.push(candidate);
                else break;
                j++;
            }
            const endsWithOperator = operand.length > 0 && isOp(operand[operand.length - 1]);
            const startsWithOperator = operand.length > 0 && isOp(operand[0]);
            if (operand.length > 0 && !endsWithOperator && !startsWithOperator && !isOp(items[j], "+", "-", "*", "/")) {
                const days = isInteger(operand);
                const exact = numericDivision(operand);
                const nodes = days !== undefined ? tpl`CURRENT_TIMESTAMP ${sign} INTERVAL '${String(days)} day'` : tpl`CURRENT_TIMESTAMP ${sign} ${paren(exact)} * INTERVAL '1 day'`;
                ctx.apply("date-arithmetic", `SYSDATE ${sign} ${print(normalize(operand)).trim()}`, print(nodes));
                out.push({ ...(nodes[0] as Token), ws: (node as Token).ws }, ...nodes.slice(1));
                i = j;
                continue;
            }
            if (operand.length === 0) {
                // SYSDATE - hire_date: a difference of two dates (a number of days in Oracle, an interval in PostgreSQL)
                const next = items[i + 2];
                if (isToken(next) && (next.kind === "word" || next.kind === "ident") && ctx.schema.isDateColumn(next.value ?? next.text) && sign === "-") {
                    ctx.unsupported(print(items.slice(i, i + 3)), "Subtracting two dates gives a number of days in Oracle but an interval in PostgreSQL", "Use EXTRACT(EPOCH FROM (a - b)) / 86400 for fractional days, or CAST(a AS date) - CAST(b AS date) for whole days.");
                }
            }
        }
        out.push(node);
        i++;
    }
    return out;
}

/** DB2's labeled durations: CURRENT DATE + 7 DAYS, d - 1 MONTH. */
function db2Durations(items: Node[], ctx: Ctx): Node[] {
    const out: Node[] = [];
    for (let i = 0; i < items.length; i++) {
        const node = items[i];
        const unit = isWord(items[i + 1]) ? /^(YEAR|MONTH|DAY|HOUR|MINUTE|SECOND)S?$/i.exec((items[i + 1] as Token).text)?.[1] : undefined;
        if (isToken(node) && node.kind === "number" && unit && isOp(items[i - 1], "+", "-")) {
            const replacement = tpl`INTERVAL '${node.text} ${unit.toLowerCase()}'`;
            ctx.apply("date-interval", `${node.text} ${(items[i + 1] as Token).text}`, print(replacement));
            out.push({ ...(replacement[0] as Token), ws: node.ws }, ...replacement.slice(1));
            i++;
            continue;
        }
        out.push(node);
    }
    return out;
}

/** Oracle divides exactly (1/24 is 0.0416…); PostgreSQL truncates integer division. Makes the operand before each / numeric. */
function numericDivision(operand: Node[]): Node[] {
    return operand.flatMap((node, index) => {
        if (!isOp(operand[index + 1], "/") || !isToken(node)) return [node];
        if (node.kind === "number" && /^\d+$/.test(node.text)) return [{ ...node, text: `${node.text}.0` }];
        if (node.kind === "param" || node.kind === "word") return tpl`CAST(${[node]} AS numeric)`;
        return [node];
    });
}

function mysqlOperators(items: Node[], ctx: Ctx): Node[] {
    const out: Node[] = [];
    for (let i = 0; i < items.length; i++) {
        const node = items[i];
        if (isOp(node, "<=>")) {
            ctx.apply("null-safe-equals", "<=>", "IS NOT DISTINCT FROM");
            out.push(...tpl`IS NOT DISTINCT FROM`.map((token, index) => (index === 0 ? { ...token, ws: (node as Token).ws } : token)));
            continue;
        }
        if (isWord(node, "REGEXP", "RLIKE")) {
            ctx.apply("regexp", node.text, "~*");
            out.push({ kind: "op", text: "~*", ws: node.ws });
            continue;
        }
        if (isWord(node, "NOT") && isWord(items[i + 1], "REGEXP", "RLIKE")) {
            ctx.apply("regexp", "NOT REGEXP", "!~*");
            out.push({ kind: "op", text: "!~*", ws: (node as Token).ws });
            i++;
            continue;
        }
        out.push(node);
    }
    return out;
}

export { buildTree, identifierText, textOf, word };
