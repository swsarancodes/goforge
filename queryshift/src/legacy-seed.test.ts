import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMapping, toLegacySeed } from "./legacy-seed";

const domain = resolve(import.meta.dirname, "../domain");
const mapping = parseMapping(readFileSync(resolve(domain, "schema_mapping.csv"), "utf8"));

describe("the seed under the legacy names", () => {
    it("renames the table and every column of an INSERT and leaves the values alone", () => {
        const out = toLegacySeed("INSERT INTO customers (customer_id, customer_name, email) VALUES\n    (1, 'Asha Rao', NULL);", mapping);
        expect(out).toBe("INSERT INTO CUST_MST (CUST_ID, CUST_NM, CUST_EMAIL) VALUES\n    (1, 'Asha Rao', NULL);");
    });

    it("maps every statement of both seeds, to tables and columns that exist in the legacy schema", () => {
        const legacy = readFileSync(resolve(domain, "legacy_schema.sql"), "utf8");
        for (const file of ["seed_target.sql", "seed_heldout.sql"]) {
            const seed = toLegacySeed(readFileSync(resolve(domain, file), "utf8"), mapping);
            const inserts = [...seed.matchAll(/INSERT INTO\s+(\w+)\s*\(([^)]*)\)/g)];
            expect(inserts.length).toBeGreaterThan(0);
            for (const [, table, columns] of inserts) {
                expect(legacy).toContain(`CREATE TABLE ${table} (`);
                for (const column of columns.split(",")) expect(legacy).toMatch(new RegExp(`\\b${column.trim()}\\b`));
            }
            expect(seed).not.toMatch(/INSERT INTO\s+(customers|policies|claims)\b/);
        }
    });

    it("refuses a table or a column the mapping does not have", () => {
        expect(() => toLegacySeed("INSERT INTO invoices (id) VALUES (1);", mapping)).toThrow(/does not map/);
        expect(() => toLegacySeed("INSERT INTO customers (nickname) VALUES ('x');", mapping)).toThrow(/customers\.nickname/);
    });
});
