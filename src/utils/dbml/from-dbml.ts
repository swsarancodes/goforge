import { DatabaseDialect } from "@/lib/database";
import { DataTypes, Modifiers, TimeDefaultValues } from "@/lib/field";
import type { DataType } from "@/lib/schemas/data-type-schema";
import { nextCheckName, validateCheck } from "@/lib/schemas/check-constraint-schema";
import { Cardinality } from "@/lib/schemas/relationship-schema";
import { v4 } from "uuid";
import { ProjectFile, ProjectIndex, ProjectRelationship, ProjectTable, PROJECT_FILE_FORMAT, PROJECT_FILE_VERSION } from "../project-file";
import { DbmlWarning } from "./dbml-shared";

export interface DbmlImport {
    file: ProjectFile;
    warnings: DbmlWarning[];
    /** `database_type` from the file, when present. */
    databaseType?: string;
}

export interface ParseDbmlOptions {
    dialect: DatabaseDialect;
    /** Data types of `dialect`; DBML type names are matched against their names and synonyms. */
    dataTypes: DataType[];
    /** Name used when the DBML has no `Project` block. */
    fallbackName?: string;
    newId?: () => string;
    now?: () => Date;
}

export class DbmlParseError extends Error {
    constructor(message: string, readonly details: string[] = []) {
        super(message);
        this.name = "DbmlParseError";
    }
}

const DEFAULT_SCHEMA = "public";

/** DBML spellings with no data type of that exact name, tried in order against the dialect's types. */
const TYPE_ALIASES: Record<string, string[]> = {
    int: ["integer", "int", "number"],
    integer: ["int", "number"],
    bool: ["boolean", "bit", "tinyint"],
    boolean: ["bool", "bit", "tinyint"],
    string: ["varchar", "nvarchar", "varchar2", "text"],
    float: ["real", "float4", "double precision", "double"],
    double: ["double precision", "float8"],
    datetime: ["timestamp", "datetime2", "timestamp without time zone"],
    timestamptz: ["timestamp with time zone"],
    json: ["jsonb"],
};

const FALLBACK_TEXT_TYPES = ["text", "varchar", "nvarchar", "varchar2", "clob"];

const NOW_EXPRESSIONS = /^\(?\s*(now\(\)|current_timestamp(\(\d*\))?|getdate\(\)|sysdate|systimestamp|localtimestamp(\(\d*\))?)\s*\)?$/i;
const RANDOM_UUID_EXPRESSIONS = /^\(?\s*(gen_random_uuid\(\)|uuid_generate_v4\(\)|uuid\(\)|newid\(\)|sys_guid\(\))\s*\)?$/i;

const ACTIONS: Record<string, string> = {
    cascade: "cascade",
    restrict: "restrict",
    "set null": "set_null",
    "set default": "set_default",
    "no action": "no_action",
};

const squash = (name: string) => name.toLowerCase().replace(/\s+/g, "");

const namespaceOf = (schemaName: string | null | undefined): string | null =>
    !schemaName || schemaName === DEFAULT_SCHEMA ? null : schemaName;

const describeDiagnostics = (error: any): string[] =>
    (Array.isArray(error?.diags) ? error.diags : [])
        .slice(0, 10)
        .map((diagnostic: any) => {
            const start = diagnostic?.location?.start;
            const where = start ? `line ${start.line}, column ${start.column}: ` : "";
            return `${where}${diagnostic?.message ?? "Invalid DBML"}`;
        });

const parseModifiers = (dataType: DataType): string[] => {
    if (!dataType.modifiers) return [];
    if (Array.isArray(dataType.modifiers)) return dataType.modifiers;
    try {
        return JSON.parse(dataType.modifiers);
    } catch {
        return [];
    }
};

const synonymsOf = (dataType: DataType): string[] => {
    if (!dataType.synonyms) return [];
    if (Array.isArray(dataType.synonyms)) return dataType.synonyms;
    try {
        return JSON.parse(dataType.synonyms);
    } catch {
        return [];
    }
};

/** Reads DBML into the portable project shape. Throws `DbmlParseError` when the text is not valid DBML. */
export async function parseDbml(text: string, options: ParseDbmlOptions): Promise<DbmlImport> {
    const newId = options.newId ?? v4;
    const warnings: DbmlWarning[] = [];
    const warn = (code: string, subject: string, message: string) => warnings.push({ code, subject, message });

    // The grammar package is large; load it only when a DBML file is actually opened.
    const { Parser } = await import("@dbml/core");
    let model: any;
    try {
        model = Parser.parse(text, "dbmlv2");
    } catch (error) {
        const details = describeDiagnostics(error);
        throw new DbmlParseError("This is not valid DBML.", details.length > 0 ? details : [error instanceof Error ? error.message : String(error)]);
    }

    const lookupType = (typeName: string): DataType | undefined => {
        const wanted = squash(typeName);
        const matches = (candidate: string) => options.dataTypes.find((dataType) =>
            squash(dataType.name ?? "") === candidate || synonymsOf(dataType).some((synonym) => squash(synonym) === candidate));
        return matches(wanted) ?? TYPE_ALIASES[wanted]?.map((alias) => matches(squash(alias))).find(Boolean);
    };
    const fallbackType = (): DataType | undefined => {
        for (const name of FALLBACK_TEXT_TYPES) {
            const found = options.dataTypes.find((dataType) => dataType.name === name);
            if (found) return found;
        }
        return options.dataTypes.find((dataType) => dataType.type === DataTypes.TEXT);
    };
    const enumType = options.dataTypes.find((dataType) => dataType.type === DataTypes.ENUM && squash(dataType.name ?? "") === "enum")
        ?? options.dataTypes.find((dataType) => dataType.type === DataTypes.ENUM);

    // Enums, addressable as `name` and `schema.name`.
    const enums = new Map<string, string[]>();
    for (const schema of model.schemas) {
        for (const declared of schema.enums ?? []) {
            const values = (declared.values ?? []).map((value: any) => String(value.name));
            enums.set(declared.name, values);
            enums.set(`${schema.name}.${declared.name}`, values);
        }
    }

    const tables: ProjectTable[] = [];
    const tableKey = new Map<string, ProjectTable>();
    const fieldIdOf = new Map<string, string>(); // `${tableId}\u0000${fieldName}` -> field id
    const keyFor = (namespace: string | null, name: string) => `${namespace ?? ""}\u0000${name}`;

    let tableSequence = 0;
    for (const schema of model.schemas) {
        for (const parsedTable of schema.tables) {
            const namespace = namespaceOf(schema.name);
            const tableLabel = namespace ? `${namespace}.${parsedTable.name}` : parsedTable.name;
            const tableId = newId();
            const table: ProjectTable = {
                id: tableId,
                name: parsedTable.name,
                namespace,
                posX: 0,
                posY: 0,
                color: parsedTable.headerColor ?? null,
                note: parsedTable.note ?? null,
                sequence: tableSequence++,
                fields: [],
                indices: [],
                checks: [],
            };

            const fieldByName = new Map<string, ProjectTable["fields"][number]>();
            for (const [position, parsedField] of (parsedTable.fields as any[]).entries()) {
                const column = `${tableLabel}.${parsedField.name}`;
                const typeName: string = parsedField.type?.type_name ?? "";
                const base = typeName.replace(/\(.*\)\s*$/, "").trim();
                const args = String(parsedField.type?.args ?? "")
                    .split(",")
                    .map((part: string) => part.trim())
                    .filter((part: string) => part.length > 0);

                let dataType: DataType | undefined;
                let values: string[] | undefined;
                const enumValues = enums.get(parsedField.type?.schemaName ? `${parsedField.type.schemaName}.${base}` : base) ?? enums.get(base);
                if (enumValues) {
                    if (enumType) {
                        dataType = enumType;
                        values = enumValues;
                    } else {
                        dataType = fallbackType();
                        warn("enum-as-text", column, `Enum "${base}" used by "${column}" has no equivalent in ${options.dialect}; the column is plain text (values: ${enumValues.join(", ")}).`);
                    }
                } else {
                    dataType = lookupType(base);
                    if (!dataType) {
                        dataType = fallbackType();
                        warn("unknown-type", column, `Type "${typeName}" of "${column}" is not a ${options.dialect} type; used ${dataType?.name ?? "text"} instead.`);
                    }
                }

                const modifiers = dataType ? parseModifiers(dataType) : [];
                let maxLength: number | null = null;
                let precision: number | null = null;
                let scale: number | null = null;
                const [first, second] = args.map(Number);
                if (!enumValues && args.length > 0) {
                    if (modifiers.includes(Modifiers.LENGTH) && Number.isFinite(first)) maxLength = first;
                    else if (modifiers.includes(Modifiers.PRECISION) && Number.isFinite(first)) {
                        precision = first;
                        if (modifiers.includes(Modifiers.SCALE) && Number.isFinite(second)) scale = second;
                    } else warn("ignored-type-arguments", column, `Arguments (${args.join(", ")}) of "${typeName}" on "${column}" do not apply to ${dataType?.name ?? "this type"}; ignored.`);
                }

                // DBML defaults: literal values, or a backtick expression.
                let defaultValue: string | null = null;
                const parsedDefault = parsedField.dbdefault;
                if (parsedDefault && parsedDefault.value !== null && parsedDefault.value !== undefined) {
                    if (parsedDefault.type === "expression") {
                        const expression = String(parsedDefault.value).trim();
                        if (dataType?.type === DataTypes.TIME && NOW_EXPRESSIONS.test(expression)) defaultValue = TimeDefaultValues.NOW;
                        else if ((dataType?.name === "uuid" || dataType?.name === "uniqueidentifier") && RANDOM_UUID_EXPRESSIONS.test(expression)) defaultValue = "random";
                        else warn("unsupported-default", column, `Default expression \`${expression}\` on "${column}" cannot be stored; omitted.`);
                    } else {
                        defaultValue = String(parsedDefault.value);
                    }
                }

                let autoIncrement = !!parsedField.increment;
                if (autoIncrement && !modifiers.includes(Modifiers.AUTO_INCREMENT)) {
                    warn("unsupported-increment", column, `"increment" on "${column}" is not supported by ${dataType?.name ?? "its type"}; ignored.`);
                    autoIncrement = false;
                }

                const isPrimary = !!parsedField.pk;
                const field = {
                    id: newId(),
                    name: parsedField.name,
                    typeId: dataType?.id ?? null,
                    isPrimary,
                    unique: !!parsedField.unique,
                    nullable: isPrimary ? false : !parsedField.not_null,
                    defaultValue,
                    note: parsedField.note ?? null,
                    sequence: position,
                    maxLength,
                    precision,
                    scale,
                    autoIncrement,
                    unsigned: false,
                    zeroFill: false,
                    isForeign: false,
                    charset: null,
                    collate: null,
                    values: values ? JSON.stringify(values) : null,
                } as ProjectTable["fields"][number];
                table.fields.push(field);
                fieldByName.set(field.name, field);
                fieldIdOf.set(`${tableId}\u0000${field.name}`, field.id as string);
            }

            const columnsOf = (columns: any[], where: string): ProjectTable["fields"][number][] | undefined => {
                const resolved: ProjectTable["fields"][number][] = [];
                for (const column of columns ?? []) {
                    const field = column.type === "column" ? fieldByName.get(column.value) : undefined;
                    if (!field) {
                        warn("unsupported-index", where, `${where} uses ${column.type === "column" ? `unknown column "${column.value}"` : `the expression \`${column.value}\``}, which cannot be stored; omitted.`);
                        return undefined;
                    }
                    resolved.push(field);
                }
                return resolved;
            };

            for (const parsedIndex of parsedTable.indexes ?? []) {
                const label = parsedIndex.name ?? (parsedIndex.columns ?? []).map((column: any) => column.value).join(", ");
                const where = `Index "${label}" on "${tableLabel}"`;
                const fields = columnsOf(parsedIndex.columns, where);
                if (!fields || fields.length === 0) continue;
                if (parsedIndex.pk) {
                    for (const field of fields) {
                        field.isPrimary = true;
                        field.nullable = false;
                    }
                    continue;
                }
                if (parsedIndex.type) warn("ignored-index-type", `${tableLabel}.${label}`, `${where} has type "${parsedIndex.type}", which is not stored; it becomes a default index.`);
                const indexId = newId();
                const index: ProjectIndex = {
                    id: indexId,
                    tableId,
                    name: parsedIndex.name ?? `${parsedTable.name}_${fields.map((field) => field.name).join("_")}_index`,
                    unique: !!parsedIndex.unique,
                    fieldIndices: fields.map((field) => ({ id: newId(), indexId, fieldId: field.id as string })),
                } as ProjectIndex;
                table.indices.push(index);
            }

            // Table-level checks plus the ones declared inline on a column.
            const declaredChecks: { name?: string | null; expression: string }[] = [
                ...(parsedTable.checks ?? []),
                ...(parsedTable.fields as any[]).flatMap((parsedField) => parsedField.checks ?? []),
            ];
            const seenExpressions = new Set<string>();
            for (const declared of declaredChecks) {
                const expression = String(declared.expression ?? "").trim();
                if (seenExpressions.has(expression)) continue;
                seenExpressions.add(expression);
                const name = declared.name || nextCheckName(parsedTable.name, table.checks as { name: string }[]);
                const problem = validateCheck({ name, expression }, (table.checks as { id: string; name: string }[]));
                if (problem) {
                    warn("unsupported-check", `${tableLabel}.${name}`, `Check "${name}" on "${tableLabel}" was skipped: ${problem}`);
                    continue;
                }
                table.checks!.push({ id: newId(), name, expression });
            }

            tables.push(table);
            tableKey.set(keyFor(namespace, parsedTable.name), table);
        }
    }

    // Foreign keys. DBML puts the referenced table on the `1` side; GoForge stores the
    // referenced table as the relationship source and the key holder as its target.
    const relationships: ProjectRelationship[] = [];
    for (const schema of model.schemas) {
        for (const ref of schema.refs ?? []) {
            const [left, right] = ref.endpoints as any[];
            const label = ref.name ?? `${left.tableName}.${left.fieldNames?.join(",")} → ${right.tableName}.${right.fieldNames?.join(",")}`;
            const leftTable = tableKey.get(keyFor(namespaceOf(left.schemaName), left.tableName));
            const rightTable = tableKey.get(keyFor(namespaceOf(right.schemaName), right.tableName));
            if (!leftTable || !rightTable) {
                warn("dangling-relationship", label, `Relationship "${label}" points at a table that does not exist; skipped.`);
                continue;
            }

            const manyToMany = left.relation === "*" && right.relation === "*";
            // The `1` side is the parent; when both are `1` (one-to-one) the first listed is.
            const [parent, child] = right.relation === "1" && left.relation === "*" ? [right, left] : [left, right];
            const parentTable = parent === left ? leftTable : rightTable;
            const childTable = parent === left ? rightTable : leftTable;

            const pairs = (parent.fieldNames as string[]).map((name, index) => ({
                parent: fieldIdOf.get(`${parentTable.id}\u0000${name}`),
                child: fieldIdOf.get(`${childTable.id}\u0000${child.fieldNames[index]}`),
            }));
            if (pairs.length === 0 || pairs.length !== child.fieldNames.length || pairs.some((pair) => !pair.parent || !pair.child)) {
                warn("dangling-relationship", label, `Relationship "${label}" has mismatched or unknown columns; skipped.`);
                continue;
            }
            if (manyToMany && pairs.length > 1) {
                warn("composite-many-to-many", label, `Many-to-many relationship "${label}" has several columns; only the first pair is kept.`);
                pairs.length = 1;
            }

            const relationshipId = newId();
            relationships.push({
                id: relationshipId,
                name: ref.name ?? null,
                sourceTableId: parentTable.id,
                targetTableId: childTable.id,
                sourceFieldId: pairs[0].parent as string,
                targetFieldId: pairs[0].child as string,
                cardinality: manyToMany ? Cardinality.many_to_many : left.relation === "1" && right.relation === "1" ? Cardinality.one_to_one : Cardinality.one_to_many,
                onDelete: ACTIONS[String(ref.onDelete ?? "").toLowerCase()] ?? "no_action",
                onUpdate: ACTIONS[String(ref.onUpdate ?? "").toLowerCase()] ?? "no_action",
                relationshipFields: pairs.slice(1).map((pair, index) => ({
                    id: newId(),
                    relationshipId,
                    sourceFieldId: pair.parent as string,
                    targetFieldId: pair.child as string,
                    sequence: index + 1,
                })),
            } as ProjectRelationship);

            if (!manyToMany) {
                for (const pair of pairs) {
                    const holder = childTable.fields.find((field) => field.id === pair.child);
                    if (holder) holder.isForeign = true;
                }
            }
        }
    }

    // Parts of DBML that have no counterpart here are reported, never silently dropped.
    const groups = model.schemas.reduce((total: number, schema: any) => total + (schema.tableGroups?.length ?? 0), 0);
    if (groups > 0) warn("ignored-table-groups", "TableGroup", `${groups} table group${groups === 1 ? "" : "s"} ignored: GoForge has no table groups.`);
    if ((model.notes?.length ?? 0) > 0) warn("ignored-notes", "Note", `${model.notes.length} sticky note${model.notes.length === 1 ? "" : "s"} ignored.`);
    if ((model.records?.length ?? 0) > 0) warn("ignored-records", "records", "Sample data records ignored: GoForge stores schema only.");

    const projectNote = typeof model.note === "string" && model.note.length > 0;
    if (projectNote) warn("ignored-project-note", "Project", "The project note was ignored.");

    const file: ProjectFile = {
        format: PROJECT_FILE_FORMAT,
        formatVersion: PROJECT_FILE_VERSION,
        exportedAt: (options.now?.() ?? new Date()).toISOString(),
        project: {
            name: (typeof model.name === "string" && model.name.trim()) || options.fallbackName || "Imported DBML",
            dialect: options.dialect,
            tables,
            relationships,
            views: [],
            sequences: [],
        },
    };

    return { file, warnings, databaseType: typeof model.databaseType === "string" ? model.databaseType : undefined };
}
