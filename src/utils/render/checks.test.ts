import { describe, expect, it } from "vitest";

import { DatabaseDialect } from "@/lib/database";
import { getRenderer } from "@/utils/render/render-uttils";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { CheckConstraintType } from "@/lib/schemas/check-constraint-schema";

const EXPRESSION = "status IN ('active','banned') AND length(email) > 3";

const makeCheck = (over: Partial<CheckConstraintType> = {}): CheckConstraintType => ({
  id: "chk-1",
  tableId: "users",
  name: "chk_users_status",
  expression: EXPRESSION,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const withCheck = (dialect: DatabaseDialect, check: CheckConstraintType | null = makeCheck()): DatabaseType => {
  const database = buildSampleDatabase(dialect);
  const users = database.tables.find((table) => table.id === "users")!;
  users.checks = check ? [check] : [];
  return database;
};

const render = (dialect: DatabaseDialect, database: DatabaseType) =>
  getRenderer(dialect, getDataTypes(dialect)).renderDDL(database);

const renderDiff = (dialect: DatabaseDialect, current: DatabaseType, previous: DatabaseType) =>
  getRenderer(dialect, getDataTypes(dialect)).renderDiffDDL(current, previous);

const ALL = [
  DatabaseDialect.POSTGRES,
  DatabaseDialect.MYSQL,
  DatabaseDialect.MARIADB,
  DatabaseDialect.SQLITE,
  DatabaseDialect.ORACLE,
  DatabaseDialect.MSSQL,
];

// The expression must reach the DDL exactly as typed (whitespace aside), which is what
// lets the importer read it back unchanged.
const squash = (sql: string) => sql.replace(/\s+/g, " ").replace(/\s*([,()<>=])\s*/g, "$1");
const expected = squash(EXPRESSION);

describe("CHECK constraints in CREATE TABLE", () => {
  for (const dialect of ALL) {
    it(`${dialect} renders a named inline CHECK`, async () => {
      const sql = await render(dialect, withCheck(dialect));
      const flat = squash(sql);
      expect(flat).toMatch(/CONSTRAINT [`"]?chk_users_status[`"]? CHECK\(/i);
      expect(flat).toContain(expected);
      // Inside the CREATE TABLE, not a separate ALTER.
      expect(sql).not.toMatch(/ALTER TABLE[^;]*CHECK/i);
    });

    it(`${dialect} output is unchanged when a table has no checks`, async () => {
      const plain = buildSampleDatabase(dialect);
      const empty = withCheck(dialect, null);
      expect(await render(dialect, empty)).toBe(await render(dialect, plain));
    });
  }

  it("keeps several checks in order", async () => {
    const database = withCheck(DatabaseDialect.POSTGRES);
    database.tables[0].checks!.push(makeCheck({ id: "chk-2", name: "chk_users_second", expression: "id > 0" }));
    const sql = await render(DatabaseDialect.POSTGRES, database);
    expect(sql.indexOf("chk_users_status")).toBeLessThan(sql.indexOf("chk_users_second"));
  });
});

describe("CHECK constraints are validated at render time", () => {
  for (const bad of ["1 = 1); DROP TABLE users; --", "a > 0 -- trailing", "(a > 0", "a > 0)", ""]) {
    it(`rejects ${JSON.stringify(bad)}`, async () => {
      await expect(render(DatabaseDialect.POSTGRES, withCheck(DatabaseDialect.POSTGRES, makeCheck({ expression: bad })))).rejects.toThrow(/Invalid CHECK constraint/);
    });
  }

  it("rejects an unsafe constraint name", async () => {
    await expect(render(DatabaseDialect.MYSQL, withCheck(DatabaseDialect.MYSQL, makeCheck({ name: "x`; DROP TABLE t; --" })))).rejects.toThrow(/Invalid CHECK constraint/);
  });

  it("allows semicolons and comment markers inside string literals", async () => {
    const sql = await render(DatabaseDialect.POSTGRES, withCheck(DatabaseDialect.POSTGRES, makeCheck({ expression: "note <> 'a;b -- c'" })));
    expect(sql).toContain("'a;b -- c'");
  });
});

describe("CHECK constraint migrations on existing tables", () => {
  for (const dialect of [DatabaseDialect.POSTGRES, DatabaseDialect.MYSQL, DatabaseDialect.MARIADB, DatabaseDialect.MSSQL, DatabaseDialect.ORACLE]) {
    it(`${dialect} adds a check with ALTER TABLE`, async () => {
      const previous = withCheck(dialect, null);
      const current = withCheck(dialect);
      const sql = await renderDiff(dialect, current, previous);
      expect(sql).toMatch(/ALTER TABLE\s+[`"]?users[`"]?\s+ADD CONSTRAINT\s+[`"]?chk_users_status[`"]?\s+CHECK/i);
      expect(sql).not.toMatch(/CREATE TABLE/i);
      expect(squash(sql)).toContain(expected);
    });

    it(`${dialect} drops a check`, async () => {
      const sql = await renderDiff(dialect, withCheck(dialect, null), withCheck(dialect));
      const drop = dialect === DatabaseDialect.MYSQL ? /DROP CHECK/i : /DROP CONSTRAINT/i;
      expect(sql).toMatch(drop);
      expect(sql).toMatch(/chk_users_status/);
    });

    it(`${dialect} replaces a check whose expression changed`, async () => {
      const sql = await renderDiff(dialect, withCheck(dialect, makeCheck({ expression: "id > 10" })), withCheck(dialect));
      const dropAt = sql.search(/DROP (CHECK|CONSTRAINT)/i);
      const addAt = sql.search(/ADD CONSTRAINT/i);
      expect(dropAt).toBeGreaterThan(-1);
      expect(addAt).toBeGreaterThan(dropAt);
      expect(squash(sql)).toContain("id>10");
    });
  }

  it("MySQL spells the drop as DROP CHECK, MariaDB as DROP CONSTRAINT", async () => {
    const mysql = await renderDiff(DatabaseDialect.MYSQL, withCheck(DatabaseDialect.MYSQL, null), withCheck(DatabaseDialect.MYSQL));
    const maria = await renderDiff(DatabaseDialect.MARIADB, withCheck(DatabaseDialect.MARIADB, null), withCheck(DatabaseDialect.MARIADB));
    expect(mysql).toMatch(/DROP CHECK/i);
    expect(maria).toMatch(/DROP CONSTRAINT/i);
    expect(maria).not.toMatch(/DROP CHECK/i);
  });

  it("SQLite refuses to alter an existing table's checks, with an explanation", async () => {
    await expect(renderDiff(DatabaseDialect.SQLITE, withCheck(DatabaseDialect.SQLITE), withCheck(DatabaseDialect.SQLITE, null))).rejects.toThrow(/SQLite cannot/);
  });

  it("emits nothing when the check is unchanged", async () => {
    const sql = await renderDiff(DatabaseDialect.POSTGRES, withCheck(DatabaseDialect.POSTGRES), withCheck(DatabaseDialect.POSTGRES));
    expect(sql.trim()).toBe("");
  });

  it("a brand-new table's checks are inline, not separate ALTERs, in a diff too", async () => {
    const current = withCheck(DatabaseDialect.POSTGRES);
    const previous = buildSampleDatabase(DatabaseDialect.POSTGRES);
    previous.tables = previous.tables.filter((table) => table.id !== "users");
    previous.relationships = [];
    const sql = await renderDiff(DatabaseDialect.POSTGRES, current, previous);
    expect(sql).toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE[^;]*CHECK/i);
  });
});
