import type { ColumnKind, OracleColumn, OracleTable } from "./oracle-migration.js";

/**
 * What a person (or the assistant that works for them) may change in an Oracle to PostgreSQL migration plan, and the rules that decide
 * whether a change is allowed. Nothing here trusts the caller: a type is parsed against a whitelist for the column's Oracle type, a name must
 * be a plain PostgreSQL identifier, and a change with no rule is refused with the reason. The plan is then built from the edits like any other.
 */

/** What the person changed, keyed by Oracle names: `TABLE` for a table, `TABLE.COLUMN` for a column. */
export interface MigrationEdits {
    tables?: Record<string, { pgName?: string }>;
    columns?: Record<string, { pgName?: string; pgType?: string; dropDefault?: boolean }>;
    /** Indexes and CHECK constraints to carry over, keyed `index:NAME` or `check:NAME` by their Oracle names. Absent: left behind, as they are by default. */
    objects?: Record<string, { carry: boolean }>;
}

export const columnKey = (table: string, column: string): string => `${table}.${column}`;
/** The key of an index (`index:NAME`) or CHECK constraint (`check:NAME`) in `MigrationEdits.objects`, by its Oracle name. */
export const objectKey = (kind: "index" | "check", name: string): string => `${kind}:${name}`;

export type OracleFamily = "number" | "float" | "string" | "clob" | "date" | "timestamp" | "timestamptz" | "binary" | "rowid" | "other";

export function oracleFamily(column: Pick<OracleColumn, "type">): OracleFamily {
    const base = column.type.replace(/\(\d+\)/, "").toUpperCase();
    switch (base) {
        case "NUMBER":
            return "number";
        case "FLOAT":
        case "BINARY_FLOAT":
        case "BINARY_DOUBLE":
            return "float";
        case "VARCHAR2":
        case "NVARCHAR2":
        case "CHAR":
        case "NCHAR":
            return "string";
        case "CLOB":
        case "NCLOB":
            return "clob";
        case "DATE":
            return "date";
        case "TIMESTAMP":
            return "timestamp";
        case "TIMESTAMP WITH TIME ZONE":
        case "TIMESTAMP WITH LOCAL TIME ZONE":
            return "timestamptz";
        case "BLOB":
        case "RAW":
            return "binary";
        case "ROWID":
        case "UROWID":
            return "rowid";
        default:
            return "other";
    }
}

export type PgName = "smallint" | "integer" | "bigint" | "real" | "double precision" | "numeric" | "boolean" | "text" | "varchar" | "char" | "date" | "timestamp" | "timestamptz" | "bytea";

export interface ParsedPgType {
    name: PgName;
    /** The type as PostgreSQL will be told it: `numeric(12,2)`, `varchar(40)`, `timestamp(3)`. */
    canonical: string;
    precision?: number;
    scale?: number;
    length?: number;
}

const SYNONYMS: [RegExp, string][] = [
    [/^(int|int4)$/, "integer"],
    [/^int8$/, "bigint"],
    [/^int2$/, "smallint"],
    [/^float8$/, "double precision"],
    [/^(float4)$/, "real"],
    [/^bool$/, "boolean"],
    [/^decimal(?=\(|$)/, "numeric"],
    [/^character varying(?=\(|$)/, "varchar"],
    [/^character(?=\(|$)/, "char"],
    [/^timestamp with time zone(?=\(|$)/, "timestamptz"],
    [/^timestamp without time zone(?=\(|$)/, "timestamp"],
];

/** A PostgreSQL type as typed by a person, in the one spelling the migration writes, or undefined when it is not one of the types the migration knows. */
export function parsePgType(text: string): ParsedPgType | undefined {
    let value = text.trim().toLowerCase().replace(/\s+/g, " ");
    for (const [pattern, replacement] of SYNONYMS) value = value.replace(pattern, replacement);
    if (/^(smallint|integer|bigint|real|double precision|boolean|text|date|bytea)$/.test(value)) return { name: value as PgName, canonical: value };
    let match = /^numeric(?:\((\d{1,4})(?:,\s*(\d{1,4}))?\))?$/.exec(value);
    if (match) {
        if (match[1] === undefined) return { name: "numeric", canonical: "numeric" };
        const precision = Number(match[1]);
        const scale = match[2] === undefined ? 0 : Number(match[2]);
        if (precision < 1 || precision > 1000 || scale > precision) return undefined;
        return { name: "numeric", canonical: `numeric(${precision},${scale})`, precision, scale };
    }
    match = /^(varchar|char)\((\d{1,8})\)$/.exec(value);
    if (match) {
        const length = Number(match[2]);
        if (length < 1 || length > 10_485_760) return undefined;
        return { name: match[1] as PgName, canonical: `${match[1]}(${length})`, length };
    }
    match = /^(timestamp|timestamptz)(?:\((\d)\))?$/.exec(value);
    if (match) {
        const precision = match[2] === undefined ? 6 : Number(match[2]);
        if (precision > 6) return undefined;
        return { name: match[1] as PgName, canonical: `${match[1]}(${precision})`, precision };
    }
    return undefined;
}

const ALLOWED: Record<OracleFamily, PgName[]> = {
    number: ["smallint", "integer", "bigint", "numeric", "real", "double precision", "boolean", "text"],
    float: ["double precision", "real", "numeric", "text"],
    string: ["varchar", "char", "text", "smallint", "integer", "bigint", "numeric", "boolean"],
    clob: ["text"],
    date: ["timestamp", "date", "text"],
    timestamp: ["timestamp", "date", "text"],
    timestamptz: ["timestamptz", "text"],
    binary: ["bytea"],
    rowid: ["text"],
    other: [],
};

const SPELLING: Record<PgName, string> = {
    smallint: "smallint",
    integer: "integer",
    bigint: "bigint",
    real: "real",
    "double precision": "double precision",
    numeric: "numeric or numeric(p,s)",
    boolean: "boolean",
    text: "text",
    varchar: "varchar(n)",
    char: "char(n)",
    date: "date",
    timestamp: "timestamp(n)",
    timestamptz: "timestamptz(n)",
    bytea: "bytea",
};

/** The PostgreSQL types this column may become, as they would be written. */
export const allowedPgTypes = (column: Pick<OracleColumn, "type">): string[] => ALLOWED[oracleFamily(column)].map((name) => SPELLING[name]);

/** How the verification reads a column once it has this PostgreSQL type (see `ColumnKind`): by sum, by first and last value, by text length, or not by value. */
export function verificationKind(family: OracleFamily, pg: PgName): ColumnKind {
    if ((family === "number" || family === "float") && ["smallint", "integer", "bigint", "real", "double precision", "numeric"].includes(pg)) return "number";
    if (family === "string") {
        if (["varchar", "text"].includes(pg)) return "string";
        if (["smallint", "integer", "bigint", "numeric"].includes(pg)) return "number";
        return "other";
    }
    if (family === "clob" && pg === "text") return "string";
    if ((family === "date" || family === "timestamp") && (pg === "timestamp" || pg === "date")) return "date";
    return "other";
}

/** The type a person asked for, if this column may have it, or the reason it may not. */
export function resolvePgType(column: OracleColumn, requested: string): { type: string; kind: ColumnKind; parsed: ParsedPgType } | string {
    const family = oracleFamily(column);
    const parsed = parsePgType(requested);
    if (!parsed) return `"${requested}" is not a type this migration knows. For ${column.type} it can be ${allowedPgTypes(column).join(", ") || "none"}.`;
    if (!ALLOWED[family].includes(parsed.name)) return `${column.type} cannot become ${parsed.canonical} here. It can be ${allowedPgTypes(column).join(", ") || "none"}.`;
    return { type: parsed.canonical, kind: verificationKind(family, parsed.name), parsed };
}

const NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** A PostgreSQL name as written in the migration: lower case, letters, digits and underscores. */
export function resolveName(requested: string): string | undefined {
    const name = requested.trim().toLowerCase();
    return NAME_PATTERN.test(name) ? name : undefined;
}

/** Whether a default Oracle carried over still makes sense for the type the column now has. */
export function defaultFitsType(defaultValue: string, pg: ParsedPgType): boolean {
    if (/^-?\d+(\.\d+)?$/.test(defaultValue)) return ["smallint", "integer", "bigint", "real", "double precision", "numeric", "text"].includes(pg.name);
    if (/^'([^']|'')*'$/.test(defaultValue)) return ["varchar", "char", "text"].includes(pg.name) && (pg.length === undefined || defaultValue.length - 2 <= pg.length);
    if (/^CURRENT_TIMESTAMP$/i.test(defaultValue)) return ["timestamp", "timestamptz", "date"].includes(pg.name);
    return false;
}

// ---- applying what was asked for -----------------------------------------------------------------------------------------------------

/** One change, as the assistant states it. Names are Oracle's; the lookup ignores case. */
export type MigrationOperation =
    | { op: "rename_table"; table: string; newName: string }
    | { op: "rename_column"; table: string; column: string; newName: string }
    | { op: "set_column_type"; table: string; column: string; pgType: string }
    | { op: "drop_default"; table: string; column: string }
    | { op: "reset_column"; table: string; column: string }
    | { op: "reset_table"; table: string }
    | { op: "carry_object"; kind: "index" | "check"; name: string }
    | { op: "skip_object"; kind: "index" | "check"; name: string }
    | { op: "carry_all"; kind: "index" | "check" }
    | { op: "skip_all"; kind: "index" | "check" };

/** An index or CHECK constraint of the schema, as the plan lists it: what an operation on it is checked against. */
export interface ObjectOption {
    kind: "index" | "check";
    name: string;
    carriable: boolean;
    reason?: string;
}

export interface AppliedOperations {
    edits: MigrationEdits;
    /** What was done, in words. */
    applied: string[];
    /** What was refused, with the reason. */
    rejected: { operation: string; reason: string }[];
}

const describe = (operation: MigrationOperation): string => {
    switch (operation.op) {
        case "rename_table":
            return `rename table ${operation.table} to ${operation.newName}`;
        case "rename_column":
            return `rename ${operation.table}.${operation.column} to ${operation.newName}`;
        case "set_column_type":
            return `make ${operation.table}.${operation.column} ${operation.pgType}`;
        case "drop_default":
            return `drop the default of ${operation.table}.${operation.column}`;
        case "reset_column":
            return `undo the changes to ${operation.table}.${operation.column}`;
        case "reset_table":
            return `undo the new name of ${operation.table}`;
        case "carry_object":
            return `carry over the ${operation.kind === "index" ? "index" : "check constraint"} ${operation.name}`;
        case "skip_object":
            return `leave behind the ${operation.kind === "index" ? "index" : "check constraint"} ${operation.name}`;
        case "carry_all":
            return `carry over every ${operation.kind === "index" ? "index" : "check constraint"} that can be`;
        case "skip_all":
            return `leave behind every ${operation.kind === "index" ? "index" : "check constraint"}`;
    }
};

const clone = (edits: MigrationEdits): MigrationEdits => ({ tables: { ...(edits.tables ?? {}) }, columns: Object.fromEntries(Object.entries(edits.columns ?? {}).map(([key, value]) => [key, { ...value }])), objects: { ...(edits.objects ?? {}) } });
const prune = (edits: MigrationEdits): MigrationEdits => {
    const columns = Object.fromEntries(Object.entries(edits.columns ?? {}).filter(([, value]) => value.pgName !== undefined || value.pgType !== undefined || value.dropDefault === true));
    const tables = Object.fromEntries(Object.entries(edits.tables ?? {}).filter(([, value]) => value.pgName !== undefined));
    const objects = Object.fromEntries(Object.entries(edits.objects ?? {}).filter(([, value]) => value.carry === true));
    return { tables, columns, objects };
};

/** Applies each change in turn to a copy of `edits`; a change that has no rule, or names something that is not there, is refused and the rest still apply. */
export function applyOperations(tables: OracleTable[], current: MigrationEdits, operations: MigrationOperation[], objects: ObjectOption[] = []): AppliedOperations {
    const edits = clone(current);
    const applied: string[] = [];
    const rejected: AppliedOperations["rejected"] = [];

    const findTable = (name: string) => tables.find((table) => table.name.toLowerCase() === name.trim().toLowerCase());
    const finalTableName = (table: OracleTable) => edits.tables?.[table.name]?.pgName ?? (/[A-Z]/.test(table.name) && table.name === table.name.toUpperCase() ? table.name.toLowerCase() : table.name);
    const finalColumnName = (table: OracleTable, column: OracleColumn) => edits.columns?.[columnKey(table.name, column.name)]?.pgName ?? (/[A-Z]/.test(column.name) && column.name === column.name.toUpperCase() ? column.name.toLowerCase() : column.name);

    for (const operation of operations) {
        const label = describe(operation);
        const refuse = (reason: string) => rejected.push({ operation: label, reason });
        if (operation.op === "carry_object" || operation.op === "skip_object") {
            const object = objects.find((candidate) => candidate.kind === operation.kind && candidate.name.toLowerCase() === operation.name.trim().toLowerCase());
            if (!object) refuse(`there is no ${operation.kind === "index" ? "index" : "check constraint"} ${operation.name} in this schema`);
            else if (operation.op === "skip_object") {
                delete edits.objects![objectKey(object.kind, object.name)];
                applied.push(`leave behind the ${object.kind === "index" ? "index" : "check constraint"} ${object.name}`);
            } else if (!object.carriable) refuse(`it cannot be carried over: ${object.reason ?? "its meaning is not the same in PostgreSQL"}`);
            else {
                edits.objects![objectKey(object.kind, object.name)] = { carry: true };
                applied.push(`carry over the ${object.kind === "index" ? "index" : "check constraint"} ${object.name}`);
            }
            continue;
        }
        if (operation.op === "carry_all" || operation.op === "skip_all") {
            const ofKind = objects.filter((candidate) => candidate.kind === operation.kind);
            if (operation.op === "skip_all") {
                for (const object of ofKind) delete edits.objects![objectKey(object.kind, object.name)];
                applied.push(label);
            } else {
                const can = ofKind.filter((object) => object.carriable);
                for (const object of can) edits.objects![objectKey(object.kind, object.name)] = { carry: true };
                if (can.length > 0) applied.push(`${label} (${can.length})`);
                else refuse(`there is no ${operation.kind === "index" ? "index" : "check constraint"} that can be carried over`);
                for (const object of ofKind.filter((candidate) => !candidate.carriable)) rejected.push({ operation: `carry over ${object.kind === "index" ? "the index" : "the check constraint"} ${object.name}`, reason: `it cannot be carried over: ${object.reason ?? "its meaning is not the same in PostgreSQL"}` });
            }
            continue;
        }
        const table = findTable(operation.table);
        if (!table) {
            refuse(`there is no table ${operation.table}`);
            continue;
        }
        if (operation.op === "rename_table") {
            const name = resolveName(operation.newName);
            if (!name) refuse(`"${operation.newName}" is not a usable PostgreSQL name (lower-case letters, digits and underscores, starting with a letter or underscore)`);
            else if (tables.some((other) => other !== table && finalTableName(other) === name)) refuse(`another table is already called ${name}`);
            else {
                edits.tables![table.name] = { pgName: name };
                applied.push(label);
            }
            continue;
        }
        if (operation.op === "reset_table") {
            delete edits.tables![table.name];
            applied.push(label);
            continue;
        }
        const column = table.columns.find((candidate) => candidate.name.toLowerCase() === operation.column.trim().toLowerCase());
        if (!column) {
            refuse(`${table.name} has no column ${operation.column}`);
            continue;
        }
        const key = columnKey(table.name, column.name);
        const entry = edits.columns![key] ?? {};
        if (operation.op === "rename_column") {
            const name = resolveName(operation.newName);
            if (!name) refuse(`"${operation.newName}" is not a usable PostgreSQL name (lower-case letters, digits and underscores, starting with a letter or underscore)`);
            else if (table.columns.some((other) => other !== column && finalColumnName(table, other) === name)) refuse(`${table.name} already has a column called ${name}`);
            else {
                edits.columns![key] = { ...entry, pgName: name };
                applied.push(label);
            }
        } else if (operation.op === "set_column_type") {
            const resolved = resolvePgType(column, operation.pgType);
            if (typeof resolved === "string") refuse(resolved);
            else {
                edits.columns![key] = { ...entry, pgType: resolved.type };
                applied.push(`make ${table.name}.${column.name} ${resolved.type}`);
            }
        } else if (operation.op === "drop_default") {
            if (column.defaultValue === null) refuse(`${table.name}.${column.name} has no default`);
            else {
                edits.columns![key] = { ...entry, dropDefault: true };
                applied.push(label);
            }
        } else {
            delete edits.columns![key];
            applied.push(label);
        }
    }
    return { edits: prune(edits), applied, rejected };
}

// ---- checking the data a change would touch ----------------------------------------------------------------------------------------

export interface DataCheckQuery {
    /** What the query counts, in words: the values that would not survive. */
    description: string;
    sql: string;
}

const oracleQuote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const INTEGER_RANGE: Record<string, [string, string]> = { smallint: ["-32768", "32767"], integer: ["-2147483648", "2147483647"], bigint: ["-9223372036854775808", "9223372036854775807"] };

/**
 * The query on the Oracle data that counts the values a column's PostgreSQL type would change or lose: values with a time of day going to a
 * date, decimals or out-of-range numbers going to an integer type, text that is not a number going to a number, text longer than the new
 * length, numbers that need more digits than a floating-point type keeps, values written in another time zone. Undefined when the change
 * cannot lose anything (everything fits in text, a wider number, the same type).
 */
export function dataCheckFor(table: string, column: OracleColumn, pgType: string): DataCheckQuery | undefined {
    const family = oracleFamily(column);
    const pg = parsePgType(pgType);
    if (!pg) return undefined;
    const name = oracleQuote(column.name);
    const from = `FROM ${oracleQuote(table)}`;
    const count = (where: string) => `SELECT COUNT(*) ${from} WHERE ${where}`;
    const base = column.type.replace(/\(\d+\)/, "").toUpperCase();

    if ((family === "date" || family === "timestamp") && pg.name === "date") return { description: "values with a time of day, which a date does not keep", sql: count(`${name} <> TRUNC(${name})`) };
    if ((family === "number" || family === "float") && INTEGER_RANGE[pg.name]) {
        const [low, high] = INTEGER_RANGE[pg.name];
        return { description: `values with decimals, or outside ${low} to ${high}`, sql: count(`${name} <> TRUNC(${name}) OR ${name} < ${low} OR ${name} > ${high}`) };
    }
    if ((family === "number" || family === "float") && pg.name === "numeric" && pg.precision !== undefined) {
        return { description: `values with more than ${pg.scale} decimals or more than ${pg.precision - (pg.scale ?? 0)} whole digits`, sql: count(`${name} <> ROUND(${name}, ${pg.scale ?? 0}) OR ABS(${name}) >= POWER(10, ${pg.precision - (pg.scale ?? 0)})`) };
    }
    if ((family === "number" || (family === "float" && base === "FLOAT" && (column.precision ?? 126) > 53)) && (pg.name === "real" || pg.name === "double precision")) {
        const digits = pg.name === "real" ? 6 : 15;
        return { description: `values with more than ${digits} significant digits, which ${pg.name} rounds`, sql: count(`LENGTH(TRIM(LEADING '0' FROM REPLACE(REPLACE(TO_CHAR(ABS(${name}), 'TM9'), '.', ''), '-', ''))) > ${digits}`) };
    }
    if (family === "number" && pg.name === "boolean") return { description: "values other than 0 and 1", sql: count(`${name} NOT IN (0, 1)`) };
    if (family === "string" && pg.name === "boolean") return { description: "values other than Y, N, T, F, 1 and 0", sql: count(`UPPER(${name}) NOT IN ('Y', 'N', 'T', 'F', '1', '0')`) };
    if (family === "string" && INTEGER_RANGE[pg.name]) return { description: "text that is not a whole number", sql: count(`NOT REGEXP_LIKE(${name}, '^\\s*[+-]?[0-9]+\\s*$')`) };
    if (family === "string" && pg.name === "numeric") return { description: "text that is not a number", sql: count(`NOT REGEXP_LIKE(${name}, '^\\s*[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)\\s*$')`) };
    if (family === "string" && (pg.name === "varchar" || pg.name === "char") && pg.length !== undefined && pg.length < (column.charLength || column.dataLength || 0)) {
        return { description: `values longer than ${pg.length} characters`, sql: count(`LENGTH(${name}) > ${pg.length}`) };
    }
    if (base === "TIMESTAMP WITH TIME ZONE" && pg.name === "timestamptz") return { description: "values written in a time zone other than UTC, whose zone is not kept", sql: count(`EXTRACT(TIMEZONE_HOUR FROM ${name}) <> 0 OR EXTRACT(TIMEZONE_MINUTE FROM ${name}) <> 0`) };
    return undefined;
}
