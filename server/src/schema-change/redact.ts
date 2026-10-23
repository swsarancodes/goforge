/**
 * Name redaction: before anything leaves the server, schema, table, column, index, constraint, view and custom type names are
 * replaced by placeholders (`t_3`, `c_17`), and the model's answer is translated back. Types, sizes, counts and structure are
 * left alone, because they are what the model needs. The request and the audit log show the redacted text, i.e. exactly what left.
 */

export type NameKind = "schema" | "table" | "column" | "index" | "constraint" | "view" | "type";

const PREFIX: Record<NameKind, string> = { schema: "s", table: "t", column: "c", index: "i", constraint: "k", view: "v", type: "y" };
const KIND_ORDER: NameKind[] = ["schema", "table", "view", "type", "column", "index", "constraint"];

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const IDENT_BEFORE = String.raw`(?<![\p{L}\p{N}_$])`;
const IDENT_AFTER = String.raw`(?![\p{L}\p{N}_$])`;

export interface NameEntry {
    name: string;
    kind: NameKind;
}

export class Redactor {
    private readonly forward = new Map<string, string>();
    private readonly backward = new Map<string, string>();
    private readonly kinds = new Map<string, NameKind>();
    private proseRegex: RegExp | undefined;
    private typeRegex: RegExp | undefined;
    // A placeholder is also found inside a longer name the model made up from it (`idx_t_3_c_5`), where an underscore touches it.
    private readonly unmaskRegex = new RegExp(`(?<![\\p{L}\\p{N}])([stcikvy]_\\d+)(?:es|s)?(?![\\p{L}\\p{N}])`, "gu");

    constructor(entries: NameEntry[]) {
        const taken = new Set(entries.map((entry) => entry.name.toLowerCase()));
        const counters = new Map<NameKind, number>();
        const sorted = [...entries].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
        for (const { name, kind } of sorted) {
            if (this.forward.has(name)) continue;
            let n = counters.get(kind) ?? 0;
            let placeholder: string;
            do placeholder = `${PREFIX[kind]}_${++n}`;
            while (taken.has(placeholder));
            counters.set(kind, n);
            this.forward.set(name, placeholder);
            this.backward.set(placeholder, name);
            this.kinds.set(name, kind);
        }
    }

    get size(): number {
        return this.forward.size;
    }

    /** The placeholder for an identifier, or the identifier itself if it is not a known name. */
    id(name: string): string {
        return this.forward.get(name) ?? name;
    }

    /** Placeholders for the custom type names in a type such as `public.mood[]`; built-in names are untouched. */
    type(text: string): string {
        this.typeRegex ??= this.regexFor((name) => this.kinds.get(name) === "type" || this.kinds.get(name) === "schema");
        return this.typeRegex ? text.replace(this.typeRegex, (match) => this.forward.get(match) ?? this.lookupInsensitive(match)) : text;
    }

    private regexFor(include: (name: string) => boolean): RegExp | undefined {
        const names = [...this.forward.keys()].filter(include).sort((a, b) => b.length - a.length);
        return names.length === 0 ? undefined : new RegExp(`${IDENT_BEFORE}(${names.map(escapeRegex).join("|")})${IDENT_AFTER}`, "giu");
    }

    private lookupInsensitive(match: string): string {
        const lower = match.toLowerCase();
        for (const [name, placeholder] of this.forward) if (name.toLowerCase() === lower) return placeholder;
        return match;
    }

    /** Free text (the person's request): every known name of three letters or more, whole words, plural forms too. */
    mask(text: string): string {
        this.proseRegex ??= (() => {
            const names = [...this.forward.keys()].filter((name) => name.length >= 3).sort((a, b) => b.length - a.length);
            return names.length === 0 ? undefined : new RegExp(`${IDENT_BEFORE}(${names.map(escapeRegex).join("|")})(es|s)?${IDENT_AFTER}`, "giu");
        })();
        return this.proseRegex ? text.replace(this.proseRegex, (_, name: string, suffix?: string) => `${this.forward.get(name) ?? this.lookupInsensitive(name)}${suffix ?? ""}`) : text;
    }

    unmask(text: string): string {
        return text.replace(this.unmaskRegex, (match, placeholder: string) => {
            const real = this.backward.get(placeholder);
            return real === undefined ? match : `${real}${match.slice(placeholder.length)}`;
        });
    }

    unmaskDeep<T>(value: T): T {
        if (typeof value === "string") return this.unmask(value) as T;
        if (Array.isArray(value)) return value.map((item) => this.unmaskDeep(item)) as T;
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.unmaskDeep(item)])) as T;
        return value;
    }

    /** Masks every string in a structure: a string that is exactly a name (or `schema.name`) becomes its placeholder at any length, other text is masked as prose. */
    maskDeep<T>(value: T): T {
        if (typeof value === "string") {
            const exact = this.forward.get(value);
            if (exact !== undefined) return exact as T;
            const parts = value.split(".");
            if (parts.length > 1 && parts.every((part) => this.forward.has(part))) return parts.map((part) => this.forward.get(part)).join(".") as T;
            return this.mask(value) as T;
        }
        if (Array.isArray(value)) return value.map((item) => this.maskDeep(item)) as T;
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.maskDeep(item)])) as T;
        return value;
    }
}

/** Words that are part of SQL or of type names: a name equal to one of them is not a leak when the word itself appears. */
const SQL_WORDS = new Set(
    "integer bigint smallint text varchar character varying numeric decimal boolean date time timestamp timestamptz interval uuid json jsonb bytea real double precision with without zone serial bigserial btree hash gin gist brin identity always default null not true false primary key unique foreign references check index table column view type array bit money inet cidr xml oid name char int int2 int4 int8 float float4 float8 bool bpchar tsvector tsquery point line box circle path polygon".split(" "),
);

/** Names of three letters or more that still appear, whole word and any case, in text that should have been redacted. A name that is also a SQL word is not reported. */
export function findLeaks(text: string, names: string[]): string[] {
    const leaks: string[] = [];
    for (const name of new Set(names)) {
        if (name.length < 3 || SQL_WORDS.has(name.toLowerCase())) continue;
        if (new RegExp(`${IDENT_BEFORE}${escapeRegex(name)}${IDENT_AFTER}`, "iu").test(text)) leaks.push(name);
    }
    return leaks;
}

/** Every string value in a structure (not its keys, which are the request's own vocabulary), for scanning what is about to be sent. */
export function stringValues(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(stringValues);
    if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
    return [];
}
