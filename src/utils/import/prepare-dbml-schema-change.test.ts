import { beforeAll, describe, expect, it } from "vitest";
import { init } from "@guanmingchiu/sqlparser-ts";
import { DatabaseDialect } from "@/lib/database";
import { getDataTypes } from "@/test/fixtures/data-types";
import { makeDatabase, makeTable } from "@/test/fixtures/dbml-builders";
import { looksLikeDbml, prepareSqlSchemaChange } from "./prepare-sql-schema-change";

const dialect = DatabaseDialect.POSTGRES;
const dataTypes = getDataTypes(dialect);

beforeAll(async () => {
    await init();
});

// Shaped like a real design doc: header comments, a Project note, enums used as column
// types, inline refs, named composite indexes, notes in both quote styles and jsonb defaults.
const DBML = `
// =====================================================
// SALES SCHEMA
// =====================================================

Project sales_v2 {
  database_type: "PostgreSQL"
  Note: '''
    Sales Room schema.
  '''
}

Enum pipeline_stage {
  identified
  closed_won
}

Table regions {
  id uuid [pk]
  code varchar(20) [not null, note: 'e.g. US-E, EMEA']
  created_at timestamp [not null]

  indexes {
    code [unique, name: 'idx_regions_code']
  }

  Note: 'Top-level groupings.'
}

Table opportunities {
  id uuid [pk]
  region_id uuid [not null, ref: > regions.id]
  stage pipeline_stage [not null, default: 'identified']
  expected_revenue numeric(14,2) [not null, default: 0]
  tags jsonb [not null, default: '[]']
  title varchar(255) [not null, note: 'Project title — header & list']

  indexes {
    (region_id, stage) [name: 'idx_opps_region_stage']
  }

  Note: '''
    Lean core.
  '''
}
`;

const emptyDatabase = () => makeDatabase(dialect, []);

describe("looksLikeDbml", () => {
    it("recognises DBML, whatever the keyword case or leading comments", () => {
        expect(looksLikeDbml(DBML)).toBe(true);
        expect(looksLikeDbml("// header\ntable users {\n  id int [pk]\n}")).toBe(true);
        expect(looksLikeDbml("Ref: orders.user_id > users.id")).toBe(true);
        expect(looksLikeDbml("Table public.users as U {\n  id int\n}")).toBe(true);
    });

    it("leaves SQL alone, including SQL that mentions the words in comments or strings", () => {
        expect(looksLikeDbml("CREATE TABLE users (id int PRIMARY KEY);")).toBe(false);
        expect(looksLikeDbml("-- Table users {\nCREATE TABLE users (id int);")).toBe(false);
        expect(looksLikeDbml("/* Table users { */ CREATE TABLE users (id int);")).toBe(false);
        expect(looksLikeDbml("CREATE TABLE t (note text DEFAULT 'Table x {');")).toBe(false);
    });
});

describe("prepareSqlSchemaChange with pasted DBML", () => {
    it("turns DBML into the same operations SQL would, on an empty diagram", async () => {
        const change = await prepareSqlSchemaChange(DBML, emptyDatabase(), dataTypes);

        const created = change.operations.filter((operation) => operation.type === "CREATE_TABLE");
        expect(created.map((operation: any) => operation.table.name).sort()).toEqual(["opportunities", "regions"]);
        expect(change.operations.some((operation) => operation.type === "CREATE_RELATIONSHIP")).toBe(true);
        expect(change.destructiveOperations).toEqual([]);

        const target = change.targetDatabase;
        const opportunities = target.tables.find((table) => table.name === "opportunities")!;
        expect(opportunities.fields.map((field) => field.name)).toEqual(["id", "region_id", "stage", "expected_revenue", "tags", "title"]);
        expect(opportunities.fields.find((field) => field.name === "expected_revenue")).toMatchObject({ precision: 14, scale: 2, nullable: false });
        expect(opportunities.fields.find((field) => field.name === "stage")?.values).toBe(JSON.stringify(["identified", "closed_won"]));
        expect(opportunities.fields.find((field) => field.name === "region_id")?.isForeign).toBe(true);
        expect(target.relationships).toHaveLength(1);
    });

    it("lays the tables out instead of stacking them at the origin", async () => {
        const { targetDatabase } = await prepareSqlSchemaChange(DBML, emptyDatabase(), dataTypes);
        const positions = new Set(targetDatabase.tables.map((table) => `${table.posX},${table.posY}`));
        expect(positions.size).toBe(targetDatabase.tables.length);
    });

    it("places new tables to the right of an existing diagram and keeps what is already there", async () => {
        const existing = makeDatabase(dialect, [makeTable(dialect, "legacy", [{ name: "id", type: "uuid", primary: true }], { posX: 40, posY: 40 })]);
        const change = await prepareSqlSchemaChange(DBML, existing, dataTypes);

        const added = change.targetDatabase.tables.filter((table) => table.name !== "legacy");
        expect(added.length).toBe(2);
        for (const table of added) expect(table.posX).toBeGreaterThan(40 + 260);
        // Text is the whole schema, so the table it does not mention is a removal the user must confirm.
        expect(change.destructiveOperations.map((operation) => operation.type)).toContain("DELETE_TABLE");
    });

    it("reports what DBML cannot carry instead of dropping it silently", async () => {
        const { warnings } = await prepareSqlSchemaChange(DBML, emptyDatabase(), dataTypes);
        expect(warnings.some((warning) => /project note/i.test(warning))).toBe(true);
    });

    it("warns when the DBML is written for another database", async () => {
        const mysql = makeDatabase(DatabaseDialect.MYSQL, []);
        const { warnings } = await prepareSqlSchemaChange(DBML, mysql, getDataTypes(DatabaseDialect.MYSQL));
        expect(warnings[0]).toMatch(/PostgreSQL/);
    });

    it("explains where invalid DBML is wrong", async () => {
        await expect(prepareSqlSchemaChange("Table broken {\n  id int [pk\n}", emptyDatabase(), dataTypes)).rejects.toThrow(/not valid DBML.*line/);
    });

    it("says so when DBML declares no tables", async () => {
        await expect(prepareSqlSchemaChange("Enum only {\n  a\n  b\n}", emptyDatabase(), dataTypes)).rejects.toThrow(/any tables/);
    });

    it("still parses SQL as before", async () => {
        const change = await prepareSqlSchemaChange("CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL);", emptyDatabase(), dataTypes);
        expect(change.operations.filter((operation) => operation.type === "CREATE_TABLE")).toHaveLength(1);
    });
});
