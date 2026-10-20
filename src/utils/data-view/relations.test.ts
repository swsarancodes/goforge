import { describe, expect, it } from "vitest";
import type { RelationInfo } from "@/lib/live-connection-api";
import { buildRelations, formatRowEstimate, groupRelations, relationKey } from "./relations";

const info = (name: string, schema = "public", kind: RelationInfo["kind"] = "table", estimatedRows: number | null = null): RelationInfo => ({ schema, name, kind, estimatedRows });

describe("buildRelations", () => {
    it("adds a key and keeps the server's fields", () => {
        const [relation] = buildRelations([info("users", "public", "table", 208)]);
        expect(relation).toEqual({ key: relationKey("public", "users"), schema: "public", name: "users", kind: "table", estimatedRows: 208 });
    });

    it("sorts by schema then name without mutating the input", () => {
        const input = [info("b", "z"), info("b", "a"), info("a", "a")];
        expect(buildRelations(input).map((r) => `${r.schema}.${r.name}`)).toEqual(["a.a", "a.b", "z.b"]);
        expect(input.map((r) => r.schema)).toEqual(["z", "a", "a"]);
    });

    it("keeps names that contain dots or quotes distinct", () => {
        const relations = buildRelations([info("a.b", "public"), info("b", "public.a")]);
        expect(new Set(relations.map((r) => r.key)).size).toBe(2);
    });

    it("keeps views, materialized views and foreign tables as reported", () => {
        const kinds = buildRelations([info("v", "public", "view"), info("m", "public", "materialized view"), info("f", "public", "foreign table")]).map((r) => r.kind);
        expect(kinds).toEqual(["foreign table", "materialized view", "view"]);
    });
});

describe("groupRelations", () => {
    const relations = buildRelations([info("candidates"), info("claims"), info("users"), info("events", "analytics")]);

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

describe("formatRowEstimate", () => {
    it.each([
        [null, ""],
        [-1, ""],
        [0, "~0"],
        [208, "~208"],
        [999, "~999"],
        [1_000, "~1k"],
        [1_234, "~1.2k"],
        [9_000, "~9k"],
        [9_300, "~9.3k"],
        [12_400, "~12k"],
        [340_000, "~340k"],
        [1_000_000, "~1M"],
        [3_400_000, "~3.4M"],
    ])("%s -> %s", (rows, label) => {
        expect(formatRowEstimate(rows as number | null)).toBe(label);
    });
});
