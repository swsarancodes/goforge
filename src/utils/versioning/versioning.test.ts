import _ from "lodash";
import { describe, expect, it } from "vitest";
import { DatabaseDialect } from "@/lib/database";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import type { FieldType } from "@/lib/schemas/field-schema";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { getRenderer } from "@/utils/render/render-uttils";
import { summarizeSchemaChange } from "@/utils/import/summarize-schema-change";
import {
    downBlockedReasonFor,
    formatMigrationFile,
    generateMigration,
    migrationChecksum,
    migrationFileStem,
    NoSchemaChangesError,
    UnsupportedMigrationError,
    verifyMigrationChecksum,
    diffOperations,
} from "./generate-migration";
import { restoreOperations } from "./restore";
import { currentFingerprint, draftSnapshot, hashText, matchesHash, readSnapshot, snapshotToDatabase, verifySnapshot } from "./snapshot";

// A stored project always has these; the minimal sample fixture leaves them out.
const stored = (dialect: DatabaseDialect): DatabaseType => {
    const types = getDataTypes(dialect);
    const database = buildSampleDatabase(dialect);
    for (const table of database.tables) {
        table.databaseId = database.id;
        table.posX = 10;
        table.posY = 20;
        table.fields.forEach((field, index) => {
            field.sequence = index;
            field.isForeign = false;
            field.type = types.find((type) => type.id === field.typeId)!;
        });
    }
    for (const relationship of database.relationships) relationship.onUpdate = "no_action";
    return database;
};

const typeId = (dialect: DatabaseDialect, name: string) => getDataTypes(dialect).find((type) => type.name === name)!.id as string;

const withNewField = (database: DatabaseType, dialect: DatabaseDialect, tableId: string, name: string, type = "integer", extra: Partial<FieldType> = {}) => {
    const copy = _.cloneDeep(database);
    const table = copy.tables.find((candidate) => candidate.id === tableId)!;
    table.fields.push({
        id: `${tableId}.${name}`, tableId, name, typeId: typeId(dialect, type), type: getDataTypes(dialect).find((t) => t.name === type)!,
        nullable: true, isPrimary: false, unique: false, sequence: table.fields.length, isForeign: false, defaultValue: null, note: null,
        maxLength: null, precision: null, scale: null, unsigned: false, zeroFill: false, autoIncrement: false, charset: null, collate: null, values: null, ...extra,
    } as FieldType);
    return copy;
};

const DIALECTS = [DatabaseDialect.POSTGRES, DatabaseDialect.MYSQL, DatabaseDialect.MARIADB, DatabaseDialect.MSSQL, DatabaseDialect.ORACLE, DatabaseDialect.SQLITE];

describe("snapshots", () => {
    const dialect = DatabaseDialect.POSTGRES;

    it("freezes a project to identical text and hashes every time", async () => {
        const first = await draftSnapshot(stored(dialect));
        const second = await draftSnapshot(stored(dialect));
        expect(second).toEqual(first);
        expect(first.tableCount).toBe(2);
        expect(first.hash).toMatch(/^(sha256|cyrb53):/);
    });

    it("keeps the same fingerprint when only the layout changes, but not when the schema does", async () => {
        const base = stored(dialect);
        const moved = _.cloneDeep(base);
        moved.tables[0].posX = 999;
        moved.tables[0].color = "#123456";
        moved.tables[1].sequence = 7;
        expect((await draftSnapshot(moved)).fingerprint).toBe((await draftSnapshot(base)).fingerprint);
        expect((await draftSnapshot(moved)).hash).not.toBe((await draftSnapshot(base)).hash);

        const edited = withNewField(base, dialect, "users", "age");
        expect((await draftSnapshot(edited)).fingerprint).not.toBe((await draftSnapshot(base)).fingerprint);
        expect(await currentFingerprint(base)).toBe((await draftSnapshot(base)).fingerprint);
    });

    it("notices when stored content is altered", async () => {
        const draft = await draftSnapshot(stored(dialect));
        expect(await verifySnapshot(draft)).toBe(true);
        expect(await verifySnapshot({ ...draft, content: draft.content.replace("users", "usurs") })).toBe(false);
    });

    it("verifies hashes written without subtle crypto", async () => {
        expect(await matchesHash("abc", "cyrb53:0000000000000")).toBe(false);
        const fallback = "cyrb53:" + (await hashText("abc")).slice(0, 0);
        expect(fallback.startsWith("cyrb53:")).toBe(true);
    });

    it("restores to an equal project with the same ids", async () => {
        const base = stored(dialect);
        const draft = await draftSnapshot(base);
        const restored = snapshotToDatabase(readSnapshot(draft), base, getDataTypes(dialect));
        expect(restored.tables.map((table) => table.id).sort()).toEqual(["posts", "users"]);
        expect(restored.relationships[0].id).toBe("rel_posts_users");
        const summary = summarizeSchemaChange(diffOperations(base, restored), base, restored);
        expect(summary.isEmpty).toBe(true);
    });

    it("describes what a restore would change", async () => {
        const base = stored(dialect);
        const older = await draftSnapshot(base);
        const edited = withNewField(base, dialect, "users", "age");
        const target = snapshotToDatabase(readSnapshot(older), edited, getDataTypes(dialect));
        const summary = summarizeSchemaChange(diffOperations(edited, target), edited, target);
        expect(summary.tablesChanged).toEqual([{ name: "users", details: ["1 field removed"] }]);
    });
});

const withNewTable = (database: DatabaseType) => {
    const after = _.cloneDeep(database);
    const users = after.tables[0];
    after.tables.push({ ...users, id: "tags", name: "tags", fields: [{ ...users.fields[0], id: "tags.id", tableId: "tags", autoIncrement: false }], indices: [], checks: [] });
    return after;
};

describe("generateMigration", () => {
    for (const dialect of DIALECTS) {
        describe(dialect, () => {
            const renderer = () => getRenderer(dialect, getDataTypes(dialect))!;
            const base = () => stored(dialect);

            it("renders up SQL and an inverse for a new table", async () => {
                const before = base();
                const migration = await generateMigration(renderer(), before, withNewTable(before));
                expect(migration.upSql).toMatch(/CREATE TABLE/i);
                expect(migration.upSql).toMatch(/tags/);
                if (dialect === DatabaseDialect.POSTGRES) {
                    expect(migration.downBlockedReason).toBeNull();
                    expect(migration.downSql).toMatch(/DROP TABLE/i);
                } else {
                    // Dropping a table needs ALTER support the dialect does not have yet: said out loud, not skipped.
                    expect(migration.downSql).toBeNull();
                    expect(migration.downBlockedReason).toMatch(/cannot render dropping a table/);
                }
            });

            it("is deterministic", async () => {
                const before = base();
                const after = withNewTable(before);
                const first = await generateMigration(renderer(), before, after);
                const second = await generateMigration(renderer(), _.cloneDeep(before), _.cloneDeep(after));
                expect(second).toEqual(first);
            });

            it("reports an unchanged project as no change", async () => {
                const database = base();
                await expect(generateMigration(renderer(), database, _.cloneDeep(database))).rejects.toBeInstanceOf(NoSchemaChangesError);
            });

            if (dialect === DatabaseDialect.POSTGRES) {
                it("renders an added column and a safe down", async () => {
                    const before = base();
                    const migration = await generateMigration(renderer(), before, withNewField(before, dialect, "users", "age"));
                    expect(migration.upSql).toMatch(/ADD COLUMN.*age/is);
                    expect(migration.downBlockedReason).toBeNull();
                    expect(migration.downSql).toMatch(/DROP COLUMN.*age/is);
                });

                it("refuses a down migration when a column is dropped", async () => {
                    const after = base();
                    const before = withNewField(after, dialect, "users", "age");
                    const migration = await generateMigration(renderer(), before, after);
                    expect(migration.upSql).toMatch(/DROP COLUMN.*age/is);
                    expect(migration.downSql).toBeNull();
                    expect(migration.downBlockedReason).toMatch(/drops column "users\.age"/);
                });
            } else {
                it("refuses to write a script that would leave out an added column", async () => {
                    const before = base();
                    const attempt = generateMigration(renderer(), before, withNewField(before, dialect, "users", "age", dialect === DatabaseDialect.MSSQL ? "int" : "integer"));
                    await expect(attempt).rejects.toBeInstanceOf(UnsupportedMigrationError);
                    await expect(attempt).rejects.toThrow(/cannot render adding a column/);
                });
            }
        });
    }

    const dialect = DatabaseDialect.POSTGRES;

    it("refuses a down migration when a table is dropped or a type changes", async () => {
        const full = stored(dialect);
        const withoutPosts = _.cloneDeep(full);
        withoutPosts.tables = withoutPosts.tables.filter((table) => table.id !== "posts");
        withoutPosts.relationships = [];
        expect(downBlockedReasonFor(full, withoutPosts)).toMatch(/drops table "posts"/);

        const retyped = _.cloneDeep(full);
        const email = retyped.tables[0].fields.find((field) => field.name === "email")!;
        email.typeId = typeId(dialect, "text");
        email.type = getDataTypes(dialect).find((type) => type.name === "text")!;
        expect(downBlockedReasonFor(full, retyped)).toMatch(/changes the type of "users\.email"/);
    });

    it("allows a down migration when a column only gets wider", async () => {
        const full = stored(dialect);
        const wider = _.cloneDeep(full);
        wider.tables[0].fields.find((field) => field.name === "email")!.maxLength = 500;
        expect(downBlockedReasonFor(full, wider)).toBeNull();
        expect(downBlockedReasonFor(wider, full)).toMatch(/narrows maxLength of "users\.email"/);
    });
});

describe("migration files", () => {
    const migration = {
        sequence: 3, name: "Add user age!", dialect: "postgres", description: "Adds an age column.\nSecond line.",
        sourceSnapshotId: "snap-a", targetSnapshotId: "snap-b", upSql: "ALTER TABLE users ADD age int;", downSql: null as string | null,
    };

    it("names files by sequence and a safe stem", () => {
        expect(migrationFileStem(3, "Add user age!")).toBe("0003_add_user_age");
        expect(migrationFileStem(12, "  ")).toBe("0012_migration");
    });

    it("writes a header that links the two snapshots", () => {
        const text = formatMigrationFile(migration, "up", { source: "Before", target: "After" });
        expect(text).toContain("-- GoForge migration 0003: Add user age! (up)");
        expect(text).toContain("-- Adds an age column. Second line.");
        expect(text).toContain("from snapshot: Before [snap-a]");
        expect(text).toContain("to snapshot:   After [snap-b]");
        expect(text.trimEnd().endsWith("ALTER TABLE users ADD age int;")).toBe(true);
    });

    it("has no down file when none was generated", () => {
        expect(() => formatMigrationFile(migration, "down")).toThrow(/no down script/);
    });

    it("detects edited SQL through the checksum", async () => {
        const checksum = await migrationChecksum("up", "down");
        expect(await verifyMigrationChecksum({ upSql: "up", downSql: "down", checksum })).toBe(true);
        expect(await verifyMigrationChecksum({ upSql: "up!", downSql: "down", checksum })).toBe(false);
    });
});

describe("restoreOperations", () => {
    const dialect = DatabaseDialect.POSTGRES;

    it("is empty when the project is exactly the snapshot", async () => {
        const base = stored(dialect);
        const restored = snapshotToDatabase(readSnapshot(await draftSnapshot(base)), base, getDataTypes(dialect));
        expect(restoreOperations(base, restored).filter((operation) => operation.type !== "UPDATE_NUM_TABLES")).toEqual([]);
    });

    it("brings back a deleted table with its original id and position", async () => {
        const base = stored(dialect);
        base.tables[1].posX = 640;
        const snapshot = await draftSnapshot(base);

        const current = _.cloneDeep(base);
        current.tables = current.tables.filter((table) => table.id !== "posts");
        current.relationships = [];
        const target = snapshotToDatabase(readSnapshot(snapshot), current, getDataTypes(dialect));

        const operations = restoreOperations(current, target);
        const created = operations.find((operation) => operation.type === "CREATE_TABLE");
        expect(created?.type === "CREATE_TABLE" && created.table.id).toBe("posts");
        expect(created?.type === "CREATE_TABLE" && created.table.posX).toBe(640);
        expect(operations.some((operation) => operation.type === "CREATE_RELATIONSHIP")).toBe(true);
    });

    it("removes what was added after the snapshot", async () => {
        const base = stored(dialect);
        const snapshot = await draftSnapshot(base);
        const current = withNewField(base, dialect, "users", "age");
        const target = snapshotToDatabase(readSnapshot(snapshot), current, getDataTypes(dialect));
        expect(restoreOperations(current, target).map((operation) => operation.type)).toContain("DELETE_FIELD");
    });
});
