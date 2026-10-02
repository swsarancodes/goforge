import { describe, expect, it } from "vitest";

import { DatabaseDialect } from "@/lib/database";
import { getRenderer } from "@/utils/render/render-uttils";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { DatabaseType } from "@/lib/schemas/database-schema";

// Notes live outside the migration diff (prepareForMigration strips them), so these
// tests pin down that they still reach the exported DDL, per dialect, and that
// quotes inside a note cannot break out of the string literal.

const TABLE_NOTE = "Registered people";
const COLUMN_NOTE = "Login email, it's unique";

const withNotes = (dialect: DatabaseDialect): DatabaseType => {
  const database = buildSampleDatabase(dialect);
  const users = database.tables.find((table) => table.id === "users")!;
  users.note = TABLE_NOTE;
  users.fields.find((field) => field.name === "email")!.note = COLUMN_NOTE;
  return database;
};

const render = (dialect: DatabaseDialect, database: DatabaseType) =>
  getRenderer(dialect, getDataTypes(dialect)).renderDDL(database);

describe("notes in rendered DDL", () => {
  it("PostgreSQL emits COMMENT ON with escaped quotes", async () => {
    const sql = await render(DatabaseDialect.POSTGRES, withNotes(DatabaseDialect.POSTGRES));
    expect(sql).toMatch(/COMMENT ON TABLE "users" IS 'Registered people'/);
    expect(sql).toMatch(/COMMENT ON COLUMN "users"\."email" IS 'Login email, it''s unique'/);
    // Comments must come after the table exists.
    expect(sql.indexOf("CREATE TABLE")).toBeLessThan(sql.indexOf("COMMENT ON TABLE"));
  });

  it("Oracle emits COMMENT ON", async () => {
    const sql = await render(DatabaseDialect.ORACLE, withNotes(DatabaseDialect.ORACLE));
    expect(sql).toMatch(/COMMENT ON TABLE users IS 'Registered people'/);
    expect(sql).toMatch(/COMMENT ON COLUMN users\.email IS 'Login email, it''s unique'/);
  });

  it("SQL Server emits MS_Description extended properties", async () => {
    const sql = await render(DatabaseDialect.MSSQL, withNotes(DatabaseDialect.MSSQL));
    expect(sql).toContain("sp_addextendedproperty");
    expect(sql).toMatch(/N'Registered people'/);
    expect(sql).toMatch(/N'COLUMN',\s*N'email'/);
    expect(sql).toMatch(/N'SCHEMA',\s*N'dbo',\s*N'TABLE',\s*N'users'/);
    expect(sql).toMatch(/N'Login email, it''s unique'/);
  });

  for (const dialect of [DatabaseDialect.MYSQL, DatabaseDialect.MARIADB]) {
    it(`${dialect} comments inline`, async () => {
      const sql = await render(dialect, withNotes(dialect));
      expect(sql).toMatch(/COMMENT\s+'Login email, it''s unique'/i);
      expect(sql).toMatch(/COMMENT\s*=\s*'Registered people'/i);
    });
  }

  it("MySQL escapes backslashes in notes", async () => {
    const database = withNotes(DatabaseDialect.MYSQL);
    database.tables.find((table) => table.id === "users")!.note = "path C:\\temp";
    const sql = await render(DatabaseDialect.MYSQL, database);
    expect(sql).toContain("path C:\\\\temp");
  });

  it("SQLite has no comment syntax, so notes are not emitted", async () => {
    const sql = await render(DatabaseDialect.SQLITE, withNotes(DatabaseDialect.SQLITE));
    expect(sql).not.toMatch(/COMMENT/i);
    expect(sql).not.toContain("Registered people");
  });

  for (const dialect of [DatabaseDialect.POSTGRES, DatabaseDialect.MYSQL, DatabaseDialect.ORACLE, DatabaseDialect.MSSQL]) {
    it(`${dialect} output is unchanged when there are no notes`, async () => {
      const plain = buildSampleDatabase(dialect);
      const blank = buildSampleDatabase(dialect);
      blank.tables[0].note = "   ";
      blank.tables[0].fields[0].note = "";
      expect(await render(dialect, blank)).toBe(await render(dialect, plain));
    });
  }
});
