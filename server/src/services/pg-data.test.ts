import { describe, expect, it } from "vitest";
import { buildRowsQuery, CELL_MAX_CHARS, DataRequestError, DEFAULT_LIMIT, fetchTableRows, MAX_LIMIT, quoteIdent, quoteLiteral, truncateCell, type RelationColumn } from "./pg-data.js";
import type { Queryable } from "./pg-read.js";
import type { RelationMeta } from "./pg-relations.js";

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

    it("is self-contained: LIMIT/OFFSET are inlined validated integers, nothing is bound", () => {
        const query = buildRowsQuery({ ...base, limit: 25, offset: 50 });
        expect(query.text).toMatch(/LIMIT 25 OFFSET 50$/);
        expect(query.text).not.toMatch(/\$\d/);
        expect(query).toMatchObject({ limit: 25, offset: 50 });
    });

    it("clamps limit and offset", () => {
        expect(buildRowsQuery({ ...base, limit: 9999 }).limit).toBe(MAX_LIMIT);
        expect(buildRowsQuery({ ...base, limit: 0 }).limit).toBe(1);
        expect(buildRowsQuery({ ...base, limit: -5 }).limit).toBe(1);
        expect(buildRowsQuery({ ...base, limit: Number.NaN }).limit).toBe(DEFAULT_LIMIT);
        expect(buildRowsQuery({ ...base, limit: 25.9 }).limit).toBe(25);
        expect(buildRowsQuery({ ...base, offset: -10 }).offset).toBe(0);
        expect(buildRowsQuery({ ...base, offset: Number.POSITIVE_INFINITY }).offset).toBe(0);
        expect(buildRowsQuery({ ...base })).toMatchObject({ limit: DEFAULT_LIMIT, offset: 0 });
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

describe("quoteLiteral", () => {
    it("wraps in single quotes and doubles embedded quotes", () => {
        expect(quoteLiteral("public")).toBe("'public'");
        expect(quoteLiteral("o'neil")).toBe("'o''neil'");
        expect(quoteLiteral("x'; DROP TABLE users; --")).toBe("'x''; DROP TABLE users; --'");
    });

    it("uses an E'' string when the value contains a backslash", () => {
        expect(quoteLiteral("a\\b")).toBe("E'a\\\\b'");
        expect(quoteLiteral("\\'")).toBe("E'\\\\'''");
    });

    it("keeps unicode as is and rejects null bytes", () => {
        expect(quoteLiteral("日本語😀")).toBe("'日本語😀'");
        expect(() => quoteLiteral("a\0b")).toThrow(DataRequestError);
    });
});

describe("fetchTableRows", () => {
    const meta: RelationMeta = {
        schema: "public",
        name: "orders",
        kind: "table",
        relkind: "r",
        estimatedRows: 1200,
        columns: [
            { name: "id", dataType: "integer" },
            { name: "note", dataType: "text" },
        ],
        primaryKey: ["id"],
    };

    /** A fake client: records every statement sent and answers a data batch like Postgres would. */
    function fakeClient(rows: Record<string, string | null>[], total?: string) {
        const sent: string[] = [];
        const client: Queryable = {
            async query(text: string) {
                sent.push(text);
                const results: unknown[] = [{ command: "BEGIN" }, { command: "SET" }, { rows }];
                if (total !== undefined) results.push({ rows: [{ total }] });
                results.push({ command: "ROLLBACK" });
                return results;
            },
        };
        return { client, sent };
    }

    it("reads a page in a single round trip when the catalog entry is known", async () => {
        const { client, sent } = fakeClient([{ c0: "1", c1: "hello" }, { c0: "2", c1: null }]);
        const { page } = await fetchTableRows(client, { schema: "public", table: "orders", limit: 2, meta });

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatch(/^BEGIN READ ONLY; SET LOCAL statement_timeout = \d+; SELECT .* LIMIT 2 OFFSET 0; ROLLBACK$/);
        expect(page.rows).toEqual([["1", "hello"], ["2", null]]);
        expect(page.columns).toEqual([
            { name: "id", dataType: "integer", isPrimaryKey: true },
            { name: "note", dataType: "text", isPrimaryKey: false },
        ]);
        expect(page.estimatedTotal).toBe(1200);
    });

    it("asks for the exact count inside the same round trip", async () => {
        const { client, sent } = fakeClient([{ c0: "1", c1: "x" }], "1187");
        const { page } = await fetchTableRows(client, { schema: "public", table: "orders", exactCount: true, meta });

        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain('SELECT count(*)::text AS total FROM "public"."orders"');
        expect(page.exactTotal).toBe(1187);
    });

    it("flags truncated cells", async () => {
        const { client } = fakeClient([{ c0: "1", c1: "y".repeat(CELL_MAX_CHARS + 1) }]);
        const { page } = await fetchTableRows(client, { schema: "public", table: "orders", meta });

        expect(page.truncatedCells).toEqual([[0, 1]]);
        expect(page.rows[0][1]).toHaveLength(CELL_MAX_CHARS);
    });

    it("looks the relation up when it isn't cached, and reports an unknown one", async () => {
        const sent: string[] = [];
        const empty: Queryable = {
            async query(text: string) {
                sent.push(text);
                return [{ command: "BEGIN" }, { command: "SET" }, { rows: [] }, { command: "ROLLBACK" }];
            },
        };
        await expect(fetchTableRows(empty, { schema: "public", table: "nope" })).rejects.toThrow(/was not found/);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain("c.relname = 'nope'");
    });

    it("rejects a sort column that is not in the catalog entry without touching the database", async () => {
        const { client, sent } = fakeClient([]);
        await expect(fetchTableRows(client, { schema: "public", table: "orders", sort: "id; DROP TABLE orders", meta })).rejects.toThrow(DataRequestError);
        expect(sent).toHaveLength(0);
    });
});
