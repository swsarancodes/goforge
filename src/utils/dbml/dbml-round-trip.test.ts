import { describe, expect, it } from "vitest";
import { DatabaseDialect } from "@/lib/database";
import { Cardinality } from "@/lib/schemas/relationship-schema";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import { getDataTypes } from "@/test/fixtures/data-types";
import { makeDatabase, makeTable, parse } from "@/test/fixtures/dbml-builders";
import { toDbml } from "./to-dbml";

describe("DBML round trip", () => {
    // Everything GoForge can express in DBML must survive project -> DBML -> project.
    const normalize = (dialect: DatabaseDialect, tables: any[], relationships: any[]) => {
        const types = getDataTypes(dialect);
        const typeName = (id: string) => types.find((dataType) => dataType.id === id)?.name;
        const fieldName = (fieldId: string) => {
            for (const table of tables) {
                const field = table.fields.find((candidate: any) => candidate.id === fieldId);
                if (field) return `${table.name}.${field.name}`;
            }
            return fieldId;
        };
        return {
            tables: tables.map((table) => ({
                name: table.name,
                namespace: table.namespace ?? null,
                note: table.note ?? null,
                color: table.color ?? null,
                fields: [...table.fields].sort((a: any, b: any) => a.sequence - b.sequence).map((field: any) => ({
                    name: field.name,
                    type: typeName(field.typeId),
                    isPrimary: !!field.isPrimary,
                    unique: !!field.unique,
                    nullable: !!field.nullable,
                    autoIncrement: !!field.autoIncrement,
                    maxLength: field.maxLength ?? null,
                    precision: field.precision ?? null,
                    scale: field.scale ?? null,
                    defaultValue: field.defaultValue ?? null,
                    note: field.note ?? null,
                    values: field.values ?? null,
                })),
                indices: (table.indices ?? []).map((index: any) => ({
                    name: index.name,
                    unique: !!index.unique,
                    columns: index.fieldIndices.map((fieldIndex: any) => fieldName(fieldIndex.fieldId)),
                })),
                checks: (table.checks ?? []).map((check: any) => ({ name: check.name, expression: check.expression })),
            })).sort((a, b) => a.name.localeCompare(b.name)),
            relationships: relationships.map((relationship) => {
                const flipped = relationship.cardinality === Cardinality.many_to_one;
                const pairs = [
                    [relationship.sourceFieldId, relationship.targetFieldId],
                    ...(relationship.relationshipFields ?? []).map((pair: any) => [pair.sourceFieldId, pair.targetFieldId]),
                ].map(([source, target]) => (flipped ? [fieldName(target), fieldName(source)] : [fieldName(source), fieldName(target)]));
                return {
                    name: relationship.name ?? null,
                    cardinality: flipped ? Cardinality.one_to_many : relationship.cardinality,
                    parentToChild: pairs,
                    onDelete: relationship.onDelete ?? "no_action",
                    onUpdate: relationship.onUpdate ?? "no_action",
                };
            }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        };
    };

    const roundTrip = async (dialect: DatabaseDialect, database: DatabaseType) => {
        const { dbml } = toDbml(database);
        const { file, warnings } = await parse(dbml, dialect);
        return { dbml, warnings, before: normalize(dialect, database.tables as any[], database.relationships as any[]), after: normalize(dialect, file.project.tables, file.project.relationships) };
    };

    const buildShop = (dialect: DatabaseDialect, withEnum: boolean) => {
        const users = makeTable(dialect, "users", [
            { name: "id", type: "integer", primary: true, autoIncrement: true },
            { name: "email", type: "varchar", maxLength: 255, unique: true, nullable: false, note: "login 'name'" },
            { name: "balance", type: dialect === DatabaseDialect.POSTGRES ? "numeric" : "decimal", precision: 10, scale: 2, defaultValue: "0" },
            { name: "bio", type: "text" },
            ...(withEnum ? [{ name: "state", type: "enum", values: ["active", "banned"], defaultValue: "active" }] : []),
        ], {
            note: "Accounts",
            color: "#336699",
            indices: [{ id: "i1", tableId: "users", name: "ix_email_balance", unique: true, fieldIndices: [{ id: "u1", indexId: "i1", fieldId: "users.email" }, { id: "u2", indexId: "i1", fieldId: "users.balance" }] }],
            checks: [{ id: "c1", tableId: "users", name: "chk_balance", expression: "balance >= 0" }],
        });
        const posts = makeTable(dialect, "posts", [
            { name: "id", type: "integer", primary: true },
            { name: "user_id", type: "integer", nullable: false },
            { name: "title", type: "varchar", maxLength: 120, nullable: false },
        ]);
        const tags = makeTable(dialect, "post_tags", [
            { name: "post_id", type: "integer", primary: true },
            { name: "tag_id", type: "integer", primary: true },
        ]);
        const claims = makeTable(dialect, "post_tag_claims", [
            { name: "id", type: "integer", primary: true },
            { name: "post_id", type: "integer" },
            { name: "tag_id", type: "integer" },
        ]);
        const relationships = [
            { id: "r1", name: "fk_posts_user", cardinality: Cardinality.one_to_many, sourceTableId: "users", targetTableId: "posts", sourceFieldId: "users.id", targetFieldId: "posts.user_id", onDelete: "cascade", onUpdate: "no_action", relationshipFields: [] },
            {
                id: "r2", name: null, cardinality: Cardinality.one_to_many, sourceTableId: "post_tags", targetTableId: "post_tag_claims",
                sourceFieldId: "post_tags.post_id", targetFieldId: "post_tag_claims.post_id", onDelete: "set_null", onUpdate: "restrict",
                relationshipFields: [{ id: "rf", relationshipId: "r2", sourceFieldId: "post_tags.tag_id", targetFieldId: "post_tag_claims.tag_id", sequence: 1 }],
            },
            // Stored the other way round: the foreign-key holder is the source.
            { id: "r3", name: "fk_claim_owner", cardinality: Cardinality.many_to_one, sourceTableId: "post_tag_claims", targetTableId: "users", sourceFieldId: "post_tag_claims.id", targetFieldId: "users.id", onDelete: "no_action", onUpdate: "no_action", relationshipFields: [] },
        ];
        return makeDatabase(dialect, [users, posts, tags, claims], relationships);
    };

    for (const [label, dialect, withEnum] of [
        ["PostgreSQL", DatabaseDialect.POSTGRES, true],
        ["MySQL", DatabaseDialect.MYSQL, true],
        ["MariaDB", DatabaseDialect.MARIADB, true],
    ] as const) {
        it(`keeps every supported property (${label})`, async () => {
            const { before, after, warnings } = await roundTrip(dialect, buildShop(dialect, withEnum));
            expect(warnings).toEqual([]);
            expect(after).toEqual(before);
        });
    }

    it("keeps multi-line notes and namespaces", async () => {
        const dialect = DatabaseDialect.POSTGRES;
        const table = makeTable(dialect, "events", [{ name: "id", type: "integer", primary: true, note: "first line\nsecond line" }], { namespace: "audit", note: "Line one\nLine two" });
        const { before, after } = await roundTrip(dialect, makeDatabase(dialect, [table]));
        expect(after).toEqual(before);
    });

    it("keeps names that need quoting", async () => {
        const dialect = DatabaseDialect.POSTGRES;
        const table = makeTable(dialect, "order items", [{ name: "unit price", type: "integer", primary: true }, { name: "double", type: "integer" }]);
        const { before, after } = await roundTrip(dialect, makeDatabase(dialect, [table]));
        expect(after).toEqual(before);
    });

    it("keeps types whose names contain spaces", async () => {
        const dialect = DatabaseDialect.POSTGRES;
        const table = makeTable(dialect, "m", [
            { name: "x", type: "double precision" },
            { name: "t", type: "double precision" },
        ]);
        const { before, after } = await roundTrip(dialect, makeDatabase(dialect, [table]));
        expect(after).toEqual(before);
    });
});
