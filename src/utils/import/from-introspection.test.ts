import { describe, expect, it } from "vitest";

import { DatabaseDialect } from "@/lib/database";
import { getDataTypes } from "@/test/fixtures/data-types";
import { IntrospectionResult } from "@/lib/live-connection-api";
import { fromIntrospection } from "@/utils/import/from-introspection";

describe("fromIntrospection", () => {
    it("groups composite foreign-key rows and preserves named unique constraints", () => {
        const result: IntrospectionResult = {
            tables: [
                {
                    name: "accounts",
                    columns: [
                        { name: "tenant_id", ordinalPosition: 1, udtName: "int4", maxLength: null, numericPrecision: 32, numericScale: 0, nullable: false, defaultValue: null, isIdentity: false, isSerial: false },
                        { name: "account_id", ordinalPosition: 2, udtName: "int4", maxLength: null, numericPrecision: 32, numericScale: 0, nullable: false, defaultValue: null, isIdentity: false, isSerial: false },
                        { name: "region", ordinalPosition: 3, udtName: "text", maxLength: null, numericPrecision: null, numericScale: null, nullable: false, defaultValue: null, isIdentity: false, isSerial: false },
                    ],
                    primaryKeyColumns: ["tenant_id", "account_id"],
                    uniqueConstraints: [{ name: "accounts_tenant_region_key", columns: ["tenant_id", "region"] }],
                },
                {
                    name: "account_events",
                    columns: [
                        { name: "tenant_id", ordinalPosition: 1, udtName: "int4", maxLength: null, numericPrecision: 32, numericScale: 0, nullable: false, defaultValue: null, isIdentity: false, isSerial: false },
                        { name: "account_id", ordinalPosition: 2, udtName: "int4", maxLength: null, numericPrecision: 32, numericScale: 0, nullable: false, defaultValue: null, isIdentity: false, isSerial: false },
                    ],
                    primaryKeyColumns: [],
                    uniqueConstraints: [],
                },
            ],
            foreignKeys: [
                { constraintName: "account_events_account_fk", sourceTable: "account_events", sourceColumn: "tenant_id", targetTable: "accounts", targetColumn: "tenant_id", onUpdate: "NO ACTION", onDelete: "CASCADE" },
                { constraintName: "account_events_account_fk", sourceTable: "account_events", sourceColumn: "account_id", targetTable: "accounts", targetColumn: "account_id", onUpdate: "NO ACTION", onDelete: "CASCADE" },
            ],
            indexes: [],
            enums: [],
            sequences: [{
                name: "order_seq",
                namespace: "reporting",
                definition: "START WITH 100 INCREMENT BY 5",
            }],
        };

        const parsed = fromIntrospection(result, getDataTypes(DatabaseDialect.POSTGRES));
        const relationship = parsed.relationships[0];

        expect(parsed.errors).toEqual([]);
        expect(parsed.relationships).toHaveLength(1);
        expect(relationship.cardinality).toBe("one_to_one");
        expect(relationship.relationshipFields).toHaveLength(1);
        expect(relationship.relationshipFields?.[0].sequence).toBe(1);
        expect(parsed.indexes).toContainEqual(expect.objectContaining({
            name: "accounts_tenant_region_key",
            unique: true,
        }));
        expect(parsed.sequences).toContainEqual(expect.objectContaining({
            name: "order_seq",
            namespace: "reporting",
            definition: "START WITH 100 INCREMENT BY 5",
        }));
    });

    it("maps CHECK constraints onto the table and skips unsafe ones", () => {
        const column = { ordinalPosition: 1, udtName: "int4", maxLength: null, numericPrecision: 32, numericScale: 0, nullable: false, defaultValue: null, isIdentity: false, isSerial: false };
        const result: IntrospectionResult = {
            tables: [{
                name: "products",
                columns: [{ name: "price", ...column }, { name: "qty", ...column, ordinalPosition: 2 }],
                primaryKeyColumns: [],
                uniqueConstraints: [],
                checkConstraints: [
                    { name: "products_price_check", expression: "price > 0" },
                    { name: "weird name", expression: "qty >= 0" },
                    { name: "bad", expression: "qty > 0; DROP TABLE x" },
                ],
            }],
            foreignKeys: [],
            indexes: [],
            enums: [],
        };

        const parsed = fromIntrospection(result, getDataTypes(DatabaseDialect.POSTGRES));
        const checks = parsed.tables[0].checks!;

        expect(checks.map((check) => [check.name, check.expression])).toEqual([
            ["products_price_check", "price > 0"],
            ["weird_name", "qty >= 0"],
        ]);
        expect(checks.every((check) => check.tableId === parsed.tables[0].id)).toBe(true);
        expect(parsed.errors.map((error) => error.message).join("\n")).toMatch(/Skipped CHECK constraint "bad"/);
    });

    it("tolerates servers that do not report check constraints", () => {
        const result: IntrospectionResult = {
            tables: [{ name: "t", columns: [], primaryKeyColumns: [], uniqueConstraints: [] }],
            foreignKeys: [],
            indexes: [],
            enums: [],
        };
        expect(fromIntrospection(result, getDataTypes(DatabaseDialect.POSTGRES)).tables[0].checks).toEqual([]);
    });
});
