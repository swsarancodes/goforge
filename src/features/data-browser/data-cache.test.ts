import { describe, expect, it } from "vitest";
import type { RelationInfo } from "@/lib/live-connection-api";
import { SwrCache, connectionPrefix, loadStoredRelations, pageKey, storeRelations, type StringStorage } from "./data-cache";

describe("pageKey", () => {
    const base = { connectionId: "c1", schema: "public", table: "users", offset: 0, pageSize: 50 };

    it("differs by connection, table, page, page size and sort", () => {
        const keys = new Set([
            pageKey(base),
            pageKey({ ...base, connectionId: "c2" }),
            pageKey({ ...base, table: "orders" }),
            pageKey({ ...base, schema: "analytics" }),
            pageKey({ ...base, offset: 50 }),
            pageKey({ ...base, pageSize: 100 }),
            pageKey({ ...base, sort: "id", dir: "asc" }),
            pageKey({ ...base, sort: "id", dir: "desc" }),
            pageKey({ ...base, sort: "name", dir: "asc" }),
        ]);
        expect(keys.size).toBe(9);
    });

    it("treats a missing direction as ascending and ignores a direction without a sort", () => {
        expect(pageKey({ ...base, sort: "id" })).toBe(pageKey({ ...base, sort: "id", dir: "asc" }));
        expect(pageKey({ ...base, dir: "desc" })).toBe(pageKey(base));
    });

    it("keeps table names containing dots distinct", () => {
        expect(pageKey({ ...base, schema: "public", table: "a.b" })).not.toBe(pageKey({ ...base, schema: "public.a", table: "b" }));
    });

    it("starts with the connection prefix", () => {
        expect(pageKey(base).startsWith(connectionPrefix("c1"))).toBe(true);
        expect(pageKey({ ...base, connectionId: "c10" }).startsWith(connectionPrefix("c1"))).toBe(false);
    });
});

describe("SwrCache", () => {
    it("reports entries as fresh for the fresh window, then stale but still usable", () => {
        let now = 0;
        const cache = new SwrCache<string>(10, 1_000, () => now);
        cache.set("a", "value");

        expect(cache.get("a")).toEqual({ value: "value", fresh: true });
        now = 1_000;
        expect(cache.get("a")?.fresh).toBe(true);
        now = 1_001;
        expect(cache.get("a")).toEqual({ value: "value", fresh: false });
    });

    it("returns undefined for unknown keys and replaces values on set", () => {
        const cache = new SwrCache<number>();
        expect(cache.get("missing")).toBeUndefined();
        cache.set("a", 1);
        cache.set("a", 2);
        expect(cache.get("a")?.value).toBe(2);
        expect(cache.size).toBe(1);
    });

    it("evicts the least recently used entry", () => {
        const cache = new SwrCache<number>(2);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.get("a"); // a is now the most recently used
        cache.set("c", 3);

        expect(cache.get("b")).toBeUndefined();
        expect(cache.get("a")?.value).toBe(1);
        expect(cache.get("c")?.value).toBe(3);
    });

    it("clears everything for one connection by prefix", () => {
        const cache = new SwrCache<number>();
        cache.set(pageKey({ connectionId: "c1", schema: "s", table: "t", offset: 0, pageSize: 50 }), 1);
        cache.set(pageKey({ connectionId: "c1", schema: "s", table: "u", offset: 0, pageSize: 50 }), 2);
        cache.set(pageKey({ connectionId: "c10", schema: "s", table: "t", offset: 0, pageSize: 50 }), 3);

        cache.deleteWithPrefix(connectionPrefix("c1"));

        expect(cache.size).toBe(1);
        expect(cache.get(pageKey({ connectionId: "c10", schema: "s", table: "t", offset: 0, pageSize: 50 }))?.value).toBe(3);
    });
});

describe("stored table lists", () => {
    const memoryStorage = (): StringStorage & { data: Map<string, string> } => {
        const data = new Map<string, string>();
        return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
    };
    const relations: RelationInfo[] = [
        { schema: "public", name: "users", kind: "table", estimatedRows: 208 },
        { schema: "public", name: "active_users", kind: "view", estimatedRows: null },
    ];

    it("round-trips per connection", () => {
        const storage = memoryStorage();
        storeRelations("c1", relations, storage);
        expect(loadStoredRelations("c1", storage)).toEqual(relations);
        expect(loadStoredRelations("c2", storage)).toBeUndefined();
    });

    it("ignores corrupt or wrongly shaped data", () => {
        const storage = memoryStorage();
        storage.setItem("goforge.relations.v1.c1", "{not json");
        expect(loadStoredRelations("c1", storage)).toBeUndefined();

        storage.setItem("goforge.relations.v1.c1", JSON.stringify([{ schema: "public" }]));
        expect(loadStoredRelations("c1", storage)).toBeUndefined();

        storage.setItem("goforge.relations.v1.c1", JSON.stringify({ not: "an array" }));
        expect(loadStoredRelations("c1", storage)).toBeUndefined();
    });

    it("never throws when storage is unavailable or full", () => {
        const throwing: StringStorage = {
            getItem() {
                throw new Error("blocked");
            },
            setItem() {
                throw new Error("quota");
            },
        };
        expect(() => storeRelations("c1", relations, throwing)).not.toThrow();
        expect(loadStoredRelations("c1", throwing)).toBeUndefined();
        expect(() => storeRelations("c1", relations, undefined)).not.toThrow();
        expect(loadStoredRelations("c1", undefined)).toBeUndefined();
    });
});
