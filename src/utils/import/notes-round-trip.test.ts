import { beforeAll, describe, expect, it } from "vitest";
import { init } from "@guanmingchiu/sqlparser-ts";

import { DatabaseDialect } from "@/lib/database";
import { ForeignKeyActions } from "@/lib/field";
import { getRenderer } from "@/utils/render/render-uttils";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { prepareSqlSchemaChange } from "@/utils/import/prepare-sql-schema-change";

// The SQL editor starts from renderDDL() output and applies whatever the user leaves
// in it. Notes are now rendered as COMMENT statements / inline COMMENT clauses, so
// every importer has to read that SQL back without warnings, errors, or phantom changes
// (and without dropping the notes that only exist on the canvas).

beforeAll(async () => {
    await init();
});

const hydrate = (db: DatabaseType): DatabaseType => {
    for (const table of db.tables) {
        table.databaseId = db.id;
        table.color = table.color ?? "#ff6363";
        table.createdAt = "2026-01-01T00:00:00.000Z";
        table.fields.forEach((field, index) => {
            field.sequence = index;
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

const dialects = [
    DatabaseDialect.POSTGRES,
    DatabaseDialect.MYSQL,
    DatabaseDialect.MARIADB,
    DatabaseDialect.MSSQL,
    DatabaseDialect.ORACLE,
];

const significantOps = (operations: { type: string }[]) => operations.filter((op) => op.type !== "UPDATE_NUM_TABLES");

describe("rendered notes survive an edit-SQL round trip", () => {
    for (const dialect of dialects) {
        it(`${dialect}: notes in the SQL add no warnings and no changes`, async () => {
            const dataTypes = getDataTypes(dialect);
            const roundTrip = async (withNotes: boolean) => {
                const current = hydrate(buildSampleDatabase(dialect));
                for (const table of current.tables) {
                    table.note ??= null;
                    for (const field of table.fields) field.note ??= null;
                }
                if (withNotes) {
                    const users = current.tables.find((table) => table.id === "users")!;
                    users.note = "Registered people";
                    users.fields.find((field) => field.name === "email")!.note = "Login email, it's unique";
                }
                const sql = await getRenderer(dialect, dataTypes)!.renderDDL(current);
                return { sql, prepared: await prepareSqlSchemaChange(sql, current, dataTypes) };
            };

            const plain = await roundTrip(false);
            const noted = await roundTrip(true);

            expect(noted.sql).toMatch(/Registered people/);
            expect(noted.prepared.warnings).toEqual(plain.prepared.warnings);
            // Some dialects have unrelated round-trip differences (e.g. SQL Server
            // primary-key nullability); notes must not add to or change them.
            expect(significantOps(noted.prepared.operations)).toEqual(significantOps(plain.prepared.operations));
        });
    }
});
