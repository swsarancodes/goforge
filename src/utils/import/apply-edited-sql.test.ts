import { describe, it, expect, beforeAll } from "vitest";
import { init } from "@guanmingchiu/sqlparser-ts";
import { compare } from "fast-json-patch";

import { DatabaseDialect } from "@/lib/database";
import { getImporter } from "@/utils/import/import-utils";
import { getRenderer } from "@/utils/render/render-uttils";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { reconcileWithDatabase } from "@/utils/import/reconcile-with-database";
import { normalizeDatabase, mapDiffToDBDiffOperation } from "@/utils/database";
import { DatabaseType } from "@/lib/schemas/database-schema";

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

const buildOperations = (draftSql: string, currentDatabase: DatabaseType) => {
    const importer = getImporter(DatabaseDialect.POSTGRES, data_types)!;
    const parsed = importer.parseSql(draftSql);
    const reconciled = reconcileWithDatabase(parsed as any, currentDatabase);

    const targetDatabase: DatabaseType = {
        ...currentDatabase,
        tables: reconciled.tables.map((table) => ({
            ...table,
            indices: reconciled.indexes.filter((index) => index.tableId === table.id),
        })) as any,
        relationships: reconciled.relationships as any,
    };

    const differences = compare(normalizeDatabase(currentDatabase), normalizeDatabase(targetDatabase));
    return mapDiffToDBDiffOperation(differences);
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
        table.fields.forEach((field, index) => {
            field.sequence = index;
        });
    }
    for (const relationship of db.relationships) {
        relationship.name = relationship.name ?? `fk_${relationship.sourceTable.name}_${relationship.targetTable.name}`;
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

        const operations = buildOperations(renderedSql, current);

        expect(operations.filter((op) => op.type !== "UPDATE_NUM_TABLES")).toHaveLength(0);
    });

    it("emits a CREATE_TABLE op with a real databaseId (not undefined) for a genuinely new table", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);

        const operations = buildOperations(
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
            current
        );

        const createTableOps = operations.filter((op) => op.type === "CREATE_TABLE") as Extract<
            (typeof operations)[number],
            { type: "CREATE_TABLE" }
        >[];
        const commentsOp = createTableOps.find((op) => op.table.name === "comments");

        expect(commentsOp).toBeTruthy();
        expect(commentsOp!.table.databaseId).toBe(current.id);
        expect(commentsOp!.table.databaseId).not.toBeUndefined();
    });

    it("does not delete existing tables that are unchanged in the edited SQL", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);

        const operations = buildOperations(
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
            current
        );

        expect(operations.some((op) => op.type === "DELETE_TABLE")).toBe(false);
    });
});
