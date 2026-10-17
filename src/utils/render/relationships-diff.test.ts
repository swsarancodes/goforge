import _ from "lodash";
import { describe, expect, it } from "vitest";
import { DatabaseDialect } from "@/lib/database";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { getRenderer } from "./render-uttils";

const dialect = DatabaseDialect.POSTGRES;
const types = getDataTypes(dialect);
const renderer = () => getRenderer(dialect, types)!;

const stored = (): DatabaseType => {
    const database = buildSampleDatabase(dialect);
    for (const table of database.tables) {
        table.databaseId = database.id;
        table.fields.forEach((field, index) => { field.sequence = index; field.isForeign = false; field.type = types.find((type) => type.id === field.typeId)!; });
    }
    database.relationships[0].name = "fk_posts_user";
    database.relationships[0].onUpdate = "no_action";
    return database;
};

describe("PostgreSQL diff: constraints and indexes", () => {
    it("drops a foreign key that was removed", async () => {
        const before = stored();
        const after = _.cloneDeep(before);
        after.relationships = [];
        const sql = await renderer().renderDiffDDL(after, before);
        expect(sql).toMatch(/ALTER TABLE\s+"?posts"?\s+DROP CONSTRAINT\s+"?fk_posts_user"?/i);
    });

    it("drops the foreign key before the table it points at", async () => {
        const before = stored();
        const after = _.cloneDeep(before);
        after.tables = after.tables.filter((table) => table.id !== "users");
        after.relationships = [];
        const sql = await renderer().renderDiffDDL(after, before);
        expect(sql.indexOf("DROP CONSTRAINT")).toBeGreaterThanOrEqual(0);
        expect(sql.indexOf("DROP CONSTRAINT")).toBeLessThan(sql.search(/DROP TABLE/i));
    });

    it("recreates a foreign key whose action changed", async () => {
        const before = stored();
        const after = _.cloneDeep(before);
        after.relationships[0].onDelete = "set_null";
        const sql = await renderer().renderDiffDDL(after, before);
        expect(sql).toMatch(/DROP CONSTRAINT/i);
        expect(sql).toMatch(/ADD CONSTRAINT/i);
        expect(sql).toMatch(/ON DELETE SET NULL/i);
        expect(sql.search(/DROP CONSTRAINT/i)).toBeLessThan(sql.search(/ADD CONSTRAINT/i));
    });

    it("does not touch a foreign key when only its alias changes", async () => {
        const before = stored();
        const after = _.cloneDeep(before);
        after.relationships[0].sourceAliasName = "owner";
        expect((await renderer().renderDiffDDL(after, before)).trim()).toBe("");
    });

    const withIndex = (unique: boolean, fieldIds: string[]) => {
        const database = stored();
        database.tables[1].indices = [{
            id: "ix_title", tableId: "posts", name: "ix_title", unique, createdAt: null,
            fieldIndices: fieldIds.map((fieldId, index) => ({ id: `fi${index}`, indexId: "ix_title", fieldId })),
        } as any];
        return database;
    };

    it("recreates an index that became unique", async () => {
        const sql = await renderer().renderDiffDDL(withIndex(true, ["posts.title"]), withIndex(false, ["posts.title"]));
        expect(sql).toMatch(/DROP INDEX/i);
        expect(sql).toMatch(/CREATE UNIQUE INDEX/i);
    });

    it("recreates an index whose columns changed", async () => {
        const sql = await renderer().renderDiffDDL(withIndex(false, ["posts.title", "posts.user_id"]), withIndex(false, ["posts.title"]));
        expect(sql).toMatch(/DROP INDEX/i);
        expect(sql).toMatch(/CREATE INDEX/i);
        expect(sql).toMatch(/user_id/);
    });
});

describe("unsupported operations", () => {
    const addColumn = (database: DatabaseType) => {
        const copy = _.cloneDeep(database);
        const users = copy.tables[0];
        users.fields.push({ ...users.fields[2], id: "users.age", name: "age", sequence: 3 });
        return copy;
    };

    it("PostgreSQL can render every schema change here", () => {
        const before = stored();
        const operations = renderer().prepareDiff(addColumn(before), before);
        expect(renderer().unsupportedOperations(operations)).toEqual([]);
    });

    for (const other of [DatabaseDialect.MYSQL, DatabaseDialect.MARIADB, DatabaseDialect.MSSQL, DatabaseDialect.ORACLE, DatabaseDialect.SQLITE]) {
        it(`${other} reports an added column instead of silently omitting it`, () => {
            const otherTypes = getDataTypes(other);
            const before = buildSampleDatabase(other);
            for (const table of before.tables) {
                table.databaseId = before.id;
                table.fields.forEach((field, index) => { field.sequence = index; field.type = otherTypes.find((type) => type.id === field.typeId)!; });
            }
            const after = addColumn(before);
            const unsupported = getRenderer(other, otherTypes)!.unsupportedOperations(getRenderer(other, otherTypes)!.prepareDiff(after, before));
            expect(unsupported.map((operation) => operation.type)).toEqual(["CREATE_FIELD"]);
        });
    }

    it("ignores layout-only edits", () => {
        const before = stored();
        const after = _.cloneDeep(before);
        after.tables[0].posX = 400;
        after.tables[0].color = "#abcdef";
        after.tables[0].fields[0].note = "changed note";
        expect(renderer().unsupportedOperations(renderer().prepareDiff(after, before))).toEqual([]);
    });
});
