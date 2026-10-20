import { describe, expect, it } from "vitest";
import { buildRelations, groupRelations, relationKey } from "./relations";

const table = (name: string, namespace?: string) => ({ name, namespace, columns: [], primaryKeyColumns: [], uniqueConstraints: [], checkConstraints: [] }) as never;

describe("buildRelations", () => {
    it("lists tables, defaulting a missing schema to public", () => {
        const relations = buildRelations({ tables: [table("users"), table("events", "analytics")], views: [] });
        expect(relations.map((r) => [r.schema, r.name, r.kind])).toEqual([
            ["analytics", "events", "table"],
            ["public", "users", "table"],
        ]);
    });

    it("lets a view win over the same name reported as a table", () => {
        const relations = buildRelations({
            tables: [table("orders"), table("orders_view")],
            views: [{ name: "orders_view", namespace: "public", materialized: false, definition: "" }],
        });
        expect(relations.filter((r) => r.name === "orders_view")).toEqual([
            { key: relationKey("public", "orders_view"), schema: "public", name: "orders_view", kind: "view" },
        ]);
        expect(relations).toHaveLength(2);
    });

    it("marks materialized views and tolerates a missing views list", () => {
        const withMv = buildRelations({ tables: [], views: [{ name: "mv", namespace: null, materialized: true, definition: "" }] });
        expect(withMv[0]).toMatchObject({ schema: "public", name: "mv", kind: "materialized view" });
        expect(buildRelations({ tables: [table("t")] } as never)).toHaveLength(1);
    });

    it("sorts by schema then name", () => {
        const relations = buildRelations({ tables: [table("b", "z"), table("b", "a"), table("a", "a")], views: [] });
        expect(relations.map((r) => `${r.schema}.${r.name}`)).toEqual(["a.a", "a.b", "z.b"]);
    });

    it("keeps names that contain dots or quotes distinct", () => {
        const relations = buildRelations({ tables: [table("a.b", "public"), table("b", "public.a")], views: [] });
        expect(new Set(relations.map((r) => r.key)).size).toBe(2);
    });
});

describe("groupRelations", () => {
    const relations = buildRelations({
        tables: [table("candidates"), table("claims"), table("users"), table("events", "analytics")],
        views: [],
    });

    it("groups by schema in order", () => {
        expect(groupRelations(relations).map(([schema, list]) => [schema, list.map((r) => r.name)])).toEqual([
            ["analytics", ["events"]],
            ["public", ["candidates", "claims", "users"]],
        ]);
    });

    it("filters case-insensitively on schema.name and drops empty groups", () => {
        expect(groupRelations(relations, "CLA").map(([schema, list]) => [schema, list.map((r) => r.name)])).toEqual([["public", ["claims"]]]);
        expect(groupRelations(relations, "analytics.ev").map(([schema]) => schema)).toEqual(["analytics"]);
        expect(groupRelations(relations, "  ").length).toBe(2);
        expect(groupRelations(relations, "nope")).toEqual([]);
    });
});
