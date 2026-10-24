import { describe, expect, it } from "vitest";
import { classifyType, formatCell } from "./format-cell";

describe("classifyType", () => {
    it.each([
        ["integer", "number"],
        ["bigint", "number"],
        ["numeric(30,10)", "number"],
        ["double precision", "number"],
        ["money", "number"],
        ["boolean", "boolean"],
        ["json", "json"],
        ["jsonb", "json"],
        ["uuid", "uuid"],
        ["bytea", "bytea"],
        ["date", "temporal"],
        ["time without time zone", "temporal"],
        ["timestamp with time zone", "temporal"],
        ["interval", "temporal"],
        ["integer[]", "array"],
        ["text[]", "array"],
        ["jsonb[]", "array"],
        ["text", "text"],
        ["character varying(255)", "text"],
        ["inet", "text"],
        ["int4range", "text"],
        ["point", "text"],
        ["mood", "text"], // user-defined enum
    ])("%s -> %s", (dataType, kind) => {
        expect(classifyType(dataType)).toBe(kind);
    });
});

describe("formatCell", () => {
    it("distinguishes SQL NULL from the string 'NULL'", () => {
        expect(formatCell("text", null).kind).toBe("null");
        const text = formatCell("text", "NULL");
        expect(text.kind).toBe("text");
        expect(text.display).toBe("NULL");
    });

    it("keeps the empty string visible as an empty text cell, not NULL", () => {
        const cell = formatCell("text", "");
        expect(cell.kind).toBe("text");
        expect(cell.display).toBe("");
    });

    it("renders Postgres booleans", () => {
        expect(formatCell("boolean", "true").display).toBe("true");
        expect(formatCell("boolean", "false").display).toBe("false");
        expect(formatCell("boolean", "t").display).toBe("true");
        expect(formatCell("boolean", "f").display).toBe("false");
    });

    it("right-aligns numbers and never reformats them (no precision loss)", () => {
        const big = formatCell("bigint", "9223372036854775807");
        expect(big.align).toBe("right");
        expect(big.display).toBe("9223372036854775807");
        expect(formatCell("numeric(30,10)", "12345678901234567890.1234567890").display).toBe("12345678901234567890.1234567890");
    });

    it("shows compact JSON in the grid and pretty JSON in the detail view", () => {
        const cell = formatCell("jsonb", '{"a": 1, "b": [1, 2], "c": {"d": "é"}}');
        expect(cell.display).toBe('{"a":1,"b":[1,2],"c":{"d":"é"}}');
        expect(cell.full).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "c": {\n    "d": "é"\n  }\n}');
    });

    it("falls back to the raw text for JSON that was cut short", () => {
        const cell = formatCell("jsonb", '{"a": "unfinished', true);
        expect(cell.display).toBe('{"a": "unfinished');
        expect(cell.full).toBe('{"a": "unfinished');
    });

    it("summarises bytea by size with a hex preview", () => {
        const cell = formatCell("bytea", "\\x48656c6c6f");
        expect(cell.display).toBe("\\x48656c6c6f");
        expect(cell.meta).toBe("5 bytes");
        expect(formatCell("bytea", "\\xff").meta).toBe("1 byte");
        expect(formatCell("bytea", "\\x").meta).toBe("0 bytes");
    });

    it("clips long bytea previews and reports a lower bound when truncated", () => {
        const cell = formatCell("bytea", `\\x${"ab".repeat(100)}`, true);
        expect(cell.display).toBe(`\\x${"ab".repeat(16)}…`);
        expect(cell.meta).toBe("at least 100 bytes");
    });

    it("passes through non-hex bytea (escape output format) unchanged", () => {
        expect(formatCell("bytea", "abc\\000def").display).toBe("abc\\000def");
    });

    it("leaves arrays, ranges, network and temporal values exactly as Postgres printed them", () => {
        expect(formatCell("integer[]", "{1,2,NULL,4}").display).toBe("{1,2,NULL,4}");
        expect(formatCell("int4range", "[1,10)").display).toBe("[1,10)");
        expect(formatCell("inet", "192.168.0.1/24").display).toBe("192.168.0.1/24");
        expect(formatCell("timestamp with time zone", "2024-01-02 03:04:05.123456+05:30").display).toBe("2024-01-02 03:04:05.123456+05:30");
        expect(formatCell("timestamp without time zone", "infinity").display).toBe("infinity");
    });

    it("keeps multi-line text on one line in the grid but intact in the detail view", () => {
        const cell = formatCell("text", "line one\nline two");
        expect(cell.display).toBe("line one ↵ line two");
        expect(cell.full).toBe("line one\nline two");
    });

    it("clips very long single-line values for the grid only", () => {
        const long = "x".repeat(500);
        const cell = formatCell("text", long);
        expect(cell.display).toBe(`${"x".repeat(200)}…`);
        expect(cell.full).toBe(long);
    });
});
