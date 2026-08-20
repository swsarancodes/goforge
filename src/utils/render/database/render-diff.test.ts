import { describe, it, expect } from "vitest";
import { cloneDeep } from "lodash";

import { DatabaseDialect } from "@/lib/database";
import { getRenderer } from "@/utils/render/render-uttils";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { FieldType } from "@/lib/schemas/field-schema";
import { IndexType } from "@/lib/schemas/index-schema";

// renderDiffDDL(current, previous) diffs two DatabaseType snapshots and emits the
// incremental ALTER/CREATE/DROP statements needed to bring `previous` (standing in
// for a live database's introspected schema) in line with `current` (the canvas).
// This is the live-connection "push changes" path - renderDDL() (tested in
// render.test.ts) is the from-scratch special case where previous = emptyDb().

const data_types = getDataTypes(DatabaseDialect.POSTGRES);
const renderer = () => getRenderer(DatabaseDialect.POSTGRES, data_types)!;

const previousDb = (): DatabaseType => cloneDeep(buildSampleDatabase(DatabaseDialect.POSTGRES));

const findField = (db: DatabaseType, tableName: string, fieldName: string): FieldType => {
  const table = db.tables.find((t) => t.name === tableName)!;
  return table.fields.find((f) => f.name === fieldName)!;
};

describe("PostgresqlRenderer.renderDiffDDL - incremental ALTER support", () => {
  it("emits no SQL when there is no diff", async () => {
    const previous = previousDb();
    const current = cloneDeep(previous);

    const sql = await renderer().renderDiffDDL(current, previous);

    expect(sql.trim()).toBe("");
  });

  it("emits ADD COLUMN for a new field", async () => {
    const previous = previousDb();
    const current = cloneDeep(previous);
    const emailField = findField(current, "users", "email");

    current.tables[0].fields.push({
      ...cloneDeep(emailField),
      id: "users.nickname",
      name: "nickname",
      isPrimary: false,
      unique: false,
      nullable: true,
      maxLength: 50,
      defaultValue: undefined,
    } as FieldType);

    const sql = await renderer().renderDiffDDL(current, previous);

    expect(sql).toMatch(/ALTER TABLE\s+"?users"?\s+ADD COLUMN\s+nickname/i);
  });

  it("emits DROP COLUMN for a removed field", async () => {
    const previous = previousDb();
    const current = cloneDeep(previous);
    current.tables[0].fields = current.tables[0].fields.filter((f) => f.name !== "status");

    const sql = await renderer().renderDiffDDL(current, previous);

    expect(sql).toMatch(/ALTER TABLE\s+"?users"?\s+DROP COLUMN\s+status/i);
  });

  it("emits RENAME TO for a renamed table", async () => {
    const previous = previousDb();
    const current = cloneDeep(previous);
    current.tables[0].name = "accounts";

    const sql = await renderer().renderDiffDDL(current, previous);

    expect(sql).toMatch(/ALTER TABLE\s+"?users"?\s+RENAME TO\s+"?accounts"?/i);
  });

  it("emits RENAME COLUMN for a renamed field", async () => {
    const previous = previousDb();
    const current = cloneDeep(previous);
    findField(current, "users", "status").name = "state";

    const sql = await renderer().renderDiffDDL(current, previous);

    expect(sql).toMatch(/ALTER TABLE\s+"?users"?\s+RENAME COLUMN\s+status\s+TO\s+state/i);
  });

  it("emits SET DATA TYPE (with a USING cast) for a changed column type", async () => {
    const previous = previousDb();
    const current = cloneDeep(previous);
    const integerType = data_types.find((t) => t.name === "integer")!;
    findField(current, "users", "status").typeId = integerType.id;

    const sql = await renderer().renderDiffDDL(current, previous);

    // varchar -> integer has no implicit cast in Postgres, so a real USING clause
    // is required (getUsingAst() routes incompatible conversions through an
    // intermediate ::TEXT:: cast) - a bare SET DATA TYPE would fail at execution time.
    expect(sql).toMatch(/ALTER TABLE\s+"?users"?\s+ALTER COLUMN\s+status\s+TYPE\s+INTEGER\s+USING\s+status::TEXT::INTEGER/i);
  });

  it("emits DROP NOT NULL when a field becomes nullable", async () => {
    const previous = previousDb();
    const current = cloneDeep(previous);
    findField(current, "users", "email").nullable = true;

    const sql = await renderer().renderDiffDDL(current, previous);

    expect(sql).toMatch(/ALTER TABLE\s+"?users"?\s+ALTER COLUMN\s+email\s+DROP NOT NULL/i);
  });

  it("emits SET NOT NULL when a field becomes required", async () => {
    const previous = previousDb();
    const current = cloneDeep(previous);
    findField(current, "posts", "title").nullable = false;
    // title is already NOT NULL in the fixture - flip via a nullable field instead
    findField(previous, "posts", "title").nullable = true;

    const sql = await renderer().renderDiffDDL(current, previous);

    expect(sql).toMatch(/ALTER TABLE\s+"?posts"?\s+ALTER COLUMN\s+title\s+SET NOT NULL/i);
  });

  it("emits SET DEFAULT when a default value changes", async () => {
    // mapDiffToDBDiffOperation only turns json-patch "replace" ops into UPDATE_FIELD
    // (a pre-existing limitation, not something this feature touches) - going from no
    // default to a default is an "add" op and wouldn't surface here, so this changes
    // an already-present default value instead, which is a genuine "replace".
    const previous = previousDb();
    const current = cloneDeep(previous);
    findField(current, "users", "status").defaultValue = "pending";

    const sql = await renderer().renderDiffDDL(current, previous);

    expect(sql).toMatch(/ALTER TABLE\s+"?users"?\s+ALTER COLUMN\s+status\s+SET DEFAULT\s+'pending'/i);
  });

  it("emits DROP DEFAULT when a default value is removed", async () => {
    const previous = previousDb();
    const current = cloneDeep(previous);
    findField(current, "users", "status").defaultValue = "";

    const sql = await renderer().renderDiffDDL(current, previous);

    expect(sql).toMatch(/ALTER TABLE\s+"?users"?\s+ALTER COLUMN\s+status\s+DROP DEFAULT/i);
  });

  it("emits DROP TABLE for a removed table", async () => {
    const previous = previousDb();
    const current = cloneDeep(previous);
    current.tables = current.tables.filter((t) => t.name !== "posts");
    current.relationships = [];

    const sql = await renderer().renderDiffDDL(current, previous);

    expect(sql).toMatch(/DROP TABLE\s+"?posts"?/i);
  });

  it("emits CREATE INDEX for a new index", async () => {
    const previous = previousDb();
    const current = cloneDeep(previous);
    const emailField = findField(current, "users", "email");

    const index: IndexType = {
      id: "idx_users_email",
      tableId: "users",
      name: "idx_users_email",
      unique: true,
      fieldIndices: [{ id: "fi_1", fieldId: emailField.id, indexId: "idx_users_email" }],
      fields: [emailField],
    } as IndexType;

    current.tables[0].indices.push(index);

    const sql = await renderer().renderDiffDDL(current, previous);

    expect(sql).toMatch(/CREATE UNIQUE INDEX\s+"?idx_users_email"?\s+ON\s+"?users"?/i);
  });

  it("emits DROP INDEX for a removed index", async () => {
    const previous = previousDb();
    const emailField = findField(previous, "users", "email");
    previous.tables[0].indices.push({
      id: "idx_users_email",
      tableId: "users",
      name: "idx_users_email",
      unique: true,
      fieldIndices: [{ id: "fi_1", fieldId: emailField.id, indexId: "idx_users_email" }],
      fields: [emailField],
    } as IndexType);
    const current = cloneDeep(previous);
    current.tables[0].indices = [];

    const sql = await renderer().renderDiffDDL(current, previous);

    expect(sql).toMatch(/DROP INDEX\s+idx_users_email/i);
  });
});
