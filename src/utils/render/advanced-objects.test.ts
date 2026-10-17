import { describe, it, expect } from "vitest";
import { cloneDeep } from "lodash";
import { DatabaseDialect } from "@/lib/database";
import { getRenderer } from "./render-uttils";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { TableType } from "@/lib/schemas/table-schema";
import { FieldType } from "@/lib/schemas/field-schema";
import { ViewType, sortViewsTopologically } from "@/lib/schemas/view-schema";
import { SequenceType } from "@/lib/schemas/sequence-schema";

describe("Phase 2 — Namespaces and CREATE SCHEMA emission", () => {
  it("emits CREATE SCHEMA IF NOT EXISTS for namespaced tables in PostgreSQL", async () => {
    const database = buildSampleDatabase(DatabaseDialect.POSTGRES);
    database.tables[0].namespace = "analytics";
    const dataTypes = getDataTypes(DatabaseDialect.POSTGRES);
    const renderer = getRenderer(DatabaseDialect.POSTGRES, dataTypes)!;

    const sql = await renderer.renderDDL(database);
    expect(sql).toMatch(/CREATE SCHEMA IF NOT EXISTS "?analytics"?/i);
    expect(sql).toMatch(/CREATE TABLE "analytics"\."users"/i);
  });

  it("emits CREATE SCHEMA IF NOT EXISTS for MySQL", async () => {
    const database = buildSampleDatabase(DatabaseDialect.MYSQL);
    database.tables[0].namespace = "warehouse";
    const dataTypes = getDataTypes(DatabaseDialect.MYSQL);
    const renderer = getRenderer(DatabaseDialect.MYSQL, dataTypes)!;

    const sql = await renderer.renderDDL(database);
    expect(sql).toMatch(/CREATE SCHEMA IF NOT EXISTS `?warehouse`?/i);
  });

  it("emits conditional schema creation for SQL Server", async () => {
    const database = buildSampleDatabase(DatabaseDialect.MSSQL);
    database.tables[0].namespace = "sales";
    const dataTypes = getDataTypes(DatabaseDialect.MSSQL);
    const renderer = getRenderer(DatabaseDialect.MSSQL, dataTypes)!;

    const sql = await renderer.renderDDL(database);
    expect(sql).toMatch(/IF NOT EXISTS\s*\(\s*SELECT\s+\*\s+FROM\s+sys\.schemas\s+WHERE\s+name\s*=\s*'sales'\s*\)\s*EXEC\s*\(\s*'CREATE SCHEMA sales'\s*\)/i);
  });

  it("rejects namespaces for SQLite dialect", async () => {
    const database = buildSampleDatabase(DatabaseDialect.SQLITE);
    database.tables[0].namespace = "custom_schema";
    const dataTypes = getDataTypes(DatabaseDialect.SQLITE);
    const renderer = getRenderer(DatabaseDialect.SQLITE, dataTypes)!;

    await expect(renderer.renderDDL(database)).rejects.toThrow(/SQLite does not support SQL namespaces/i);
  });
});

describe("Phase 2 — PostgreSQL Table Relocation (SET SCHEMA)", () => {
  it("generates ALTER TABLE SET SCHEMA when a table namespace changes", async () => {
    const previous = buildSampleDatabase(DatabaseDialect.POSTGRES);
    previous.tables[0].namespace = "public";

    const current = cloneDeep(previous);
    current.tables[0].namespace = "archive";

    const dataTypes = getDataTypes(DatabaseDialect.POSTGRES);
    const renderer = getRenderer(DatabaseDialect.POSTGRES, dataTypes)!;

    const sql = await renderer.renderDiffDDL(current, previous);
    expect(sql).toMatch(/ALTER TABLE\s+"public"\."users"\s+SET SCHEMA\s+"archive"/i);

    const ops = renderer.prepareDiff(current, previous);
    const unsupported = renderer.unsupportedOperations(ops);
    expect(unsupported).toHaveLength(0);
  });
});

describe("Phase 2 — View Dependency Ordering", () => {
  it("sorts views topologically so dependencies are created before dependents", () => {
    const viewList: ViewType[] = [
      {
        id: "view-c",
        databaseId: "db1",
        name: "view_summary",
        namespace: "reporting",
        materialized: false,
        definition: "SELECT * FROM reporting.view_intermediate JOIN reporting.view_base ON 1=1",
        dependencies: null,
        note: null,
        createdAt: null,
      },
      {
        id: "view-b",
        databaseId: "db1",
        name: "view_intermediate",
        namespace: "reporting",
        materialized: false,
        definition: "SELECT * FROM reporting.view_base",
        dependencies: null,
        note: null,
        createdAt: null,
      },
      {
        id: "view-a",
        databaseId: "db1",
        name: "view_base",
        namespace: "reporting",
        materialized: false,
        definition: "SELECT id, count(*) FROM users GROUP BY id",
        dependencies: null,
        note: null,
        createdAt: null,
      },
    ];

    const sorted = sortViewsTopologically(viewList);
    const order = sorted.map((v) => v.name);
    expect(order).toEqual(["view_base", "view_intermediate", "view_summary"]);
  });

  it("emits views in correct topological order in rendered DDL", async () => {
    const database = buildSampleDatabase(DatabaseDialect.POSTGRES);
    database.views = [
      {
        id: "v-dependent",
        databaseId: database.id,
        name: "active_orders_summary",
        namespace: null,
        materialized: false,
        definition: "SELECT count(*) FROM active_orders",
        dependencies: "active_orders",
        note: null,
        createdAt: null,
      },
      {
        id: "v-base",
        databaseId: database.id,
        name: "active_orders",
        namespace: null,
        materialized: false,
        definition: "SELECT * FROM posts WHERE id > 0",
        dependencies: "posts",
        note: null,
        createdAt: null,
      },
    ] as ViewType[];

    const dataTypes = getDataTypes(DatabaseDialect.POSTGRES);
    const renderer = getRenderer(DatabaseDialect.POSTGRES, dataTypes)!;
    const sql = await renderer.renderDDL(database);

    const baseIdx = sql.indexOf("CREATE VIEW active_orders AS");
    const depIdx = sql.indexOf("CREATE VIEW active_orders_summary AS");
    expect(baseIdx).toBeGreaterThan(-1);
    expect(depIdx).toBeGreaterThan(-1);
    expect(baseIdx).toBeLessThan(depIdx);
  });
});

describe("Phase 2 — Generated Columns", () => {
  it("renders STORED generated columns in PostgreSQL", async () => {
    const database = buildSampleDatabase(DatabaseDialect.POSTGRES);
    const users = database.tables.find((t) => t.name === "users")!;
    users.fields.push({
      id: "users.full_name",
      tableId: users.id,
      name: "full_name",
      isPrimary: false,
      unique: false,
      nullable: true,
      defaultValue: null,
      sequence: 5,
      typeId: users.fields[0].typeId,
      type: users.fields[0].type,
      generatedExpression: "email || '@domain.com'",
      generationType: "stored",
    } as FieldType);

    const dataTypes = getDataTypes(DatabaseDialect.POSTGRES);
    const renderer = getRenderer(DatabaseDialect.POSTGRES, dataTypes)!;
    const sql = await renderer.renderDDL(database);

    expect(sql).toMatch(/full_name.*GENERATED ALWAYS AS\s*\(\(email \|\| '@domain\.com'\)\)\s*STORED/i);
  });

  it("rejects VIRTUAL generated columns in PostgreSQL with clear capability error", async () => {
    const database = buildSampleDatabase(DatabaseDialect.POSTGRES);
    const users = database.tables.find((t) => t.name === "users")!;
    users.fields.push({
      id: "users.computed",
      tableId: users.id,
      name: "computed",
      isPrimary: false,
      unique: false,
      nullable: true,
      defaultValue: null,
      sequence: 5,
      typeId: users.fields[0].typeId,
      type: users.fields[0].type,
      generatedExpression: "email || 'test'",
      generationType: "virtual",
    } as FieldType);

    const dataTypes = getDataTypes(DatabaseDialect.POSTGRES);
    const renderer = getRenderer(DatabaseDialect.POSTGRES, dataTypes)!;
    await expect(renderer.renderDDL(database)).rejects.toThrow(/PostgreSQL does not support VIRTUAL generated columns/i);
  });

  it("renders VIRTUAL and STORED generated columns in MySQL", async () => {
    const database = buildSampleDatabase(DatabaseDialect.MYSQL);
    const users = database.tables.find((t) => t.name === "users")!;
    users.fields.push({
      id: "users.computed_val",
      tableId: users.id,
      name: "computed_val",
      isPrimary: false,
      unique: false,
      nullable: true,
      defaultValue: null,
      sequence: 5,
      typeId: users.fields[0].typeId,
      type: users.fields[0].type,
      generatedExpression: "id * 10",
      generationType: "virtual",
    } as FieldType);

    const dataTypes = getDataTypes(DatabaseDialect.MYSQL);
    const renderer = getRenderer(DatabaseDialect.MYSQL, dataTypes)!;
    const sql = await renderer.renderDDL(database);

    expect(sql).toMatch(/`?computed_val`?\s+INTEGER\s+GENERATED ALWAYS AS\s*\(\(id \* 10\)\)\s*VIRTUAL/i);
  });

  it("renders PERSISTED computed columns in SQL Server", async () => {
    const database = buildSampleDatabase(DatabaseDialect.MSSQL);
    const users = database.tables.find((t) => t.name === "users")!;
    users.fields.push({
      id: "users.calc_col",
      tableId: users.id,
      name: "calc_col",
      isPrimary: false,
      unique: false,
      nullable: true,
      defaultValue: null,
      sequence: 5,
      typeId: users.fields[0].typeId,
      type: users.fields[0].type,
      generatedExpression: "id + 100",
      generationType: "stored",
    } as FieldType);

    const dataTypes = getDataTypes(DatabaseDialect.MSSQL);
    const renderer = getRenderer(DatabaseDialect.MSSQL, dataTypes)!;
    const sql = await renderer.renderDDL(database);

    expect(sql).toMatch(/calc_col AS \(id \+ 100\) PERSISTED/i);
  });

  it("renders virtual generated columns in Oracle", async () => {
    const database = buildSampleDatabase(DatabaseDialect.ORACLE);
    const users = database.tables.find((t) => t.name === "users")!;
    users.fields.push({
      id: "users.calc_oracle",
      tableId: users.id,
      name: "calc_oracle",
      isPrimary: false,
      unique: false,
      nullable: true,
      defaultValue: null,
      sequence: 5,
      typeId: users.fields[0].typeId,
      type: users.fields[0].type,
      generatedExpression: "id * 2",
      generationType: "virtual",
    } as FieldType);

    const dataTypes = getDataTypes(DatabaseDialect.ORACLE);
    const renderer = getRenderer(DatabaseDialect.ORACLE, dataTypes)!;
    const sql = await renderer.renderDDL(database);

    expect(sql).toMatch(/calc_oracle.*GENERATED ALWAYS AS \(id \* 2\) VIRTUAL/i);
  });
});
