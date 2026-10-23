/** Small pieces every statement the runbook compiler writes is built from. */

// PostgreSQL's reserved keywords (the ones that can't be used as a bare name). Anything else that is a plain lower-case name is left unquoted.
const RESERVED = new Set(
    (
        "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross " +
        "current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for " +
        "foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not " +
        "notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true " +
        "union unique user using variadic verbose when where window with"
    ).split(" "),
);

/** A name as it can appear in SQL: bare when it is a plain lower-case word that isn't reserved, double-quoted otherwise. */
export function ident(name: string): string {
    if (name.includes("\0")) throw new Error("A name contains a null byte");
    return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export const qualifiedIdent = (schema: string, name: string): string => `${ident(schema)}.${ident(name)}`;

export function literal(value: string): string {
    if (value.includes("\0")) throw new Error("A value contains a null byte");
    const escaped = value.replace(/'/g, "''");
    return value.includes("\\") ? `E'${escaped.replace(/\\/g, "\\\\")}'` : `'${escaped}'`;
}

/** PostgreSQL truncates names at 63 bytes; make that explicit and keep the names this compiler invents unique. */
export function limitName(name: string, taken: ReadonlySet<string> = new Set()): string {
    const max = 63;
    const bytes = (text: string) => Buffer.byteLength(text);
    let base = name;
    while (bytes(base) > max) base = base.slice(0, -1);
    if (!taken.has(base)) return base;
    for (let n = 1; ; n++) {
        const suffix = `_${n}`;
        let head = name;
        while (bytes(head + suffix) > max) head = head.slice(0, -1);
        if (!taken.has(head + suffix)) return head + suffix;
    }
}

// ---- types ----------------------------------------------------------------------------------------------------------------

export interface TypeSpec {
    dataType: string;
    maxLength?: number | null;
    precision?: number | null;
    scale?: number | null;
}

const LENGTH_TYPES = /^(varchar|character varying|char|character|bpchar|bit|varbit|bit varying)$/i;
const NUMERIC_TYPES = /^(numeric|decimal)$/i;

/** `varchar` + maxLength 40 -> `varchar(40)`; `numeric` + precision 12, scale 2 -> `numeric(12,2)`; a type that already has arguments is kept as written. */
export function renderType(spec: TypeSpec): string {
    const base = spec.dataType.trim().replace(/\s+/g, " ");
    if (base.includes("(")) return base;
    const arrayMatch = /^(.*?)((?:\s*\[\s*\d*\s*\])*)$/.exec(base);
    const bare = arrayMatch?.[1] ?? base;
    const suffix = arrayMatch?.[2] ?? "";
    if (LENGTH_TYPES.test(bare) && spec.maxLength) return `${bare}(${spec.maxLength})${suffix}`;
    if (NUMERIC_TYPES.test(bare) && spec.precision) return `${bare}(${spec.precision}${spec.scale !== null && spec.scale !== undefined ? `,${spec.scale}` : ""})${suffix}`;
    return base;
}

/** The base name of a type with its length/precision and array brackets removed: `character varying(20)` -> `character varying`. */
export const baseType = (type: string): string => type.replace(/\(.*?\)/g, "").replace(/\s*\[.*$/, "").trim().toLowerCase();

const INTEGER_TYPES = new Set(["smallint", "integer", "bigint", "int", "int2", "int4", "int8"]);
export const isIntegerType = (type: string): boolean => INTEGER_TYPES.has(baseType(type));

// ---- default expressions ----------------------------------------------------------------------------------------------------

/**
 * A default must be one expression: literals, a few operators, casts and function calls. Statement separators, comments,
 * sub-selects and dollar quotes are refused, so a default can't smuggle a second statement into the runbook.
 */
export function checkDefaultExpression(expression: string): string | undefined {
    const text = expression.trim();
    if (!text) return "The default is empty.";
    if (text.length > 400) return "The default expression is too long.";
    // Remove string literals before looking for forbidden characters, so a ';' inside text is fine.
    const withoutStrings = text.replace(/'(?:[^']|'')*'/g, "0");
    if (/'/.test(withoutStrings)) return "The default has an unterminated string.";
    if (/;|--|\/\*|\$\$|\$[A-Za-z_]*\$/.test(withoutStrings)) return "The default may not contain ';', comments or dollar quotes.";
    if (/\b(select|insert|update|delete|drop|alter|create|truncate|grant|copy|do|call)\b/i.test(withoutStrings)) return "The default must be a single expression, not a statement.";
    // The expression is placed inside CAST((...) AS type) to be checked, so it must not be able to close that parenthesis.
    let depth = 0;
    for (const character of withoutStrings) {
        if (character === "(") depth++;
        if (character === ")" && --depth < 0) return "The default has a closing parenthesis without an opening one.";
    }
    if (depth !== 0) return "The default has an opening parenthesis that is never closed.";
    return undefined;
}

/** Names of the functions a default expression calls (`now()` -> now). */
export function functionsIn(expression: string): string[] {
    const withoutStrings = expression.replace(/'(?:[^']|'')*'/g, "''");
    const names = new Set<string>();
    for (const match of withoutStrings.matchAll(/([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g)) names.add(match[1].toLowerCase());
    for (const keyword of ["cast", "coalesce", "nullif", "greatest", "least", "array", "row", "case", "in"]) names.delete(keyword);
    return [...names];
}

export const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};

export const formatCount = (value: number): string => new Intl.NumberFormat("en-US").format(Math.round(value));
