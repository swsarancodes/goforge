import { PostgresDataType } from "@/lib/data_types/postgres_data_types";
import { DatabaseDialect } from "@/lib/database";
import type { DataType } from "@/lib/schemas/data-type-schema";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import type { FieldType } from "@/lib/schemas/field-schema";
import { TimeDefaultValues } from "@/lib/field";

/**
 * Turns an Oracle diagram into the PostgreSQL diagram a live database is built from. Only Oracle is converted; every other dialect is
 * refused by `canConvertToPostgres`. Nothing is dropped silently: a column type, default, view or constraint that has no faithful PostgreSQL
 * form is returned as a problem, and the caller refuses to create the database until the schema is changed.
 *
 *   NUMBER(p)      integer / bigint / numeric(p)      NUMBER(p,s)   numeric(p,s)      NUMBER   numeric
 *   VARCHAR2(n)    varchar(n)                          CHAR(n)       char(n)           CLOB     text
 *   DATE           timestamp (an Oracle DATE carries a time of day)                    BLOB/RAW bytea
 *   upper-case names become lower-case, because Oracle folds unquoted names to upper case and PostgreSQL to lower case, so queries the
 *   Query Modernizer converts (CUST_ID becomes cust_id) find them.
 */
export const canConvertToPostgres = (dialect: DatabaseDialect | undefined): boolean => dialect === DatabaseDialect.ORACLE;

/** The PostgreSQL type list, built the way the app seeds it (modifiers and synonyms as JSON text). */
export const postgresDataTypes: DataType[] = PostgresDataType.map(
    (type) =>
        ({
            ...type,
            dialect: DatabaseDialect.POSTGRES,
            modifiers: type.modifiers ? JSON.stringify(type.modifiers) : null,
            synonyms: type.synonyms ? JSON.stringify(type.synonyms) : null,
        }) as DataType,
);

const pgType = (name: string): DataType => {
    const found = postgresDataTypes.find((type) => type.name === name);
    if (!found) throw new Error(`The PostgreSQL type list has no ${name}.`);
    return found;
};

/** Oracle folds unquoted names to upper case. A name that is all upper case is the default spelling and becomes lower case; one with any lower-case letter was quoted on purpose and is kept. */
export const foldName = (name: string): string => (/[A-Z]/.test(name) && name === name.toUpperCase() ? name.toLowerCase() : name);

interface Mapped {
    type: string;
    maxLength?: number | null;
    precision?: number | null;
    scale?: number | null;
}

/** The PostgreSQL type for one Oracle column, or a reason there is not one. */
function mapType(field: Pick<FieldType, "maxLength" | "precision" | "scale" | "autoIncrement">, oracleType: string): Mapped | string {
    const { maxLength, precision, scale } = field;
    const name = oracleType.toLowerCase();
    switch (name) {
        case "number": {
            if (precision == null) return field.autoIncrement ? { type: "bigint" } : { type: "numeric" };
            if (scale == null || scale === 0) {
                if (precision <= 4) return { type: "smallint" };
                if (precision <= 9) return { type: "integer" };
                if (precision <= 18) return { type: "bigint" };
                return field.autoIncrement ? { type: "bigint" } : { type: "numeric", precision, scale: 0 };
            }
            return { type: "numeric", precision, scale };
        }
        case "integer":
            return field.autoIncrement ? { type: "bigint" } : { type: "numeric", precision: 38, scale: 0 };
        case "float":
        case "binary_double":
            return { type: "double precision" };
        case "binary_float":
            return { type: "real" };
        case "varchar2":
        case "nvarchar2":
            return { type: "varchar", maxLength: maxLength ?? null };
        case "char":
        case "nchar":
            return { type: "char", maxLength: maxLength ?? 1 };
        case "clob":
        case "nclob":
            return { type: "text" };
        case "blob":
        case "raw":
            return { type: "bytea" };
        case "date":
        case "timestamp":
            return { type: "timestamp" };
        case "rowid":
        case "urowid":
            return { type: "text" };
        case "xmltype":
            return { type: "xml" };
        case "json":
            return { type: "json" };
        default:
            return `${oracleType} has no PostgreSQL type this app can create`;
    }
}

const DEFAULT_NOW = /^(sysdate|systimestamp|current_date|current_timestamp)(\s*\(\s*\d*\s*\))?$/i;

function mapDefault(value: string | null | undefined): { value: string | null | undefined } | string {
    if (value == null) return { value };
    const text = value.trim();
    // the app's own marker for "the current time", which the PostgreSQL renderer writes as DEFAULT CURRENT_TIMESTAMP
    if (DEFAULT_NOW.test(text)) return { value: TimeDefaultValues.NOW };
    if (/^[A-Za-z_][\w$#.]*\s*\(/.test(text)) return `the default ${text} is an Oracle function`;
    return { value };
}

export interface PostgresConversion {
    database: DatabaseType;
    /** What stops the schema from becoming a PostgreSQL database, one line each; empty when it can go ahead. */
    problems: string[];
    /** What changed on the way, for the person to read. */
    notes: string[];
}

/** `oracleTypes` are the Oracle data types the diagram's fields refer to by `typeId` (a field loaded from a file may carry only the id). */
export function convertOracleToPostgres(source: DatabaseType, oracleTypes: DataType[] = []): PostgresConversion {
    const problems: string[] = [];
    const notes = new Set<string>();

    if (source.dialect !== DatabaseDialect.ORACLE) throw new Error(`Only an Oracle diagram is converted to PostgreSQL; this one is ${source.dialect}.`);
    if ((source.views ?? []).length > 0) problems.push(`The diagram has views (${(source.views ?? []).map((view) => view.name).join(", ")}). A view is Oracle SQL; convert it with the Query Modernizer first.`);

    const tables = source.tables.map((table) => {
        if ((table.checks ?? []).length > 0) problems.push(`${table.name} has CHECK constraints, which are Oracle expressions that are not converted.`);
        const fields = table.fields.map((field) => {
            const oracleName = field.type?.name || oracleTypes.find((type) => type.id === field.typeId)?.name || "";
            const label = `${table.name}.${field.name}`;
            const mapped = mapType(field, oracleName);
            if (typeof mapped === "string") {
                problems.push(`${label}: ${mapped}.`);
                return field;
            }
            const converted = mapDefault(field.defaultValue);
            if (typeof converted === "string") problems.push(`${label}: ${converted}.`);
            if (oracleName.toLowerCase() === "date") notes.add("DATE becomes timestamp, because an Oracle DATE carries a time of day.");
            if (oracleName.toLowerCase() === "number") notes.add("NUMBER becomes smallint, integer, bigint or numeric, by its precision and scale.");
            const type = pgType(mapped.type);
            return {
                ...field,
                name: foldName(field.name),
                type,
                typeId: type.id as string,
                maxLength: mapped.maxLength === undefined ? (type.name === "varchar" || type.name === "char" ? field.maxLength : null) : mapped.maxLength,
                precision: mapped.precision === undefined ? null : mapped.precision,
                scale: mapped.scale === undefined ? null : mapped.scale,
                defaultValue: typeof converted === "string" ? field.defaultValue : converted.value,
                autoIncrement: type.name === "smallint" || type.name === "integer" || type.name === "bigint" ? field.autoIncrement : false,
            } as FieldType;
        });
        return {
            ...table,
            name: foldName(table.name),
            namespace: table.namespace ? foldName(table.namespace) : table.namespace,
            fields,
            indices: (table.indices ?? []).map((index) => ({ ...index, name: foldName(index.name) })),
        };
    });
    if (tables.some((table, i) => table.name !== source.tables[i].name)) notes.add("Upper-case names become lower-case.");

    const database: DatabaseType = {
        ...source,
        dialect: DatabaseDialect.POSTGRES,
        tables,
        relationships: source.relationships.map((relationship) => ({ ...relationship, name: relationship.name ? foldName(relationship.name) : relationship.name })),
        views: [],
        sequences: (source.sequences ?? []).map((sequence) => ({ ...sequence, name: foldName(sequence.name) })),
    };
    return { database, problems, notes: [...notes] };
}
