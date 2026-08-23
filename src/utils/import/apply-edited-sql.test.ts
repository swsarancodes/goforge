import { describe, it, expect, beforeAll } from "vitest";
import { init } from "@guanmingchiu/sqlparser-ts";

import { DatabaseDialect } from "@/lib/database";
import { ForeignKeyActions } from "@/lib/field";
import { getRenderer } from "@/utils/render/render-uttils";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { prepareSqlSchemaChange } from "@/utils/import/prepare-sql-schema-change";

// This exercises the exact pipeline SqlPreview's "apply edited SQL" button runs
// (parse -> reconcileWithDatabase -> normalizeDatabase/compare/mapDiffToDBDiffOperation),
// stopping short of the real executeDbDiffOps() DB write. It exists because a real bug
// slipped through reconcile-with-database.test.ts alone: reconcileWithDatabase produced
// well-shaped ids, but the tables/relationships it built were missing `databaseId` (NOT
// NULL, no default) - executeDbDiffOps() inserts operation.table/operation.relationship
// verbatim, so that constraint violation broke every "edit SQL, apply" round-trip that
// touched a new table or relationship.

const data_types = getDataTypes(DatabaseDialect.POSTGRES);

beforeAll(async () => {
    await init();
});

const buildOperations = async (draftSql: string, currentDatabase: DatabaseType) => {
    return (await prepareSqlSchemaChange(draftSql, currentDatabase, data_types)).operations;
};

/**
 * buildSampleDatabase() is a minimal fixture built for render.test.ts - it leaves
 * databaseId unset on tables, every field's sequence at 0, and relationship.name
 * null. A real, already-created table never looks like that (databaseId is always
 * set, sequence increments per field in creation order, and renderDDL's own
 * auto-generated constraint name gets adopted onto the relationship the first time
 * SQL is rendered for it). Hydrate those so this test reflects an actual no-op
 * "open edit, change nothing, click apply" - not an artifact of the fixture's gaps.
 */
const hydrateForRoundTrip = (db: DatabaseType): DatabaseType => {
    for (const table of db.tables) {
        table.databaseId = db.id;
        table.color = table.color ?? "#ff6363";
        table.note = null;
        table.createdAt = "2026-01-01T00:00:00.000Z";
        table.fields.forEach((field, index) => {
            field.sequence = index;
            field.note = null;
            field.defaultValue = field.defaultValue ?? null;
            field.maxLength = field.maxLength ?? null;
            field.unsigned = field.unsigned ?? false;
            field.isForeign = field.isForeign ?? false;
            field.zeroFill = field.zeroFill ?? false;
            field.precision = field.precision ?? null;
            field.scale = field.scale ?? null;
            field.charset = field.charset ?? null;
            field.collate = field.collate ?? null;
            field.values = field.values ?? null;
        });
    }
    for (const relationship of db.relationships) {
        relationship.name = relationship.name ?? `fk_${relationship.sourceTable.name}_${relationship.targetTable.name}`;
        relationship.sourceAliasName = null;
        relationship.targetAliasName = null;
        relationship.createdAt = "2026-01-01T00:00:00.000Z";
        relationship.onUpdate = relationship.onUpdate ?? ForeignKeyActions.NO_ACTION;
    }
    return db;
};

describe("apply-edited-sql pipeline (reconcile -> diff -> operations)", () => {
    it("produces no operations when clicking Apply without changing anything", async () => {
        // Mirrors the real SqlPreview flow exactly: the editor's starting content is
        // whatever renderDDL() actually outputs for the current database (not
        // hand-typed SQL, which can omit details renderDDL always includes - e.g.
        // SERIAL for an auto-increment column - and make an unrelated round-trip
        // gap look like a reconciliation bug).
        const current = hydrateForRoundTrip(buildSampleDatabase(DatabaseDialect.POSTGRES));
        const renderedSql = await getRenderer(DatabaseDialect.POSTGRES, data_types)!.renderDDL(current);

        const operations = await buildOperations(renderedSql, current);

        expect(operations.filter((op) => op.type !== "UPDATE_NUM_TABLES")).toHaveLength(0);
    });

    it("emits a CREATE_TABLE op with a real databaseId (not undefined) for a genuinely new table", async () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);

        const operations = await buildOperations(
            `
                CREATE TABLE users (
                    id integer PRIMARY KEY,
                    email varchar(255) NOT NULL UNIQUE,
                    status varchar(20) NOT NULL DEFAULT 'active'
                );
                CREATE TABLE posts (
                    id integer PRIMARY KEY,
                    user_id integer NOT NULL,
                    title varchar(255) NOT NULL,
                    CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                );
                CREATE TABLE comments (
                    id integer PRIMARY KEY,
                    body text NOT NULL
                );
            `,
            current,
        );

        const createTableOps = operations.filter((op) => op.type === "CREATE_TABLE") as Extract<(typeof operations)[number], { type: "CREATE_TABLE" }>[];
        const commentsOp = createTableOps.find((op) => op.table.name === "comments");

        expect(commentsOp).toBeTruthy();
        expect(commentsOp!.table.databaseId).toBe(current.id);
        expect(commentsOp!.table.databaseId).not.toBeUndefined();
    });

    it("does not delete existing tables that are unchanged in the edited SQL", async () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);

        const operations = await buildOperations(
            `
                CREATE TABLE users (
                    id integer PRIMARY KEY,
                    email varchar(255) NOT NULL UNIQUE,
                    status varchar(20) NOT NULL DEFAULT 'active'
                );
                CREATE TABLE posts (
                    id integer PRIMARY KEY,
                    user_id integer NOT NULL,
                    title varchar(255) NOT NULL,
                    CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                );
                CREATE TABLE comments (
                    id integer PRIMARY KEY,
                    body text NOT NULL
                );
            `,
            current,
        );

        expect(operations.some((op) => op.type === "DELETE_TABLE")).toBe(false);
    });

    it("classifies schema objects omitted from edited SQL as destructive changes", async () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const prepared = await prepareSqlSchemaChange(
            `
                CREATE TABLE users (
                    id integer PRIMARY KEY,
                    email varchar(255) NOT NULL UNIQUE,
                    status varchar(20) NOT NULL DEFAULT 'active'
                );
            `,
            current,
            data_types,
        );

        expect(prepared.destructiveOperations.some((operation) => operation.type === "DELETE_TABLE")).toBe(true);
    });

    it("imports pasted SQL into an empty database and updates its table count", async () => {
        const current: DatabaseType = {
            ...buildSampleDatabase(DatabaseDialect.POSTGRES),
            numOfTables: 0,
            tables: [],
            relationships: [],
        };

        const prepared = await prepareSqlSchemaChange(
            `
                CREATE TABLE customers (
                    id integer PRIMARY KEY,
                    email varchar(255) NOT NULL UNIQUE
                );
                CREATE TABLE orders (
                    id integer PRIMARY KEY,
                    customer_id integer NOT NULL,
                    CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
                );
            `,
            current,
            data_types,
        );

        expect(prepared.operations.filter((operation) => operation.type === "CREATE_TABLE")).toHaveLength(2);
        expect(prepared.operations).toContainEqual({
            type: "UPDATE_NUM_TABLES",
            value: 2,
        });
        expect(prepared.targetDatabase.tables[0].posX).toBeDefined();
        expect(prepared.targetDatabase.tables[1].posX).not.toBe(prepared.targetDatabase.tables[0].posX);
    });

    it("keeps PostgreSQL TIMESTAMPTZ distinct from TIMESTAMP", async () => {
        const current: DatabaseType = {
            ...buildSampleDatabase(DatabaseDialect.POSTGRES),
            numOfTables: 0,
            tables: [],
            relationships: [],
        };
        const prepared = await prepareSqlSchemaChange("CREATE TABLE events (created_at TIMESTAMPTZ NOT NULL);", current, data_types);
        const timestamptz = data_types.find((dataType) => dataType.name === "timestamptz");

        expect(prepared.targetDatabase.tables[0].fields[0].typeId).toBe(timestamptz?.id);
    });

    it("rejects blank pasted SQL with an actionable message", async () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);
        await expect(prepareSqlSchemaChange("   ", current, data_types)).rejects.toThrow("Paste or enter SQL before applying changes.");
    });
});
