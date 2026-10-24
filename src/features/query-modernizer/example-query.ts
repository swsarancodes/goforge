import type { LegacyDialect, SchemaContext, SchemaContextTable } from "./types";

/**
 * The grey example in the empty editor. It is written fresh from the tables on the user's canvas, in the style of the
 * chosen source database, and uses the old idioms (outer join marker, NVL, TOP, backticks, ...) that the converter
 * handles. With no tables there is no example: nothing here is a fixed query.
 */
export function buildExampleQuery(input: { dialect: LegacyDialect; schema?: SchemaContext }): string | undefined {
    const { dialect, schema } = input;
    if (!schema || schema.tables.length === 0) return undefined;

    const { main, parent, link } = pickTables(schema);
    const column = {
        key: main.columns.find((c) => c.isPrimary) ?? main.columns[0],
        numeric: pick(main, (type) => NUMERIC.test(type), true),
        text: pick(main, (type) => TEXT.test(type), true, true),
        date: pick(main, (type) => DATE.test(type), false),
    };
    if (!column.key) return undefined;
    const parentLabel = parent ? (parent.columns.find((c) => TEXT.test(c.type.toLowerCase()) && !c.isPrimary) ?? parent.columns.find((c) => !c.isPrimary) ?? parent.columns[0]) : undefined;

    const q = (name: string) => quote(dialect, name);
    const a = (name: string) => `a.${q(name)}`;
    const b = (name: string) => `b.${q(name)}`;
    const table = (name: string) => (dialect === "mssql" ? `[dbo].${q(name)}` : q(name));
    const nvl = { oracle: "NVL", mssql: "ISNULL", mysql: "IFNULL", db2: "VALUE" }[dialect];
    const now = { oracle: "SYSDATE", mssql: "GETDATE()", mysql: "NOW()", db2: "CURRENT TIMESTAMP" }[dialect];

    const items: string[] = [a(column.key.name)];
    if (column.numeric) items.push(`${nvl}(${a(column.numeric.name)}, 0) AS ${q(column.numeric.name)}`);
    // DECODE with a NULL search value needs no invented codes, and shows the one way it differs from CASE
    if (column.text && (dialect === "oracle" || dialect === "db2")) items.push(`DECODE(${a(column.text.name)}, NULL, 'unknown', ${a(column.text.name)}) AS ${q(column.text.name)}`);
    if (parent && parentLabel) items.push(b(parentLabel.name));

    const lines: string[] = [];
    const where: string[] = [];
    if (column.date) where.push(`${a(column.date.name)} < ${now}`);

    if (dialect === "oracle") {
        lines.push(`SELECT ${items.join(",\n       ")}`);
        lines.push(parent && link ? `FROM ${table(main.name)} a, ${table(parent.name)} b` : `FROM ${table(main.name)} a`);
        if (parent && link) where.unshift(`${a(link.fromColumn)} = ${b(link.toColumn)}(+)`);
        where.push("ROWNUM <= 10");
        lines.push(`WHERE ${where.join("\n  AND ")}`);
        return lines.join("\n");
    }

    const join = parent && link ? `LEFT JOIN ${table(parent.name)} b ON ${a(link.fromColumn)} = ${b(link.toColumn)}` : "";
    const from = `FROM ${table(main.name)} a${dialect === "mssql" ? " WITH (NOLOCK)" : ""}${join ? `\n${join}` : ""}`;
    const order = `ORDER BY ${a(column.key.name)}`;
    const whereClause = where.length > 0 ? `WHERE ${where.join("\n  AND ")}` : "";

    if (dialect === "mssql") return [`SELECT TOP 10 ${items.join(",\n       ")}`, from, whereClause, order].filter(Boolean).join("\n");
    if (dialect === "mysql") return [`SELECT ${items.join(",\n       ")}`, from, whereClause, order, "LIMIT 0, 10"].filter(Boolean).join("\n");
    return [`SELECT ${items.join(",\n       ")}`, from, whereClause, order, "FETCH FIRST 10 ROWS ONLY", "WITH UR"].filter(Boolean).join("\n");
}

const NUMERIC = /int|numeric|decimal|number|float|double|real|money|serial/;
const TEXT = /char|text|string|clob|citext/;
const DATE = /date|time/;

/** A column of the table with a matching type, preferring nullable ones that aren't the key. */
function pick(table: SchemaContextTable, matches: (type: string) => boolean, preferNullable: boolean, allowKey = false) {
    const candidates = table.columns.filter((c) => matches(c.type.toLowerCase()) && (allowKey || !c.isPrimary));
    const notForeign = candidates.filter((c) => !/_id$|^id$/i.test(c.name));
    const pool = notForeign.length > 0 ? notForeign : candidates;
    return (preferNullable ? pool.find((c) => c.nullable !== false) : undefined) ?? pool[0];
}

function pickTables(schema: SchemaContext) {
    const known = new Set(schema.tables.map((t) => t.name));
    const links = (schema.relationships ?? [])
        .filter((r) => known.has(r.fromTable) && known.has(r.toTable) && r.fromTable !== r.toTable)
        .sort((x, y) => x.fromTable.localeCompare(y.fromTable) || x.fromColumn.localeCompare(y.fromColumn));
    if (links.length > 0) {
        const link = links[0];
        return { main: schema.tables.find((t) => t.name === link.fromTable)!, parent: schema.tables.find((t) => t.name === link.toTable)!, link };
    }
    const main = [...schema.tables].sort((x, y) => y.columns.length - x.columns.length || x.name.localeCompare(y.name))[0];
    return { main, parent: undefined, link: undefined };
}

const RESERVED = new Set(["date", "order", "group", "user", "level", "number", "comment", "size", "mode", "start", "end", "file", "index", "select", "table", "check", "uid", "rowid", "row", "session", "public", "option", "audit"]);

function quote(dialect: LegacyDialect, name: string): string {
    const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
    if (dialect === "mssql") return `[${name}]`;
    if (dialect === "mysql") return `\`${name}\``;
    return plain && !RESERVED.has(name.toLowerCase()) ? name : `"${name.replace(/"/g, '""')}"`;
}
