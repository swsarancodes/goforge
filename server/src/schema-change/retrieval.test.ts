import { describe, expect, it } from "vitest";
import type { Catalog, CatalogTable } from "./catalog.js";
import { buildSearchIndex, selectScope, singular, tokenize, withinOneEdit } from "./retrieval.js";

const table = (qualified: string, columns: string[], references: string[] = [], rows: number | null = 1000): CatalogTable => {
    const [schema, name] = qualified.split(".");
    return {
        schema,
        name,
        qualified,
        partitioned: false,
        partitionCount: 0,
        estimatedRows: rows,
        totalBytes: 8192,
        columns: columns.map((column) => ({ name: column, type: "integer", notNull: false })),
        primaryKey: ["id"],
        foreignKeys: references.map((target, index) => ({
            name: `${name}_fk${index}`,
            columns: [`${target.split(".")[1]}_id`],
            refSchema: target.split(".")[0],
            refTable: target.split(".")[1],
            refColumns: ["id"],
            validated: true,
        })),
    };
};

const catalogOf = (...tables: CatalogTable[]): Catalog => ({ serverVersionNum: 160000, serverVersion: "16.0", loadedAt: "2026-01-01T00:00:00Z", tables });

const shop = catalogOf(
    table("public.customers", ["id", "email", "created_at"]),
    table("public.orders", ["id", "customer_id", "status", "shipped_at", "created_at"], ["public.customers"]),
    table("public.order_items", ["id", "order_id", "product_id", "quantity"], ["public.orders", "public.products"]),
    table("public.products", ["id", "sku", "title", "created_at"]),
    table("public.categories", ["id", "title"]),
    table("public.audit_log", ["id", "actor", "created_at"]),
    table("billing.invoices", ["id", "order_id", "due_date", "created_at"], ["public.orders"]),
    table("billing.invoice_lines", ["id", "invoice_id", "amount"], ["billing.invoices"]),
);

const names = (request: string, catalog = shop, options = {}) => selectScope(buildSearchIndex(catalog), request, options).tables.map((t) => t.qualified);

describe("tokenize and singular", () => {
    it("splits snake_case, camelCase and punctuation", () => {
        expect(tokenize("order_items")).toEqual(["order", "items"]);
        expect(tokenize("OrderItems")).toEqual(["order", "items"]);
        expect(tokenize("billing.invoices, please!")).toEqual(["billing", "invoices", "please"]);
        expect(tokenize("HTTPServer2")).toEqual(["http", "server"]);
    });

    it("turns plurals into singulars without breaking words that only look plural", () => {
        expect(singular("orders")).toBe("order");
        expect(singular("categories")).toBe("category");
        expect(singular("addresses")).toBe("address");
        expect(singular("boxes")).toBe("box");
        expect(singular("status")).toBe("status");
        expect(singular("address")).toBe("address");
        expect(singular("analysis")).toBe("analysis");
    });

    it("recognises one typo", () => {
        expect(withinOneEdit("invoice", "invoce")).toBe(true);
        expect(withinOneEdit("invoice", "invocie")).toBe(true);
        expect(withinOneEdit("invoice", "invoicee")).toBe(true);
        expect(withinOneEdit("invoice", "invoyce")).toBe(true);
        expect(withinOneEdit("invoice", "invites")).toBe(false);
    });
});

describe("selectScope", () => {
    it("finds the table a request names, in singular or plural, and adds its foreign-key neighbours", () => {
        const scope = selectScope(buildSearchIndex(shop), "add a shipping note to the order table");
        const byName = new Map(scope.tables.map((t) => [t.qualified, t]));
        expect(byName.get("public.orders")?.origin).toBe("match");
        expect(byName.get("public.orders")?.reasons[0]).toEqual({ kind: "name", words: ["order"] });
        // the table orders points at, and the tables that point at orders
        expect(byName.get("public.customers")).toMatchObject({ origin: "neighbour", reasons: [{ kind: "referenced-by", from: "public.orders" }] });
        expect(byName.get("public.order_items")).toMatchObject({ origin: "neighbour", reasons: [{ kind: "references", from: "public.orders" }] });
    });

    it("prefers a table whose whole name is in the request over tables that share one word", () => {
        const scope = names("index order items by product", shop, { maxSeeds: 1 });
        expect(scope[0]).toBe("public.order_items");
    });

    it("matches the words of a compound name written as one word, and qualified names", () => {
        expect(names("add a column to invoicelines", shop, { maxSeeds: 1 })[0]).toBe("billing.invoice_lines");
        expect(names("change billing.invoices", shop, { maxSeeds: 1 })[0]).toBe("billing.invoices");
    });

    it("finds a table through one of its columns when the request names no table", () => {
        const scope = selectScope(buildSearchIndex(shop), "make sure shipped at is never empty");
        const orders = scope.tables.find((t) => t.qualified === "public.orders");
        expect(orders?.origin).toBe("match");
        expect(orders?.reasons).toContainEqual({ kind: "column", columns: ["shipped_at"] });
    });

    it("forgives one typo in a word of five letters or more", () => {
        expect(names("add an index to invoces", shop, { maxSeeds: 1 })[0]).toBe("billing.invoices");
        // short words are not fuzzy-matched
        expect(names("orde", shop)).toEqual([]);
    });

    it("does not select a table because of a column every table has", () => {
        const scope = names("add created at to the audit log", shop, { maxSeeds: 1 });
        expect(scope[0]).toBe("public.audit_log");
    });

    it("returns nothing when no word matches, rather than guessing", () => {
        const scope = selectScope(buildSearchIndex(shop), "please do the thing");
        expect(scope.tables).toEqual([]);
        expect(scope.matched).toBe(0);
    });

    it("caps the scope, and says when more tables matched than were kept", () => {
        const many = catalogOf(...Array.from({ length: 30 }, (_, i) => table(`public.event_${i}`, ["id", "payload"])));
        const scope = selectScope(buildSearchIndex(many), "add a column to every event table", { maxSeeds: 5, maxTables: 8 });
        expect(scope.tables).toHaveLength(5);
        expect(scope.matched).toBe(30);
        expect(scope.truncated).toBe(true);
    });

    it("limits how many tables that reference a matched table are pulled in", () => {
        const hub = catalogOf(
            table("public.users", ["id"]),
            ...Array.from({ length: 12 }, (_, i) => table(`public.thing_${i}`, ["id", "user_id"], ["public.users"], 10 + i)),
        );
        const scope = selectScope(buildSearchIndex(hub), "rename the users email", { childrenPerSeed: 3 });
        expect(scope.tables).toHaveLength(4);
        // the larger tables first when nothing else tells them apart
        expect(scope.tables.slice(1).map((t) => t.qualified)).toEqual(["public.thing_11", "public.thing_10", "public.thing_9"]);
    });

    it("never exceeds maxTables, even with neighbours", () => {
        expect(names("orders", shop, { maxTables: 2 })).toHaveLength(2);
    });

    it("gives the same answer every time", () => {
        const index = buildSearchIndex(shop);
        expect(selectScope(index, "change orders and invoices")).toEqual(selectScope(index, "change orders and invoices"));
    });
});
