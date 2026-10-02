import { describe, it, expect } from "vitest";

import { DatabaseDialect } from "@/lib/database";
import { getRenderer } from "@/utils/render/render-uttils";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { IndexType } from "@/lib/schemas/index-schema";
import { ViewType } from "@/lib/schemas/view-schema";
import { SequenceType } from "@/lib/schemas/sequence-schema";

// getRenderer().renderDDL() takes a DatabaseType and emits dialect DDL. It runs
// the migration diff (empty database -> the fixture), so the output is the full
// CREATE for every table plus the foreign key. Assertions match on substrings
// and quote-agnostic patterns rather than exact strings, since formatting and
// identifier quoting differ per dialect and are not what these tests pin down.

interface RenderCase {
  name: string;
  dialect: DatabaseDialect;
  // Dialect-specific spelling of an auto-increment / identity column.
  autoIncrement: RegExp;
  // Dialect-specific spelling of a variable-length string type.
  varchar: RegExp;
}

const cases: RenderCase[] = [
  {
    name: "MySQL",
    dialect: DatabaseDialect.MYSQL,
    autoIncrement: /AUTO_INCREMENT/,
    varchar: /VARCHAR\s*\(\s*255\s*\)/i,
  },
  {
    name: "MariaDB",
    dialect: DatabaseDialect.MARIADB,
    autoIncrement: /AUTO_INCREMENT/,
    varchar: /VARCHAR\s*\(\s*255\s*\)/i,
  },
  {
    name: "PostgreSQL",
    dialect: DatabaseDialect.POSTGRES,
    // auto-increment integers become SERIAL in Postgres
    autoIncrement: /SERIAL/,
    varchar: /VARCHAR\s*\(\s*255\s*\)/i,
  },
  {
    name: "SQLite",
    dialect: DatabaseDialect.SQLITE,
    autoIncrement: /AUTOINCREMENT/,
    // SQLite has no VARCHAR; the text column renders as TEXT
    varchar: /TEXT\s*\(\s*255\s*\)/i,
  },
  {
    name: "Oracle",
    dialect: DatabaseDialect.ORACLE,
    autoIncrement: /IDENTITY/,
    varchar: /VARCHAR2\s*\(\s*255\s*\)/i,
  },
  {
    name: "SQL Server",
    dialect: DatabaseDialect.MSSQL,
    autoIncrement: /IDENTITY/,
    varchar: /VARCHAR\s*\(\s*255\s*\)/i,
  },
];

const render = (dialect: DatabaseDialect): Promise<string> =>
  getRenderer(dialect, getDataTypes(dialect))!.renderDDL(
    buildSampleDatabase(dialect),
  );

const renderCompositeConstraints = (dialect: DatabaseDialect): Promise<string> => {
  const database = buildSampleDatabase(dialect);
  const users = database.tables.find((table) => table.name === "users")!;
  const id = users.fields.find((field) => field.name === "id")!;
  const email = users.fields.find((field) => field.name === "email")!;
  const status = users.fields.find((field) => field.name === "status")!;
  id.autoIncrement = false;
  email.isPrimary = true;
  email.unique = false;
  const indexId = "users_status_email_key";
  users.indices = [{
    id: indexId,
    tableId: users.id,
    name: indexId,
    unique: true,
    createdAt: null,
    fields: [status, email],
    fieldIndices: [status, email].map((field, index) => ({
      id: `${indexId}.${index}`,
      indexId,
      fieldId: field.id,
    })),
  } as IndexType];

  return getRenderer(dialect, getDataTypes(dialect))!.renderDDL(database);
};

describe("getRenderer().renderDDL - emitted DDL across dialects", () => {
  for (const c of cases) {
    describe(c.name, () => {
      it("creates both tables with their columns", async () => {
        const sql = await render(c.dialect);

        expect(sql).toMatch(/CREATE TABLE\s+[`"]?users[`"]?/i);
        expect(sql).toMatch(/CREATE TABLE\s+[`"]?posts[`"]?/i);
        for (const col of ["id", "email", "status", "user_id", "title"]) {
          expect(sql).toContain(col);
        }
      });

      it("emits primary key, unique and auto-increment", async () => {
        const sql = await render(c.dialect);

        expect(sql).toMatch(/PRIMARY KEY/i);
        expect(sql).toMatch(/UNIQUE/i);
        expect(sql).toMatch(c.autoIncrement);
      });

      it("emits the text column type with its length", async () => {
        const sql = await render(c.dialect);

        expect(sql).toMatch(c.varchar);
      });

      it("emits the DEFAULT value", async () => {
        const sql = await render(c.dialect);

        expect(sql).toMatch(/DEFAULT\s+'active'/i);
      });

      it("emits the foreign key from posts to users with ON DELETE CASCADE", async () => {
        const sql = await render(c.dialect);

        expect(sql).toMatch(/FOREIGN KEY\s*\(\s*user_id\s*\)/i);
        expect(sql).toMatch(/REFERENCES\s+[`"]?users[`"]?\s*\(\s*id\s*\)/i);
        expect(sql).toMatch(/ON DELETE CASCADE/i);
      });
    });
  }
});

describe("getRenderer().renderDDL - grouped constraints", () => {
  for (const dialectCase of cases) {
    it(`renders composite primary and multi-column unique keys for ${dialectCase.name}`, async () => {
      const sql = await renderCompositeConstraints(dialectCase.dialect);

      expect(sql).toMatch(/PRIMARY KEY\s*\(\s*[`"]?id[`"]?\s*,\s*[`"]?email[`"]?\s*\)/i);
      expect(sql).toMatch(/CREATE UNIQUE INDEX\s+[`"]?users_status_email_key[`"]?/i);
      expect(sql).toMatch(/\(\s*[`"]?status[`"]?\s*,\s*[`"]?email[`"]?\s*\)/i);
    });
  }
});

describe("getRenderer().renderDDL - namespaces", () => {
  it("renders qualified PostgreSQL table and relationship identifiers", async () => {
    const database = buildSampleDatabase(DatabaseDialect.POSTGRES);
    const users = database.tables.find((table) => table.name === "users")!;
    const posts = database.tables.find((table) => table.name === "posts")!;
    users.namespace = "auth";
    posts.namespace = "blog";

    const sql = await getRenderer(DatabaseDialect.POSTGRES, getDataTypes(DatabaseDialect.POSTGRES))!.renderDDL(database);
    expect(sql).toMatch(/CREATE TABLE\s+["']?auth["']?\.["']?users["']?/i);
    expect(sql).toMatch(/CREATE TABLE\s+["']?blog["']?\.["']?posts["']?/i);
    expect(sql).toMatch(/REFERENCES\s+["']?auth["']?\.["']?users["']?/i);
  });

  it("rejects namespaces for SQLite instead of emitting unsupported DDL", async () => {
    const database = buildSampleDatabase(DatabaseDialect.SQLITE);
    database.tables[0].namespace = "auth";
    await expect(getRenderer(DatabaseDialect.SQLITE, getDataTypes(DatabaseDialect.SQLITE))!.renderDDL(database))
      .rejects.toThrow(/SQLite does not support/i);
  });
});

describe("getRenderer().renderDDL - views", () => {
  it("renders namespaced regular and materialized views", async () => {
    const database = buildSampleDatabase(DatabaseDialect.POSTGRES);
    database.views = [
      {
        id: "view-active-users",
        databaseId: database.id,
        name: "active_users",
        namespace: "reporting",
        materialized: false,
        definition: "SELECT id, email FROM auth.users WHERE active = true",
        dependencies: null,
        note: null,
        createdAt: null,
      },
      {
        id: "view-user-rollup",
        databaseId: database.id,
        name: "user_rollup",
        namespace: "reporting",
        materialized: true,
        definition: "SELECT count(*) AS total FROM auth.users",
        dependencies: null,
        note: null,
        createdAt: null,
      },
    ] as ViewType[];

    const sql = await getRenderer(DatabaseDialect.POSTGRES, getDataTypes(DatabaseDialect.POSTGRES))!.renderDDL(database);
    expect(sql).toMatch(/CREATE VIEW reporting\.active_users AS\s+SELECT\s+id,\s+email\s+FROM\s+auth\.users/i);
    expect(sql).toMatch(/CREATE MATERIALIZED VIEW reporting\.user_rollup AS\s+SELECT\s+count\(\*\) AS total\s+FROM\s+auth\.users/i);
  });
});

describe("getRenderer().renderDDL - sequences", () => {
  it("renders namespaced PostgreSQL sequences with options", async () => {
    const database = buildSampleDatabase(DatabaseDialect.POSTGRES);
    database.sequences = [{
      id: "sequence-order",
      databaseId: database.id,
      name: "order_seq",
      namespace: "reporting",
      definition: "START WITH 100 INCREMENT BY 5 CACHE 10",
      note: null,
      createdAt: null,
    }] as SequenceType[];

    const sql = await getRenderer(DatabaseDialect.POSTGRES, getDataTypes(DatabaseDialect.POSTGRES))!.renderDDL(database);
    expect(sql).toMatch(/CREATE SEQUENCE reporting\.order_seq START\s+WITH\s+100 INCREMENT BY 5 CACHE 10/i);
  });

  it("rejects sequences for SQLite instead of emitting unsupported DDL", async () => {
    const database = buildSampleDatabase(DatabaseDialect.SQLITE);
    database.sequences = [{
      id: "sequence-order",
      databaseId: database.id,
      name: "order_seq",
      namespace: null,
      definition: "",
      note: null,
      createdAt: null,
    }] as SequenceType[];

    await expect(getRenderer(DatabaseDialect.SQLITE, getDataTypes(DatabaseDialect.SQLITE))!.renderDDL(database))
      .rejects.toThrow(/does not support sequences/i);
  });
});

const renderCompositeForeignKey = (dialect: DatabaseDialect): Promise<string> => {
  const database = buildSampleDatabase(dialect);
  const users = database.tables.find((table) => table.name === "users")!;
  const posts = database.tables.find((table) => table.name === "posts")!;
  const usersEmail = users.fields.find((field) => field.name === "email")!;
  const postsTitle = posts.fields.find((field) => field.name === "title")!;
  const relationship = database.relationships[0];

  // extend the existing posts -> users FK (users.id -> posts.user_id) into a
  // composite one by pairing a second column: users.email -> posts.title.
  relationship.relationshipFields = [
    {
      id: "rel_posts_users.1",
      relationshipId: relationship.id,
      sourceFieldId: usersEmail.id,
      targetFieldId: postsTitle.id,
      sequence: 1,
    },
  ] as any;

  return getRenderer(dialect, getDataTypes(dialect))!.renderDDL(database);
};

describe("getRenderer().renderDDL - composite foreign keys", () => {
  for (const dialectCase of cases) {
    it(`renders a multi-column foreign key for ${dialectCase.name}`, async () => {
      const sql = await renderCompositeForeignKey(dialectCase.dialect);

      expect(sql).toMatch(/FOREIGN KEY\s*\(\s*[`"]?user_id[`"]?\s*,\s*[`"]?title[`"]?\s*\)/i);
      expect(sql).toMatch(/REFERENCES\s+[`"]?users[`"]?\s*\(\s*[`"]?id[`"]?\s*,\s*[`"]?email[`"]?\s*\)/i);
    });
  }
});
