export type CellKind = "null" | "boolean" | "number" | "json" | "bytea" | "uuid" | "temporal" | "array" | "text";

export interface FormattedCell {
    kind: CellKind;
    /** Single-line text for a grid cell (already clipped). */
    display: string;
    /** Full text for the detail view (pretty-printed for JSON). */
    full: string;
    align: "left" | "right";
    /** Extra info shown next to the value, e.g. "12 bytes". */
    meta?: string;
}

const DISPLAY_MAX = 200;
const BYTEA_PREVIEW_BYTES = 16;

const NUMERIC_TYPES = /^(smallint|integer|bigint|numeric|decimal|real|double precision|money|oid|smallserial|serial|bigserial)\b/;
const TEMPORAL_TYPES = /^(date|time|timestamp|interval)\b/;

/** Maps a Postgres format_type() string to the renderer that suits it. Anything unrecognised is plain text. */
export function classifyType(dataType: string): Exclude<CellKind, "null"> {
    const type = dataType.trim().toLowerCase();
    if (type.endsWith("[]")) return "array";
    if (type === "json" || type === "jsonb") return "json";
    if (type === "boolean") return "boolean";
    if (type === "bytea") return "bytea";
    if (type === "uuid") return "uuid";
    if (NUMERIC_TYPES.test(type)) return "number";
    if (TEMPORAL_TYPES.test(type)) return "temporal";
    return "text";
}

function clip(text: string, max = DISPLAY_MAX): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function oneLine(text: string): string {
    return text.replace(/\r?\n/g, " ↵ ");
}

function formatJson(value: string): { display: string; full: string } {
    try {
        const parsed = JSON.parse(value);
        return { display: clip(JSON.stringify(parsed)), full: JSON.stringify(parsed, null, 2) };
    } catch {
        // Not valid JSON (e.g. a value the server cut short): show it as it is.
        return { display: clip(oneLine(value)), full: value };
    }
}

function formatBytea(value: string, truncated: boolean): { display: string; full: string; meta?: string } {
    // Postgres' default bytea_output is hex: "\x" followed by two hex digits per byte.
    if (!value.startsWith("\\x")) return { display: clip(oneLine(value)), full: value };
    const hex = value.slice(2);
    const bytes = Math.floor(hex.length / 2);
    const preview = hex.slice(0, BYTEA_PREVIEW_BYTES * 2);
    const display = `\\x${preview}${hex.length > preview.length ? "…" : ""}`;
    return { display, full: value, meta: truncated ? `at least ${bytes} bytes` : `${bytes} byte${bytes === 1 ? "" : "s"}` };
}

/**
 * Turns a cell's text (as returned by the server, `::text` of the real value) into what the grid and
 * detail view show, based on the column's Postgres type. Never throws on malformed input.
 */
export function formatCell(dataType: string, value: string | null, truncated = false): FormattedCell {
    if (value === null) return { kind: "null", display: "NULL", full: "NULL", align: "left" };

    const kind = classifyType(dataType);

    switch (kind) {
        case "boolean": {
            // The server sends `bool::text`, which is "true" / "false"; tolerate the "t" / "f" output form too.
            const text = value === "t" ? "true" : value === "f" ? "false" : value;
            return { kind, display: text, full: text, align: "left" };
        }
        case "json": {
            const { display, full } = formatJson(value);
            return { kind, display, full, align: "left" };
        }
        case "bytea": {
            const { display, full, meta } = formatBytea(value, truncated);
            return { kind, display, full, align: "left", meta };
        }
        case "number":
            return { kind, display: clip(value), full: value, align: "right" };
        default:
            return { kind, display: clip(oneLine(value)), full: value, align: "left" };
    }
}
