import { DatabaseDialect } from "@/lib/database";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import type { DataType } from "@/lib/schemas/data-type-schema";
import { parseDbml } from "@/utils/dbml/from-dbml";
import { getDataTypes } from "./data-types";

/** Builders for DBML tests: small in-memory projects shaped like the app's database object. */
let counter = 0;
export const idFactory = () => `id-${++counter}`;

export const typeNamed = (dialect: DatabaseDialect, name: string): DataType => {
    const found = getDataTypes(dialect).find((dataType) => dataType.name === name);
    if (!found) throw new Error(`fixture type ${name} missing for ${dialect}`);
    return found;
};

export interface FieldSpec {
    name: string;
    type: string;
    primary?: boolean;
    unique?: boolean;
    nullable?: boolean;
    autoIncrement?: boolean;
    maxLength?: number;
    precision?: number;
    scale?: number;
    defaultValue?: string;
    note?: string;
    values?: string[];
}

export const makeField = (dialect: DatabaseDialect, tableId: string, spec: FieldSpec, sequence: number) => {
    const type = typeNamed(dialect, spec.type);
    return {
        id: `${tableId}.${spec.name}`,
        tableId,
        name: spec.name,
        type,
        typeId: type.id,
        isPrimary: !!spec.primary,
        unique: !!spec.unique,
        nullable: spec.nullable ?? !spec.primary,
        autoIncrement: !!spec.autoIncrement,
        maxLength: spec.maxLength ?? null,
        precision: spec.precision ?? null,
        scale: spec.scale ?? null,
        defaultValue: spec.defaultValue ?? null,
        note: spec.note ?? null,
        values: spec.values ? JSON.stringify(spec.values) : null,
        sequence,
        unsigned: false,
        zeroFill: false,
        isForeign: false,
        charset: null,
        collate: null,
    };
};

export const makeTable = (dialect: DatabaseDialect, id: string, fields: FieldSpec[], extra: Record<string, unknown> = {}) => ({
    id,
    databaseId: "db",
    name: id,
    namespace: null,
    posX: 0,
    posY: 0,
    color: null,
    note: null,
    sequence: 0,
    createdAt: null,
    indices: [],
    checks: [],
    ...extra,
    fields: fields.map((spec, position) => makeField(dialect, id, spec, position)),
});

export const makeDatabase = (dialect: DatabaseDialect, tables: any[], relationships: any[] = [], extra: Record<string, unknown> = {}): DatabaseType =>
    ({ id: "db", name: "shop", dialect, numOfTables: tables.length, createdAt: null, tables, relationships, views: [], sequences: [], ...extra }) as unknown as DatabaseType;

export const parse = (dbml: string, dialect: DatabaseDialect) =>
    parseDbml(dbml, { dialect, dataTypes: getDataTypes(dialect), newId: idFactory });

