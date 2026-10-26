/**
 * Bind variables in a legacy query. A reference result belongs to particular values: a query that still says `:cutoff` cannot be run
 * against data, and a converter that guesses a value (the rule engine's validation copy uses NULL) is not measuring the query the reference
 * result describes. So a case declares the values it was produced with (case.json "bindValues"), and they are written into the legacy
 * query as literals before anything reads it. The rule engine, the static checks and the model all see the same query the reference
 * result belongs to. A bind variable the case does not declare is left alone and sends the query to a human.
 */

export type BindValue = { type: "date" | "number" | "string"; value: string };
export type BindValues = Record<string, BindValue>;

/** The characters of a bind name, as the rule engine's tokenizer reads them. */
const NAME_PART = /[A-Za-z0-9_$#\u0080-\uffff]/;
const WORD_START = /[A-Za-z_\u0080-\uffff]/;

const isCalendarDate = (text: string) => {
    const date = new Date(`${text}T00:00:00Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
};

/** Reads "bindValues" from case.json: `{ "cutoff": { "type": "date", "value": "2026-01-01" } }`. Names are written without the colon. */
export function parseBindValues(raw: unknown, fail: (message: string) => never): BindValues {
    if (raw === undefined) return {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail(`"bindValues" must be an object of bind name to { type, value }`);
    const values: BindValues = {};
    const names = new Set<string>();
    for (const [name, entry] of Object.entries(raw)) {
        if (!/^[A-Za-z0-9_$#]+$/.test(name)) fail(`bindValues["${name}"]: a bind name is letters, digits, _, $ or #, written without the colon`);
        // Oracle does not tell :Cutoff from :cutoff
        if (names.has(name.toLowerCase())) fail(`bindValues.${name}: declared twice (bind names are not case-sensitive)`);
        names.add(name.toLowerCase());
        const { type, value } = (entry ?? {}) as { type?: unknown; value?: unknown };
        if (type === "date") {
            if (typeof value !== "string" || !isCalendarDate(value)) fail(`bindValues.${name}: a date is written YYYY-MM-DD and must exist`);
            values[name] = { type, value: value as string };
        } else if (type === "number") {
            const text = typeof value === "number" ? String(value) : value;
            if (typeof text !== "string" || !/^-?\d+(\.\d+)?$/.test(text)) fail(`bindValues.${name}: a number is plain digits with an optional sign and decimal point`);
            values[name] = { type, value: text as string };
        } else if (type === "string") {
            if (typeof value !== "string") fail(`bindValues.${name}: a string value must be a string`);
            values[name] = { type, value: value as string };
        } else fail(`bindValues.${name}: type must be date, number or string`);
    }
    return values;
}

/** The value as the legacy (Oracle) query would have it written inline. */
export function oracleLiteral({ type, value }: BindValue): string {
    if (type === "date") return `TO_DATE('${value}', 'YYYY-MM-DD')`;
    if (type === "number") return value;
    return `'${value.replace(/'/g, "''")}'`;
}

const ALTERNATIVE_QUOTE_CLOSE: Record<string, string> = { "[": "]", "(": ")", "{": "}", "<": ">" };

/**
 * Writes the declared values into the query in place of their `:name`. Everything else is copied exactly as it was: a `:name` inside a
 * string, a quoted name or a comment is not a bind variable, and `::` and `:=` are not the start of one.
 * `unused` lists declared names the query never mentions (a stale declaration would mislead whoever reads the case).
 */
export function substituteBinds(sql: string, values: BindValues): { sql: string; unused: string[] } {
    const byName = new Map(Object.entries(values).map(([name, value]) => [name.toLowerCase(), { name, value }]));
    const seen = new Set<string>();
    let out = "";
    let index = 0;
    const copyTo = (end: number) => {
        out += sql.slice(index, end);
        index = end;
    };
    const quotedEnd = (from: number, quote: string) => {
        let cursor = from + 1;
        while (cursor < sql.length) {
            if (sql[cursor] === quote && sql[cursor + 1] === quote) cursor += 2;
            else if (sql[cursor] === quote) return cursor + 1;
            else cursor++;
        }
        return sql.length;
    };

    while (index < sql.length) {
        const character = sql[index];
        const next = sql[index + 1] ?? "";
        if (character === "-" && next === "-") {
            const end = sql.indexOf("\n", index);
            copyTo(end === -1 ? sql.length : end);
        } else if (character === "/" && next === "*") {
            const end = sql.indexOf("*/", index + 2);
            copyTo(end === -1 ? sql.length : end + 2);
        } else if (character === "'") copyTo(quotedEnd(index, "'"));
        else if (character === '"') copyTo(quotedEnd(index, '"'));
        else if (WORD_START.test(character)) {
            let end = index + 1;
            while (end < sql.length && NAME_PART.test(sql[end])) end++;
            const close = ALTERNATIVE_QUOTE_CLOSE[sql[end + 1] ?? ""];
            if (/^[qQ]$/.test(sql.slice(index, end)) && sql[end] === "'" && close) {
                const closing = sql.indexOf(`${close}'`, end + 2);
                copyTo(closing === -1 ? sql.length : closing + 2);
            } else copyTo(end);
        } else if (character === ":" && (next === ":" || next === "=")) copyTo(index + 2);
        else if (character === ":" && NAME_PART.test(next)) {
            let end = index + 2;
            while (end < sql.length && NAME_PART.test(sql[end])) end++;
            const name = sql.slice(index + 1, end).toLowerCase();
            const declared = byName.get(name);
            if (declared) {
                seen.add(name);
                out += oracleLiteral(declared.value);
                index = end;
            } else copyTo(end);
        } else copyTo(index + 1);
    }
    return { sql: out, unused: [...byName].filter(([name]) => !seen.has(name)).map(([, declared]) => declared.name) };
}
