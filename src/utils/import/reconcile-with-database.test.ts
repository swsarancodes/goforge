import { describe, it, expect, beforeAll } from "vitest";
import { init } from "@guanmingchiu/sqlparser-ts";

import { DatabaseDialect } from "@/lib/database";
import { getImporter } from "@/utils/import/import-utils";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { reconcileWithDatabase } from "@/utils/import/reconcile-with-database";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { TableType } from "@/lib/schemas/table-schema";

// The parser is a WASM module whose init() is async - see import.test.ts for the
// same setup and why it's needed before any parseSql() call.
beforeAll(async () => {
    await init();
});

// reconcileWithDatabase() is what makes "edit the SQL, apply it" behave like an
// incremental update instead of a full reset: BaseSqlImporter.parseSql() always
// mints brand new ids, so without this step every existing table/field would look
// deleted and every parsed one would look newly created - wiping positions/colors
// and losing edit history. This matches parsed entities back to existing ones by
// name and reuses their ids.

const data_types = getDataTypes(DatabaseDialect.POSTGRES);

const parseSql = (sql: string) => getImporter(DatabaseDialect.POSTGRES, data_types)!.parseSql(sql);

describe("reconcileWithDatabase", () => {
    it("reuses the existing table id for a table with the same name", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const usersTable = current.tables.find((t) => t.name === "users")!;
        usersTable.posX = 123;
        usersTable.posY = 456;
        usersTable.color = "#ff6363";

        const parsed = parseSql(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'active',
                nickname VARCHAR(50)
            );
        `);

        const reconciled = reconcileWithDatabase(parsed as any, current);
        const reconciledUsers = reconciled.tables.find((t) => t.name === "users")!;

        expect(reconciledUsers.id).toBe(usersTable.id);
        // Position/color must survive an edit-and-apply round-trip.
        expect(reconciledUsers.posX).toBe(123);
        expect(reconciledUsers.posY).toBe(456);
        expect(reconciledUsers.color).toBe("#ff6363");

        // Existing columns keep their ids...
        const emailField = usersTable.fields.find((f) => f.name === "email")!;
        const reconciledEmail = reconciledUsers.fields!.find((f) => f.name === "email")!;
        expect(reconciledEmail.id).toBe(emailField.id);

        // ...and a genuinely new column gets a fresh id, not confused with any existing one.
        const reconciledNickname = reconciledUsers.fields!.find((f) => f.name === "nickname")!;
        expect(reconciledNickname.id).not.toBe(emailField.id);
        const existingIds = new Set(usersTable.fields.map((f) => f.id));
        expect(existingIds.has(reconciledNickname.id as string)).toBe(false);
    });

    it("gives a genuinely new table a fresh id, not confused with an existing one", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);

        const parsed = parseSql(`
            CREATE TABLE comments (
                id INTEGER PRIMARY KEY,
                body TEXT NOT NULL
            );
        `);

        const reconciled = reconcileWithDatabase(parsed as any, current);
        const existingIds = new Set(current.tables.map((t) => t.id));

        expect(reconciled.tables).toHaveLength(1);
        expect(existingIds.has(reconciled.tables[0].id as string)).toBe(false);
    });

    it("sets databaseId on every table and relationship - executeDbDiffOps inserts these verbatim, and databaseId is NOT NULL", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);

        const parsed = parseSql(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'active'
            );
            CREATE TABLE comments (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                body TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
        `);

        const reconciled = reconcileWithDatabase(parsed as any, current);

        for (const table of reconciled.tables) {
            expect(table.databaseId).toBe(current.id);
        }
        for (const relationship of reconciled.relationships) {
            expect(relationship.databaseId).toBe(current.id);
        }
    });

    it("remaps a relationship's table/field ids to the reconciled ones and reuses its id when unchanged", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const existingRelationship = current.relationships[0];

        const parsed = parseSql(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'active'
            );
            CREATE TABLE posts (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                title VARCHAR(255) NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        `);

        const reconciled = reconcileWithDatabase(parsed as any, current);
        const usersTable = current.tables.find((t: TableType) => t.name === "users")!;
        const postsTable = current.tables.find((t: TableType) => t.name === "posts")!;

        expect(reconciled.relationships).toHaveLength(1);
        const rel = reconciled.relationships[0];
        expect(rel.id).toBe(existingRelationship.id);
        expect(rel.sourceTableId).toBe(usersTable.id);
        expect(rel.targetTableId).toBe(postsTable.id);
    });

    it("produces no id changes at all when the parsed SQL exactly matches the current database", () => {
        const current: DatabaseType = buildSampleDatabase(DatabaseDialect.POSTGRES);

        const parsed = parseSql(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'active'
            );
            CREATE TABLE posts (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                title VARCHAR(255) NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        `);

        const reconciled = reconcileWithDatabase(parsed as any, current);
        const reconciledIds = reconciled.tables.map((t) => t.id).sort();
        const currentIds = current.tables.map((t) => t.id).sort();

        expect(reconciledIds).toEqual(currentIds);
    });
});
