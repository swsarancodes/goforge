import type { Catalog, CatalogTable } from "./catalog.js";

/**
 * Picks the tables a change request is about, from the live catalog, without a model: words of the request are matched
 * against table, schema and column names (weighted by how rare the word is in this database), then the foreign-key
 * neighbours of the best matches are added. It matches names, not meanings: a request that calls `clients` "customers"
 * finds nothing, and the person is shown the chosen scope and can change it.
 */

export interface ScopeOptions {
    /** Hard cap on the scope. Everything sent to a model comes from these tables. */
    maxTables: number;
    /** How many name/column matches are kept before foreign-key neighbours are added. */
    maxSeeds: number;
    /** Tables that reference a matched table, kept per matched table (a hub like `users` can have hundreds). */
    childrenPerSeed: number;
}

export const DEFAULT_SCOPE_OPTIONS: ScopeOptions = { maxTables: 40, maxSeeds: 12, childrenPerSeed: 4 };

export type ScopeReason =
    | { kind: "name"; words: string[] }
    | { kind: "column"; columns: string[] }
    /** The table is referenced by `from`'s foreign key. */
    | { kind: "referenced-by"; from: string }
    /** The table has a foreign key to `from`. */
    | { kind: "references"; from: string };

export interface ScopedTable {
    qualified: string;
    origin: "match" | "neighbour";
    reasons: ScopeReason[];
}

export interface ScopeResult {
    tables: ScopedTable[];
    totalTables: number;
    /** How many tables matched the request's words well enough to be kept as matches, before the cap. */
    matched: number;
    /** More tables matched than were kept. */
    truncated: boolean;
}

// ---- words ----------------------------------------------------------------------------------------------------------------

/** Lower-case words of a name or sentence: splits on punctuation, `snake_case`, `camelCase` and digits. */
export function tokenize(text: string): string[] {
    const spaced = text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2");
    return spaced
        .toLowerCase()
        .split(/[^\p{L}]+/u)
        .filter((word) => word.length >= 2);
}

/** Plural to singular for English-looking words (`orders` -> `order`, `categories` -> `category`, `addresses` -> `address`). */
export function singular(word: string): string {
    if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
    if (word.length > 4 && /(ss|x|z|ch|sh|s)es$/.test(word)) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
    return word;
}

const words = (text: string): string[] => tokenize(text).map(singular);

/** True when `a` and `b` differ by at most one insertion, deletion, substitution or swap of neighbouring letters. */
export function withinOneEdit(a: string, b: string): boolean {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) {
        if (a.slice(i + 1) === b.slice(i + 1)) return true; // one substitution
        return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // one swap
    }
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

// ---- the index ------------------------------------------------------------------------------------------------------------

interface IndexedTable {
    table: CatalogTable;
    nameWords: string[];
    schemaWords: string[];
    /** The name words run together, to match `order items` against `orderitems`. */
    compact: string;
    columns: { name: string; words: string[] }[];
    references: string[];
}

export interface SearchIndex {
    tables: IndexedTable[];
    byName: Map<string, IndexedTable>;
    /** Tables that have a foreign key to the key's table. */
    referencedBy: Map<string, string[]>;
    nameFrequency: Map<string, number>;
    columnFrequency: Map<string, number>;
    schemaFrequency: Map<string, number>;
    /** Every word that appears in some table, schema or column name (what a misspelled word can be matched to). */
    vocabulary: Set<string>;
}

const bump = (counts: Map<string, number>, wordsToCount: Iterable<string>) => {
    for (const word of new Set(wordsToCount)) counts.set(word, (counts.get(word) ?? 0) + 1);
};

export function buildSearchIndex(catalog: Catalog): SearchIndex {
    const nameFrequency = new Map<string, number>();
    const columnFrequency = new Map<string, number>();
    const schemaFrequency = new Map<string, number>();
    const vocabulary = new Set<string>();
    const referencedBy = new Map<string, string[]>();

    const tables = catalog.tables.map<IndexedTable>((table) => {
        const nameWords = words(table.name);
        const schemaWords = words(table.schema);
        const columns = table.columns.map((column) => ({ name: column.name, words: words(column.name) }));
        bump(nameFrequency, nameWords);
        bump(schemaFrequency, schemaWords);
        bump(columnFrequency, columns.flatMap((column) => column.words));
        for (const word of [...nameWords, ...schemaWords, ...columns.flatMap((column) => column.words)]) vocabulary.add(word);

        const references = [...new Set(table.foreignKeys.map((fk) => `${fk.refSchema}.${fk.refTable}`))].filter((target) => target !== table.qualified);
        for (const target of references) referencedBy.set(target, [...(referencedBy.get(target) ?? []), table.qualified]);
        return { table, nameWords, schemaWords, compact: nameWords.join(""), columns, references };
    });

    return { tables, byName: new Map(tables.map((entry) => [entry.table.qualified, entry])), referencedBy, nameFrequency, columnFrequency, schemaFrequency, vocabulary };
}

/** BM25-style inverse document frequency: near zero for a word every table has, large for a word one table has. */
const idf = (total: number, frequency: number) => Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5));

const FUZZY_WEIGHT = 0.7;
const COLUMN_WEIGHT = 0.4;
const SCHEMA_WEIGHT = 0.5;
const FULL_NAME_BOOST = 2;
const PARTIAL_NAME_PENALTY = 0.6;
const EXACT_PHRASE_BONUS = 8;

interface Scored {
    entry: IndexedTable;
    score: number;
    nameWords: string[];
    columns: string[];
}

/** Request words that exist in the database's vocabulary: exactly (weight 1) or one typo away (a lower weight). */
function termsOf(index: SearchIndex, request: string): Map<string, number> {
    const terms = new Map<string, number>();
    for (const word of new Set(words(request))) {
        if (index.vocabulary.has(word)) {
            terms.set(word, 1);
            continue;
        }
        if (word.length < 5) continue;
        for (const candidate of index.vocabulary) {
            if (candidate.length >= 5 && withinOneEdit(word, candidate)) terms.set(candidate, Math.max(terms.get(candidate) ?? 0, FUZZY_WEIGHT));
        }
    }
    return terms;
}

function score(index: SearchIndex, entry: IndexedTable, terms: Map<string, number>, requestWords: string[], lowered: string): Scored | undefined {
    const total = index.tables.length;
    const matchedName = entry.nameWords.filter((word) => terms.has(word));
    let nameScore = matchedName.reduce((sum, word) => sum + idf(total, index.nameFrequency.get(word) ?? 1) * (terms.get(word) ?? 0), 0);

    if (matchedName.length > 0) {
        const coverage = new Set(matchedName).size / new Set(entry.nameWords).size;
        if (coverage === 1) nameScore *= FULL_NAME_BOOST;
        else if (entry.nameWords.length > 1 && coverage < 0.5) nameScore *= PARTIAL_NAME_PENALTY;
        // `billing` in `billing.invoices` only counts together with a word of the table's own name; otherwise it would pull in the whole schema.
        for (const word of entry.schemaWords) if (terms.has(word)) nameScore += idf(total, index.schemaFrequency.get(word) ?? 1) * (terms.get(word) ?? 0) * SCHEMA_WEIGHT;
    }

    // `billing.invoices`, `invoices`, or `invoice items` for `invoiceitems`, written out as in the name.
    let phrase = false;
    if (entry.compact.length >= 4) {
        for (let size = 1; size <= 3 && !phrase; size++) {
            for (let start = 0; start + size <= requestWords.length; start++) {
                if (requestWords.slice(start, start + size).join("") === entry.compact) {
                    phrase = true;
                    break;
                }
            }
        }
    }
    if (!phrase && lowered.includes(entry.table.qualified.toLowerCase())) phrase = true;
    if (phrase) nameScore += EXACT_PHRASE_BONUS;

    // A column counts only when every word of its name is in the request, and the best two are summed (wide tables don't win by size).
    const columnScores = entry.columns
        .filter((column) => column.words.length > 0 && column.words.every((word) => terms.has(word)))
        .map((column) => ({ name: column.name, value: column.words.reduce((sum, word) => sum + idf(total, index.columnFrequency.get(word) ?? 1) * (terms.get(word) ?? 0), 0) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 2);
    const columnScore = columnScores.reduce((sum, column) => sum + column.value, 0) * COLUMN_WEIGHT;

    const result = nameScore + columnScore;
    if (result <= 0) return undefined;
    return { entry, score: result, nameWords: phrase && matchedName.length === 0 ? entry.nameWords : matchedName, columns: columnScores.map((column) => column.name) };
}

const SEED_RELATIVE_THRESHOLD = 0.35;

export function selectScope(index: SearchIndex, request: string, options: Partial<ScopeOptions> = {}): ScopeResult {
    const { maxTables, maxSeeds, childrenPerSeed } = { ...DEFAULT_SCOPE_OPTIONS, ...options };
    const terms = termsOf(index, request);
    const requestWords = words(request);
    const lowered = request.toLowerCase();

    const scored = index.tables
        .map((entry) => score(index, entry, terms, requestWords, lowered))
        .filter((item): item is Scored => item !== undefined)
        .sort((a, b) => b.score - a.score || a.entry.table.qualified.localeCompare(b.entry.table.qualified));

    const top = scored[0]?.score ?? 0;
    const matches = scored.filter((item) => item.score >= top * SEED_RELATIVE_THRESHOLD);
    const seeds = matches.slice(0, Math.min(maxSeeds, maxTables));

    const chosen = new Map<string, ScopedTable>();
    for (const seed of seeds) {
        const reasons: ScopeReason[] = [];
        if (seed.nameWords.length > 0) reasons.push({ kind: "name", words: seed.nameWords });
        if (seed.columns.length > 0) reasons.push({ kind: "column", columns: seed.columns });
        chosen.set(seed.entry.table.qualified, { qualified: seed.entry.table.qualified, origin: "match", reasons });
    }

    const scoreOf = new Map(scored.map((item) => [item.entry.table.qualified, item.score]));
    const add = (qualified: string, reason: ScopeReason): boolean => {
        const existing = chosen.get(qualified);
        if (existing) {
            if (existing.origin === "neighbour") existing.reasons.push(reason);
            return false;
        }
        if (chosen.size >= maxTables || !index.byName.has(qualified)) return false;
        chosen.set(qualified, { qualified, origin: "neighbour", reasons: [reason] });
        return true;
    };

    for (const seed of seeds) {
        const name = seed.entry.table.qualified;
        for (const parent of seed.entry.references) add(parent, { kind: "referenced-by", from: name });
        const children = (index.referencedBy.get(name) ?? [])
            .filter((child) => !chosen.has(child) || chosen.get(child)?.origin === "neighbour")
            .sort((a, b) => (scoreOf.get(b) ?? 0) - (scoreOf.get(a) ?? 0) || (index.byName.get(b)?.table.estimatedRows ?? 0) - (index.byName.get(a)?.table.estimatedRows ?? 0) || a.localeCompare(b));
        let kept = 0;
        for (const child of children) {
            if (kept >= childrenPerSeed) break;
            if (add(child, { kind: "references", from: name })) kept++;
        }
    }

    return { tables: [...chosen.values()], totalTables: index.tables.length, matched: matches.length, truncated: matches.length > seeds.length };
}
