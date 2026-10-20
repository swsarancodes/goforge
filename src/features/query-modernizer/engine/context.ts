import type { LegacyDialect, SchemaContext } from "../types";
import { AppliedRule, RULES, RuleId, Trap, UnconvertedItem } from "./rules";
import { Node, isGroup, textOf } from "./tokens";

const MAX_EXAMPLES = 3;

/** What the engine knows about the user's tables (names and types only, never data). */
export class SchemaIndex {
    private readonly byColumn = new Map<string, { table: string; type: string; nullable: boolean | undefined }[]>();
    readonly tables: Set<string>;

    constructor(readonly context?: SchemaContext) {
        this.tables = new Set((context?.tables ?? []).map((table) => table.name.toLowerCase()));
        for (const table of context?.tables ?? []) {
            for (const column of table.columns) {
                const key = column.name.toLowerCase();
                const list = this.byColumn.get(key) ?? [];
                list.push({ table: table.name, type: column.type.toLowerCase(), nullable: column.nullable });
                this.byColumn.set(key, list);
            }
        }
    }

    get isEmpty(): boolean {
        return this.tables.size === 0;
    }

    hasTable(name: string): boolean {
        return this.tables.has(name.toLowerCase());
    }

    /** The type of a column, if every table that has a column of that name agrees on it. */
    typeOf(column: string, table?: string): string | undefined {
        const matches = (this.byColumn.get(column.toLowerCase()) ?? []).filter((entry) => !table || entry.table.toLowerCase() === table.toLowerCase());
        if (matches.length === 0) return undefined;
        const first = matches[0].type;
        return matches.every((entry) => entry.type === first) ? first : undefined;
    }

    isTextColumn(column: string, table?: string): boolean {
        const type = this.typeOf(column, table);
        return type !== undefined && /char|text|clob|string|uuid/.test(type);
    }

    isNumericColumn(column: string, table?: string): boolean {
        const type = this.typeOf(column, table);
        return type !== undefined && /int|numeric|decimal|number|float|double|real|serial|money/.test(type);
    }

    isDateColumn(column: string, table?: string): boolean {
        const type = this.typeOf(column, table);
        return type !== undefined && /date|time/.test(type);
    }

    primaryKey(table: string): string[] | undefined {
        const found = this.context?.tables.find((candidate) => candidate.name.toLowerCase() === table.toLowerCase());
        const key = found?.columns.filter((column) => column.isPrimary).map((column) => column.name);
        return key && key.length > 0 ? key : undefined;
    }

    uniqueColumns(table: string): string[] | undefined {
        const found = this.context?.tables.find((candidate) => candidate.name.toLowerCase() === table.toLowerCase());
        const key = found?.columns.filter((column) => column.isUnique).map((column) => column.name);
        return key && key.length > 0 ? key : undefined;
    }
}

/** Collects what happens while one statement is converted. */
export class Ctx {
    private readonly appliedRules = new Map<RuleId, { count: number; examples: { before: string; after: string }[] }>();
    readonly unconverted: UnconvertedItem[] = [];
    private readonly trapMap = new Map<string, Trap>();
    readonly schema: SchemaIndex;

    constructor(
        readonly dialect: LegacyDialect,
        schema?: SchemaContext,
    ) {
        this.schema = new SchemaIndex(schema);
    }

    /** Records that a rule fired. `before` and `after` are kept (a few of them) so the UI can show what changed. */
    apply(id: RuleId, before?: Node[] | string, after?: Node[] | string) {
        const entry = this.appliedRules.get(id) ?? { count: 0, examples: [] };
        entry.count += 1;
        if (before !== undefined && after !== undefined && entry.examples.length < MAX_EXAMPLES) {
            const b = typeof before === "string" ? before : textOf(before);
            const a = typeof after === "string" ? after : textOf(after);
            if (b !== a && b.length < 400 && a.length < 400) entry.examples.push({ before: b, after: a });
        }
        this.appliedRules.set(id, entry);
    }

    unsupported(construct: string | Node[], reason: string, hint?: string) {
        const text = typeof construct === "string" ? construct : textOf(construct);
        if (this.unconverted.some((item) => item.construct === text && item.reason === reason)) return;
        this.unconverted.push({ construct: text.length > 160 ? `${text.slice(0, 157)}...` : text, reason, hint });
    }

    trap(trap: Trap) {
        if (!this.trapMap.has(trap.id)) this.trapMap.set(trap.id, trap);
    }

    get traps(): Trap[] {
        return [...this.trapMap.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "changes-results" ? -1 : 1));
    }

    get applied(): AppliedRule[] {
        return [...this.appliedRules.entries()].map(([id, entry]) => ({ id, ...RULES[id], count: entry.count, examples: entry.examples }));
    }
}

/** Is this node sequence a single operand (so it can be used in an expression without extra brackets)? */
export function isAtom(nodes: Node[]): boolean {
    if (nodes.length === 1) return true;
    // identifier paths a.b.c and function calls f(...)
    if (nodes.length === 2 && isGroup(nodes[1]) && !isGroup(nodes[0])) return true;
    return nodes.every((node, index) => (index % 2 === 0 ? !isGroup(node) && (node as { kind: string }).kind !== "op" : !isGroup(node) && (node as { text: string }).text === "."));
}
