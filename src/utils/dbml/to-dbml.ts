import { DatabaseDialect } from "@/lib/database";
import { DataTypes, ForeignKeyActions, Modifiers, TimeDefaultValues } from "@/lib/field";
import { Cardinality, RelationshipType } from "@/lib/schemas/relationship-schema";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import type { FieldType } from "@/lib/schemas/field-schema";
import type { TableType } from "@/lib/schemas/table-schema";
import { DBML_DATABASE_TYPE, DbmlWarning } from "./dbml-shared";

export interface DbmlExport {
    dbml: string;
    warnings: DbmlWarning[];
}

const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const identifier = (name: string): string =>
    BARE_IDENTIFIER.test(name) ? name : `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Single-quoted DBML string; multi-line text uses triple quotes. */
const quote = (value: string): string => {
    if (value.includes("\n")) {
        return `'''\n${value.replace(/\\/g, "\\\\").replace(/'''/g, "\\'''")}'''`;
    }
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
};

const tableReference = (table: Pick<TableType, "name" | "namespace">): string =>
    table.namespace ? `${identifier(table.namespace)}.${identifier(table.name)}` : identifier(table.name);

const parseValues = (raw: string | null | undefined): string[] => {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
        return [];
    }
};

const modifiersOf = (field: FieldType): string[] => {
    const raw = field.type?.modifiers;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return [];
    }
};

/** SQL expressions DBML users write for "a random uuid", per dialect. */
const RANDOM_UUID_EXPRESSION: Partial<Record<DatabaseDialect, string>> = {
    [DatabaseDialect.POSTGRES]: "gen_random_uuid()",
    [DatabaseDialect.MYSQL]: "(uuid())",
    [DatabaseDialect.MARIADB]: "(uuid())",
    [DatabaseDialect.MSSQL]: "newid()",
};

const DBML_ACTIONS: Record<string, string> = {
    [ForeignKeyActions.CASCADE]: "cascade",
    [ForeignKeyActions.RESTRICT]: "restrict",
    [ForeignKeyActions.SET_NULL]: "set null",
    [ForeignKeyActions.SET_DEFAULT]: "set default",
};

/**
 * Which side of a relationship is the referenced (parent) table. A GoForge relationship
 * stores the parent as `source` and the foreign-key holder as `target`, except for
 * `many_to_one`, which is stored the other way round.
 */
const orientRelationship = (relationship: RelationshipType) => {
    const flipped = relationship.cardinality === Cardinality.many_to_one;
    const pairs = [
        { source: relationship.sourceFieldId, target: relationship.targetFieldId },
        ...(relationship.relationshipFields ?? [])
            .slice()
            .sort((a, b) => a.sequence - b.sequence)
            .map((pair) => ({ source: pair.sourceFieldId, target: pair.targetFieldId })),
    ];
    return flipped
        ? { parentTableId: relationship.targetTableId, childTableId: relationship.sourceTableId, pairs: pairs.map((pair) => ({ parent: pair.target, child: pair.source })) }
        : { parentTableId: relationship.sourceTableId, childTableId: relationship.targetTableId, pairs: pairs.map((pair) => ({ parent: pair.source, child: pair.target })) };
};

/** Writes the project as DBML. Anything DBML cannot express is listed in `warnings`. */
export function toDbml(database: DatabaseType): DbmlExport {
    const warnings: DbmlWarning[] = [];
    const warn = (code: string, subject: string, message: string) => warnings.push({ code, subject, message });
    const lines: string[] = [];

    const dialect = database.dialect;
    const tables = database.tables ?? [];

    lines.push(`Project ${identifier(database.name)} {`);
    lines.push(`  database_type: ${quote(DBML_DATABASE_TYPE[dialect] ?? dialect)}`);
    lines.push("}");

    const fieldOwner = new Map<string, { table: TableType; field: FieldType }>();
    for (const table of tables) {
        for (const field of table.fields ?? []) fieldOwner.set(field.id, { table, field });
    }

    // Native-looking enum columns (MySQL/MariaDB ENUM) become DBML Enum blocks so the
    // allowed values survive; the column then refers to the block by name.
    const enumNames = new Map<string, string>();
    const usedEnumNames = new Set<string>();
    const enumBlocks: string[] = [];
    for (const table of tables) {
        for (const field of table.fields ?? []) {
            const values = parseValues(field.values);
            if (field.type?.type !== DataTypes.ENUM || values.length === 0) continue;
            const base = `${table.namespace ? `${table.namespace}_` : ""}${table.name}_${field.name}`;
            let name = base;
            for (let counter = 2; usedEnumNames.has(name); counter++) name = `${base}_${counter}`;
            usedEnumNames.add(name);
            enumNames.set(field.id, name);
            enumBlocks.push([`Enum ${identifier(name)} {`, ...values.map((value) => `  ${identifier(value)}`), "}"].join("\n"));
        }
    }
    for (const block of enumBlocks) lines.push("", block);

    const typeName = (field: FieldType, tableName: string): string => {
        const enumName = enumNames.get(field.id);
        if (enumName) return identifier(enumName);
        if (!field.type?.name) {
            warn("unknown-type", `${tableName}.${field.name}`, `Column "${tableName}.${field.name}" has no data type; written as text.`);
            return "text";
        }
        const modifiers = modifiersOf(field);
        let args = "";
        if (modifiers.includes(Modifiers.LENGTH) && field.maxLength) args = `(${field.maxLength})`;
        else if (modifiers.includes(Modifiers.PRECISION) && field.precision != null) {
            args = modifiers.includes(Modifiers.SCALE) && field.scale != null ? `(${field.precision},${field.scale})` : `(${field.precision})`;
        }
        return `${identifier(field.type.name)}${args}`;
    };

    const defaultSetting = (field: FieldType, tableName: string): string | undefined => {
        const value = field.defaultValue;
        if (value === null || value === undefined || value.trim().length === 0) return undefined;
        const kind = field.type?.type;
        if (kind === DataTypes.TIME && value === TimeDefaultValues.NOW) return "default: `now()`";
        if (field.type && (field.type.name === "uuid" || field.type.name === "uniqueidentifier") && value === "random") {
            const expression = RANDOM_UUID_EXPRESSION[dialect];
            if (expression) return `default: \`${expression}\``;
            warn("unsupported-default", `${tableName}.${field.name}`, `The random-uuid default of "${tableName}.${field.name}" has no DBML form for ${dialect}; omitted.`);
            return undefined;
        }
        if ((kind === DataTypes.INTEGER || kind === DataTypes.NUMERIC) && value.trim() !== "" && !Number.isNaN(Number(value))) return `default: ${Number(value)}`;
        if (value === "true" || value === "false") return `default: ${value}`;
        return `default: ${quote(value)}`;
    };

    for (const table of tables) {
        const settings: string[] = [];
        if (table.color && HEX_COLOR.test(table.color)) settings.push(`headerColor: ${table.color}`);
        else if (table.color) warn("unsupported-color", table.name, `Table color "${table.color}" of "${table.name}" is not a hex color; omitted.`);
        lines.push("", `Table ${tableReference(table)}${settings.length > 0 ? ` [${settings.join(", ")}]` : ""} {`);

        const fields = (table.fields ?? []).slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
        const primaryFields = fields.filter((field) => field.isPrimary);
        const compositePrimary = primaryFields.length > 1;

        for (const field of fields) {
            const column = `${table.name}.${field.name}`;
            const setting: string[] = [];
            if (field.isPrimary && !compositePrimary) setting.push("pk");
            if (field.autoIncrement) setting.push("increment");
            if (field.unique) setting.push("unique");
            if (field.nullable === false && !field.isPrimary) setting.push("not null");
            const defaultText = defaultSetting(field, table.name);
            if (defaultText) setting.push(defaultText);
            if (field.note) setting.push(`note: ${quote(field.note)}`);
            lines.push(`  ${identifier(field.name)} ${typeName(field, table.name)}${setting.length > 0 ? ` [${setting.join(", ")}]` : ""}`);

            if (field.unsigned) warn("unsupported-flag", column, `"unsigned" on "${column}" has no DBML form; omitted.`);
            if (field.zeroFill) warn("unsupported-flag", column, `"zerofill" on "${column}" has no DBML form; omitted.`);
            if (field.charset) warn("unsupported-flag", column, `Character set "${field.charset}" on "${column}" has no DBML form; omitted.`);
            if (field.collate) warn("unsupported-flag", column, `Collation "${field.collate}" on "${column}" has no DBML form; omitted.`);
        }

        if (table.note) lines.push("", `  Note: ${quote(table.note)}`);

        const indexLines: string[] = [];
        if (compositePrimary) indexLines.push(`    (${primaryFields.map((field) => identifier(field.name)).join(", ")}) [pk]`);
        for (const index of table.indices ?? []) {
            const columns = (index.fieldIndices ?? [])
                .map((fieldIndex) => fields.find((field) => field.id === fieldIndex.fieldId)?.name)
                .filter((name): name is string => Boolean(name));
            if (columns.length === 0) {
                warn("empty-index", `${table.name}.${index.name}`, `Index "${index.name}" on "${table.name}" has no columns; omitted.`);
                continue;
            }
            const indexSettings = [`name: ${quote(index.name)}`];
            if (index.unique) indexSettings.push("unique");
            const target = columns.length === 1 ? identifier(columns[0]) : `(${columns.map(identifier).join(", ")})`;
            indexLines.push(`    ${target} [${indexSettings.join(", ")}]`);
        }
        if (indexLines.length > 0) lines.push("", "  indexes {", ...indexLines, "  }");

        const checkLines: string[] = [];
        for (const check of table.checks ?? []) {
            if (check.expression.includes("`")) {
                warn("unsupported-check", `${table.name}.${check.name}`, `Check "${check.name}" on "${table.name}" contains a backtick, which DBML cannot hold; omitted.`);
                continue;
            }
            checkLines.push(`    \`${check.expression}\` [name: ${quote(check.name)}]`);
        }
        if (checkLines.length > 0) lines.push("", "  checks {", ...checkLines, "  }");

        lines.push("}");
    }

    const refLines: string[] = [];
    for (const relationship of database.relationships ?? []) {
        const label = relationship.name ?? relationship.id;
        const source = fieldOwner.get(relationship.sourceFieldId);
        const target = fieldOwner.get(relationship.targetFieldId);
        if (!source || !target) {
            warn("dangling-relationship", label, `Relationship "${label}" points at a missing column; omitted.`);
            continue;
        }

        const reference = (tableId: string, fieldIds: string[]): string | undefined => {
            const table = tables.find((candidate) => candidate.id === tableId);
            const names = fieldIds.map((fieldId) => fieldOwner.get(fieldId)?.field.name);
            if (!table || names.some((name) => !name)) return undefined;
            const columns = names.map((name) => identifier(name as string));
            return `${tableReference(table)}.${columns.length === 1 ? columns[0] : `(${columns.join(", ")})`}`;
        };

        let text: string | undefined;
        const settings: string[] = [];
        if (relationship.cardinality === Cardinality.many_to_many) {
            const left = reference(relationship.sourceTableId, [relationship.sourceFieldId]);
            const right = reference(relationship.targetTableId, [relationship.targetFieldId]);
            if (left && right) text = `${left} <> ${right}`;
        } else {
            const { parentTableId, childTableId, pairs } = orientRelationship(relationship);
            const parent = reference(parentTableId, pairs.map((pair) => pair.parent));
            const child = reference(childTableId, pairs.map((pair) => pair.child));
            if (parent && child) {
                // One-to-one is written parent first: DBML puts the foreign key on the second table.
                text = relationship.cardinality === Cardinality.one_to_one ? `${parent} - ${child}` : `${child} > ${parent}`;
            }
            if (relationship.onDelete && DBML_ACTIONS[relationship.onDelete]) settings.push(`delete: ${DBML_ACTIONS[relationship.onDelete]}`);
            if (relationship.onUpdate && DBML_ACTIONS[relationship.onUpdate]) settings.push(`update: ${DBML_ACTIONS[relationship.onUpdate]}`);
        }
        if (!text) {
            warn("dangling-relationship", label, `Relationship "${label}" points at a missing table or column; omitted.`);
            continue;
        }
        refLines.push(`Ref${relationship.name ? ` ${identifier(relationship.name)}` : ""}: ${text}${settings.length > 0 ? ` [${settings.join(", ")}]` : ""}`);
    }
    if (refLines.length > 0) lines.push("", ...refLines);

    // DBML has no views or sequences. Keep a visible trace in the file and in the warnings.
    for (const view of database.views ?? []) {
        const name = view.namespace ? `${view.namespace}.${view.name}` : view.name;
        warn("unsupported-view", name, `${view.materialized ? "Materialized view" : "View"} "${name}" cannot be written as DBML; omitted.`);
        lines.push("", `// ${view.materialized ? "Materialized view" : "View"} ${name} was not exported: DBML has no views.`);
    }
    for (const sequence of database.sequences ?? []) {
        const name = sequence.namespace ? `${sequence.namespace}.${sequence.name}` : sequence.name;
        warn("unsupported-sequence", name, `Sequence "${name}" cannot be written as DBML; omitted.`);
        lines.push("", `// Sequence ${name} was not exported: DBML has no sequences.`);
    }

    return { dbml: `${lines.join("\n")}\n`, warnings };
}
