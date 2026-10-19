import { describe, expect, it } from "vitest";
import { buildRowsQuery, CELL_MAX_CHARS, DataRequestError, DEFAULT_LIMIT, MAX_LIMIT, quoteIdent, truncateCell, type RelationColumn } from "./pg-data.js";

const columns: RelationColumn[] = [
    { name: "id", dataType: "integer", isPrimaryKey: true },
    { name: "Weird \"name\"", dataType: "jsonb", isPrimaryKey: false },
    { name: "created_at", dataType: "timestamp with time zone", isPrimaryKey: false },
];

const base = { schema: "public", table: "orders", columns, relkind: "r" as const, pkColumns: ["id"] };

describe("quoteIdent", () => {
    it("wraps in double quotes and doubles embedded quotes", () => {
        expect(quoteIdent("orders")).toBe('"orders"');
        expect(quoteIdent('we"ird')).toBe('"we""ird"');
        expect(quoteIdent('x"; DROP TABLE users; --')).toBe('"x""; DROP TABLE users; --"');
    });

    it("rejects null bytes", () => {
        expect(() => quoteIdent("a\0b")).toThrow(DataRequestError);
    });
});

describe("buildRowsQuery", () => {
    it("selects every column as truncated text and quotes identifiers", () => {
        const { text } = buildRowsQuery(base);
        expect(text).toContain(`left("id"::text, ${CELL_MAX_CHARS + 1}) AS c0`);
        expect(text).toContain(`left("Weird ""name"""::text, ${CELL_MAX_CHARS + 1}) AS c1`);
        expect(text).toContain('FROM "public"."orders"');
    });

    it("never interpolates user-controlled values: only LIMIT/OFFSET are bound", () => {
        const query = buildRowsQuery({ ...base, limit: 25, offset: 50 });
        expect(query.text).toMatch(/LIMIT \$1 OFFSET \$2$/);
        expect(query.values).toEqual([25, 50]);
    });

    it("clamps limit and offset", () => {
        expect(buildRowsQuery({ ...base, limit: 9999 }).values[0]).toBe(MAX_LIMIT);
        expect(buildRowsQuery({ ...base, limit: 0 }).values[0]).toBe(1);
        expect(buildRowsQuery({ ...base, limit: -5 }).values[0]).toBe(1);
        expect(buildRowsQuery({ ...base, limit: Number.NaN }).values[0]).toBe(DEFAULT_LIMIT);
        expect(buildRowsQuery({ ...base, offset: -10 }).values[1]).toBe(0);
        expect(buildRowsQuery({ ...base }).values).toEqual([DEFAULT_LIMIT, 0]);
    });

    it("orders by the primary key by default for stable paging", () => {
        expect(buildRowsQuery(base).text).toContain('ORDER BY "id" LIMIT');
    });

    it("falls back to ctid for tables without a primary key", () => {
        expect(buildRowsQuery({ ...base, pkColumns: [] }).text).toContain("ORDER BY ctid LIMIT");
        expect(buildRowsQuery({ ...base, pkColumns: [], relkind: "m" }).text).toContain("ORDER BY ctid LIMIT");
    });

    it("does not order views without a key (they have no ctid)", () => {
        const { text } = buildRowsQuery({ ...base, pkColumns: [], relkind: "v" });
        expect(text).not.toContain("ORDER BY");
        expect(text).not.toContain("ctid");
    });

    it("sorts on the real column (not the text cast), NULLs last, then the tie-breaker", () => {
        const { text } = buildRowsQuery({ ...base, sort: "created_at", dir: "desc" });
        expect(text).toContain('ORDER BY "created_at" DESC NULLS LAST, "id" LIMIT');
    });

    it("does not repeat the sort column as its own tie-breaker", () => {
        const { text } = buildRowsQuery({ ...base, sort: "id", dir: "asc" });
        expect(text).toContain('ORDER BY "id" ASC NULLS LAST LIMIT');
    });

    it("rejects a sort column that is not in the catalog column list", () => {
        expect(() => buildRowsQuery({ ...base, sort: "id; DROP TABLE orders" })).toThrow(DataRequestError);
        expect(() => buildRowsQuery({ ...base, sort: "nope" })).toThrow(/Unknown sort column/);
    });

    it("treats an unknown direction as ascending", () => {
        const { text } = buildRowsQuery({ ...base, sort: "id", dir: "sideways" as never });
        expect(text).toContain('"id" ASC');
    });

    it("rejects relations with no columns", () => {
        expect(() => buildRowsQuery({ ...base, columns: [] })).toThrow(DataRequestError);
    });
});

describe("truncateCell", () => {
    it("leaves short values alone", () => {
        expect(truncateCell("hello")).toEqual({ value: "hello", truncated: false });
    });

    it("cuts long values to CELL_MAX_CHARS and flags them", () => {
        const result = truncateCell("a".repeat(CELL_MAX_CHARS + 1));
        expect(result.truncated).toBe(true);
        expect(result.value).toHaveLength(CELL_MAX_CHARS);
    });

    it("counts code points, not UTF-16 units, so astral characters are not flagged early", () => {
        const emoji = "😀".repeat(CELL_MAX_CHARS); // 2 UTF-16 units each, but exactly CELL_MAX_CHARS characters
        expect(truncateCell(emoji)).toEqual({ value: emoji, truncated: false });
        expect(truncateCell(emoji + "x").truncated).toBe(true);
    });
});
