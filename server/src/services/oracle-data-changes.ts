import type { ConversionStatus } from "./oracle-conversion-notes.js";
import { oracleSelectExpression, type PlannedColumn } from "./oracle-migration.js";
import { oracleFamily, parsePgType } from "./oracle-type-edits.js";

/**
 * What the copy does to the VALUES of a column, said once per Oracle type and PostgreSQL type, from the same logic the copy runs: the read
 * expression is `oracleSelectExpression` itself, and the other conversions are the ones in `migrationFetch` (numbers fetched as text with a
 * leading dot given its 0, long text fetched whole, bytes fetched as bytes). Nothing here is measured on the data: counts are a separate
 * step. This is the part of the report that answers "what will happen to my values", and it is written so that the report can be built from
 * a plan alone.
 */

export type DataChangeEffect =
    /** The value arrives as it is. */
    | "kept"
    /** The same value, written another way. */
    | "reformatted"
    /** Turned into a different kind of value: a zone, a floating-point number, a type. */
    | "converted"
    /** Part of the value is not carried. */
    | "dropped";

export interface DataChange {
    /** What the copy does to the value, in a sentence. */
    summary: string;
    /** How the value is read from Oracle: the SELECT expression, or the driver's conversion. */
    read: string;
    /** What PostgreSQL receives and stores. */
    load: string;
    effect: DataChangeEffect;
    /** `exact` nothing changes, `changed` the value is converted or written another way, `risk` something about it is not kept. */
    status: ConversionStatus;
    /** Things worth saying beyond the sentence: the empty string, a limit. */
    notes: string[];
}

type ReadShape = Pick<PlannedColumn, "oracleName" | "oracleType" | "pgType">;

const EMPTY_STRING = "An empty string is NULL in Oracle, so there are none to convert; a NULL stays NULL in PostgreSQL.";

export function dataChangeFor(column: ReadShape): DataChange {
    const family = oracleFamily({ type: column.oracleType });
    const pg = parsePgType(column.pgType);
    const target = pg?.name;
    const type = column.pgType;
    const expression = oracleSelectExpression(column);

    if (!pg || family === "other") {
        return { summary: `${column.oracleType} has no PostgreSQL type here, so it is not copied.`, read: "not read", load: "not loaded", effect: "dropped", status: "risk", notes: [] };
    }

    switch (family) {
        case "number":
        case "float": {
            const readText = "fetched as text (not as a JavaScript number), with a leading dot given its 0: .5 becomes 0.5";
            if (target === "text") return { summary: `Written as the text Oracle prints (a leading dot gets its 0), and loaded as text.`, read: readText, load: "the digits as text", effect: "reformatted", status: "changed", notes: [] };
            if (target === "boolean") return { summary: `0 and 1 become false and true; any other number stops the copy.`, read: readText, load: "text 0 or 1, which PostgreSQL reads as a boolean", effect: "converted", status: "changed", notes: [] };
            if (target === "real" || target === "double precision") {
                const wide = /^BINARY_/i.test(column.oracleType);
                if (wide) return { summary: `The same IEEE floating-point number, written as text and parsed again as ${type}.`, read: readText, load: `${type}, parsed from the text`, effect: "kept", status: "exact", notes: [] };
                return {
                    summary: `Parsed as a floating-point number (${type}): digits past about ${target === "real" ? 6 : 15} significant ones are rounded.`,
                    read: readText,
                    load: `${type}, parsed from the text`,
                    effect: "converted",
                    status: "changed",
                    notes: ["How many values have more digits than that is counted on your data when the type was chosen by you or is a wide FLOAT."],
                };
            }
            if (target && ["smallint", "integer", "bigint"].includes(target)) return { summary: `Written as digits and parsed as ${type}: every digit is kept, and a value that is not a whole number or does not fit would stop the copy.`, read: readText, load: `${type}, parsed from the text`, effect: "kept", status: "exact", notes: [] };
            return { summary: `Every digit is kept: the text Oracle prints is parsed as ${type}.`, read: readText, load: `${type}, parsed from the text`, effect: "kept", status: "exact", notes: [] };
        }
        case "string": {
            const notes = [EMPTY_STRING];
            if (target === "boolean") return { summary: "Y, N, T, F, 1 and 0 become true and false; any other text stops the copy.", read: column.oracleName, load: "the text, which PostgreSQL reads as a boolean", effect: "converted", status: "changed", notes };
            if (target && ["smallint", "integer", "bigint", "numeric"].includes(target)) return { summary: `The text is parsed as ${type}; text that is not a number stops the copy, and the check counts it first.`, read: column.oracleName, load: `${type}, parsed from the text`, effect: "converted", status: "changed", notes };
            if (/^N?CHAR$/i.test(column.oracleType.replace(/\(\d+\)/, ""))) return { summary: `The same characters, loaded as ${type}, which pads with blanks to its length as Oracle's CHAR does.`, read: column.oracleName, load: type, effect: "kept", status: "exact", notes };
            return { summary: `The same characters, loaded as ${type}.`, read: column.oracleName, load: type, effect: "kept", status: "exact", notes };
        }
        case "clob":
            return { summary: "The whole value is fetched as a string and loaded as text: every character is carried.", read: "fetched whole as a string (the driver's VARCHAR fetch type)", load: type, effect: "kept", status: "exact", notes: ["A value over 1 GB would stop the copy, not be cut.", EMPTY_STRING] };
        case "binary":
            return { summary: `The same bytes, fetched as bytes and loaded as ${type}.`, read: column.oracleType.toUpperCase() === "BLOB" ? "BLOB fetched as bytes (the driver's RAW fetch type)" : "RAW fetched as bytes", load: type, effect: "kept", status: "exact", notes: ["A value over 1 GB would stop the copy, not be cut."] };
        case "date":
        case "timestamp": {
            const isDate = family === "date";
            if (target === "date") return { summary: `Read as the day only: the time of day is dropped.`, read: expression, load: "date", effect: "dropped", status: "risk", notes: ["How many values have a time of day is counted on your data."] };
            if (target === "text") return { summary: `Written as text, ${isDate ? "to the second" : "to the fraction of a second the column keeps"}, and loaded as text.`, read: expression, load: "text", effect: "reformatted", status: "changed", notes: [] };
            return {
                summary: isDate ? "Read as text to the second and loaded as timestamp(0): the day and the time of day are both kept." : `Read as text with the column's fractional digits and loaded as ${type}: day, time and fraction are kept.`,
                read: expression,
                load: type,
                effect: "kept",
                status: "exact",
                notes: isDate ? ["An Oracle DATE has a time of day; it is not a PostgreSQL date unless you choose date."] : [],
            };
        }
        case "timestamptz": {
            const local = /LOCAL/i.test(column.oracleType);
            const readUtc = expression;
            if (target === "text") return { summary: "Written as UTC text (the offset is not kept) and loaded as text.", read: readUtc, load: "text, in UTC", effect: "converted", status: "risk", notes: [] };
            if (local) {
                return { summary: "The instant is kept, written in UTC. Oracle stores this type in one zone and shows it in the session's, so there is no original offset to lose.", read: readUtc, load: type, effect: "converted", status: "changed", notes: ["The instant is the same; PostgreSQL shows it in the session's time zone."] };
            }
            return {
                summary: "Converted to UTC: the instant is kept, and the offset each value was written with is not.",
                read: readUtc,
                load: `${type}, in UTC`,
                effect: "converted",
                status: "risk",
                notes: ["How many values were written in an offset other than UTC is counted on your data."],
            };
        }
        case "rowid":
            return { summary: "Copied as text. The value is Oracle's physical row address and means nothing in PostgreSQL.", read: column.oracleName, load: "text", effect: "kept", status: "changed", notes: [] };
    }
    // unreachable: every family is handled, `other` above
    return { summary: "Not copied.", read: "not read", load: "not loaded", effect: "dropped", status: "risk", notes: [] };
}

