import { describe, expect, it } from "vitest";
import { buildSearchIndex, selectScope } from "../../server/src/schema-change/retrieval";
import type { Catalog } from "../../server/src/schema-change/catalog";
import { BIG_TABLE_ROWS, generateSchema } from "./synthetic-schema";

const asCatalog = (schema: ReturnType<typeof generateSchema>): Catalog => ({
    serverVersionNum: 160000,
    serverVersion: "16.0",
    loadedAt: "2026-01-01T00:00:00Z",
    tables: schema.tables.map((table) => ({
        schema: table.schema, name: table.name, qualified: table.qualified, partitioned: false, partitionCount: 0, estimatedRows: table.rows, totalBytes: 0,
        columns: table.columns.map((column) => ({ name: column.name, type: column.type, notNull: column.notNull })), primaryKey: ["id"],
        foreignKeys: table.foreignKeys.map((fk) => ({ name: `${table.name}_${fk.column}_fkey`, columns: [fk.column], refSchema: fk.references.split(".")[0], refTable: fk.references.split(".")[1], refColumns: ["id"], validated: true })),
    })),
});

describe("the generated schemas the evaluation runs on", () => {
    it("have exactly the number of tables asked for, with unique qualified names, and are the same every time", () => {
        for (const size of [50, 300, 1000]) {
            const schema = generateSchema(size, 5);
            expect(schema.tables).toHaveLength(size);
            expect(new Set(schema.tables.map((t) => t.qualified)).size).toBe(size);
        }
        expect(generateSchema(300, 5).createSql).toEqual(generateSchema(300, 5).createSql);
        expect(generateSchema(300, 5).createSql).not.toEqual(generateSchema(300, 6).createSql);
    });

    it("only refer to tables and columns that exist, and populate children of populated parents", () => {
        const schema = generateSchema(300, 9);
        const byName = new Map(schema.tables.map((t) => [t.qualified, t]));
        for (const table of schema.tables) {
            const names = table.columns.map((c) => c.name);
            expect(new Set(names).size).toBe(names.length);
            for (const fk of table.foreignKeys) {
                expect(names).toContain(fk.column);
                expect(byName.has(fk.references)).toBe(true);
            }
            for (const index of table.indexes) for (const column of index.columns) expect(names).toContain(column);
            for (const column of table.columns) if (column.refersTo) expect(byName.has(column.refersTo)).toBe(true);
        }
        const populated = schema.tables.filter((t) => t.rows > 0 && t.role !== "hub");
        expect(populated.length).toBeGreaterThan(0);
        for (const table of populated) expect(table.rows).toBe(BIG_TABLE_ROWS);
        expect(schema.populateSql.length).toBe(schema.tables.filter((t) => t.rows > 0).length);
    });

    it("give retrieval something real to find: every table is found by its own words", () => {
        const schema = generateSchema(300, 3);
        const index = buildSearchIndex(asCatalog(schema));
        let found = 0;
        const roots = schema.tables.filter((t) => t.role === "root");
        for (const table of roots) {
            const phrase = [table.module, ...table.words].map((w) => w.replace(/_/g, " ")).join(" ");
            if (selectScope(index, `change the ${phrase} table`).tables.some((t) => t.qualified === table.qualified)) found++;
        }
        expect(found / roots.length).toBeGreaterThan(0.9);
    });
});
