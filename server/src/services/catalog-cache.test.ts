import { describe, expect, it } from "vitest";
import { CATALOG_TTL_MS, CatalogCache } from "./catalog-cache.js";
import type { RelationMeta } from "./pg-relations.js";

const meta = (schema: string, name: string): RelationMeta => ({ schema, name, kind: "table", relkind: "r", estimatedRows: null, columns: [], primaryKey: [] });

describe("CatalogCache", () => {
    it("returns what setAll stored, per connection", () => {
        const cache = new CatalogCache();
        cache.setAll("a", [meta("public", "users"), meta("analytics", "events")]);
        cache.setAll("b", [meta("public", "other")]);

        expect(cache.get("a", "public", "users")?.name).toBe("users");
        expect(cache.get("a", "analytics", "events")?.schema).toBe("analytics");
        expect(cache.get("a", "public", "other")).toBeUndefined();
        expect(cache.get("b", "public", "other")?.name).toBe("other");
    });

    it("setAll replaces everything known about the connection", () => {
        const cache = new CatalogCache();
        cache.setAll("a", [meta("public", "old")]);
        cache.setAll("a", [meta("public", "new")]);
        expect(cache.get("a", "public", "old")).toBeUndefined();
        expect(cache.get("a", "public", "new")).toBeDefined();
    });

    it("expires entries after the TTL", () => {
        let now = 1_000;
        const cache = new CatalogCache(() => now);
        cache.set("a", meta("public", "users"));

        now += CATALOG_TTL_MS;
        expect(cache.get("a", "public", "users")).toBeDefined();
        now += 1;
        expect(cache.get("a", "public", "users")).toBeUndefined();
    });

    it("deletes one relation or a whole connection", () => {
        const cache = new CatalogCache();
        cache.setAll("a", [meta("public", "x"), meta("public", "y")]);
        cache.delete("a", "public", "x");
        expect(cache.get("a", "public", "x")).toBeUndefined();
        expect(cache.get("a", "public", "y")).toBeDefined();

        cache.clear("a");
        expect(cache.get("a", "public", "y")).toBeUndefined();
    });

    it("keeps names containing dots distinct", () => {
        const cache = new CatalogCache();
        cache.setAll("a", [meta("public", "a.b"), meta("public.a", "b")]);
        expect(cache.get("a", "public", "a.b")?.name).toBe("a.b");
        expect(cache.get("a", "public.a", "b")?.schema).toBe("public.a");
    });
});
