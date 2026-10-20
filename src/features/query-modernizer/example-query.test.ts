import { describe, expect, it } from "vitest";
import { checkPostgresSyntax } from "./engine/checks";
import { convertQuery } from "./engine/convert";
import { buildExampleQuery } from "./example-query";
import { LEGACY_DIALECTS, type SchemaContext } from "./types";

const shop: SchemaContext = {
    tables: [
        { name: "customers", columns: [{ name: "id", type: "integer", isPrimary: true, nullable: false }, { name: "full_name", type: "text", nullable: false }, { name: "region", type: "text", nullable: true }] },
        {
            name: "orders",
            columns: [
                { name: "id", type: "integer", isPrimary: true, nullable: false },
                { name: "customer_id", type: "integer", nullable: false },
                { name: "discount", type: "numeric", nullable: true },
                { name: "note", type: "text", nullable: true },
                { name: "placed_at", type: "timestamp", nullable: false },
            ],
        },
    ],
    relationships: [{ fromTable: "orders", fromColumn: "customer_id", toTable: "customers", toColumn: "id" }],
};

const clinic: SchemaContext = {
    tables: [{ name: "patient visits", columns: [{ name: "visit_no", type: "bigint", isPrimary: true }, { name: "ward", type: "varchar", nullable: true }, { name: "stay_days", type: "integer", nullable: true }, { name: "date", type: "date" }] }],
};

describe("buildExampleQuery", () => {
    it("is nothing at all when there are no tables", () => {
        for (const { value } of LEGACY_DIALECTS) {
            expect(buildExampleQuery({ dialect: value })).toBeUndefined();
            expect(buildExampleQuery({ dialect: value, schema: { tables: [] } })).toBeUndefined();
        }
    });

    it("is written from the user's own tables and columns", () => {
        const query = buildExampleQuery({ dialect: "oracle", schema: shop })!;
        expect(query).toContain("orders");
        expect(query).toContain("customers");
        expect(query).toContain("a.customer_id = b.id(+)");
        expect(query).toContain("NVL(a.discount, 0)");
        expect(query).toContain("a.placed_at < SYSDATE");
        expect(query).toContain("ROWNUM <= 10");
        // and not from anyone else's
        expect(query).not.toMatch(/patient|visit|ward/);
        expect(buildExampleQuery({ dialect: "oracle", schema: clinic })).not.toMatch(/orders|customers|discount/);
    });

    it("speaks each source dialect's idioms", () => {
        expect(buildExampleQuery({ dialect: "mssql", schema: shop })).toMatch(/SELECT TOP 10 a\.\[id\],\s+ISNULL\(a\.\[discount\], 0\)[\s\S]*FROM \[dbo\]\.\[orders\] a WITH \(NOLOCK\)\nLEFT JOIN \[dbo\]\.\[customers\] b ON a\.\[customer_id\] = b\.\[id\]/);
        expect(buildExampleQuery({ dialect: "mysql", schema: shop })).toMatch(/IFNULL\(a\.`discount`, 0\)[\s\S]*NOW\(\)[\s\S]*LIMIT 0, 10$/);
        expect(buildExampleQuery({ dialect: "db2", schema: shop })).toMatch(/VALUE\(a\.discount, 0\)[\s\S]*CURRENT TIMESTAMP[\s\S]*FETCH FIRST 10 ROWS ONLY\nWITH UR$/);
    });

    it("changes when the dialect changes and is the same every time", () => {
        const all = LEGACY_DIALECTS.map(({ value }) => buildExampleQuery({ dialect: value, schema: shop }));
        expect(new Set(all).size).toBe(4);
        expect(buildExampleQuery({ dialect: "oracle", schema: shop })).toBe(buildExampleQuery({ dialect: "oracle", schema: shop }));
    });

    it("works with a single table, quotes awkward names, and leaves out what the table doesn't have", () => {
        const query = buildExampleQuery({ dialect: "oracle", schema: clinic })!;
        expect(query).toContain('FROM "patient visits" a');
        expect(query).toContain('a."date" < SYSDATE');
        expect(query).not.toContain("(+)");
        const bare = buildExampleQuery({ dialect: "oracle", schema: { tables: [{ name: "t", columns: [{ name: "id", type: "integer", isPrimary: true }] }] } })!;
        expect(bare).toBe("SELECT a.id\nFROM t a\nWHERE ROWNUM <= 10");
    });

    it("always converts cleanly with the Modernizer itself, so the demonstration works when Tab is pressed", async () => {
        for (const schema of [shop, clinic]) {
            for (const { value } of LEGACY_DIALECTS) {
                const example = buildExampleQuery({ dialect: value, schema })!;
                const result = convertQuery({ sql: example, dialect: value, schema });
                expect(result.syntaxError, example).toBeUndefined();
                expect(result.unconverted, example).toEqual([]);
                expect(result.applied.length, example).toBeGreaterThan(2);
                expect((await checkPostgresSyntax(result.validationSql)).ok, result.sql).toBe(true);
            }
        }
    });
});
