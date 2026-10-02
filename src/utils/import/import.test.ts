import { describe, it, expect, beforeAll } from "vitest";
import { init } from "@guanmingchiu/sqlparser-ts";

import { DatabaseDialect } from "@/lib/database";
import { getImporter } from "@/utils/import/import-utils";
import { getDataTypes } from "@/test/fixtures/data-types";
import { PostgresSqlExample } from "@/lib/import/import_db";
import { TableInsertType } from "@/lib/schemas/table-schema";
import { FieldInsertType } from "@/lib/schemas/field-schema";

// The parser is a WASM module whose init() is async. BaseSqlImporter's
// constructor kicks it off but does not await it (fine in the browser, where
// the promise resolves long before a user imports SQL). In tests we must await
// it once up front; init() caches the module globally, so every subsequent
// synchronous parseSql() call across all dialects then works.
beforeAll(async () => {
  await init();
});

const getField = (table: TableInsertType, name: string): FieldInsertType =>
  (table.fields ?? []).find((f) => f.name === name) as FieldInsertType;

interface DialectCase {
  name: string;
  dialect: DatabaseDialect;
  sql: string;
  // MySQL / MariaDB / SQL Server surface AUTO_INCREMENT / IDENTITY; the others do not.
  idAutoIncrement: boolean;
  // SQLite uses TEXT (no length); the rest carry a VARCHAR length.
  varcharMaxLength: number | undefined;
  // Only the MySQL and PostgreSQL fixtures include a CREATE INDEX statement.
  indexCount: number;
  // Only the fixtures that spell out ON DELETE CASCADE carry an onDelete action.
  fkOnDelete: string | undefined;
}

const cases: DialectCase[] = [
  {
    name: "MySQL",
    dialect: DatabaseDialect.MYSQL,
    idAutoIncrement: true,
    varcharMaxLength: 255,
    indexCount: 1,
    fkOnDelete: "cascade",
    sql: `
CREATE TABLE users (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
);
CREATE TABLE posts (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title VARCHAR(255) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX idx_posts_user_id ON posts (user_id);
`,
  },
  {
    name: "MariaDB",
    dialect: DatabaseDialect.MARIADB,
    idAutoIncrement: true,
    varcharMaxLength: 255,
    indexCount: 0,
    fkOnDelete: "cascade",
    sql: `
CREATE TABLE users (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
);
CREATE TABLE posts (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title VARCHAR(255) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
`,
  },
  {
    name: "PostgreSQL",
    dialect: DatabaseDialect.POSTGRES,
    idAutoIncrement: false,
    varcharMaxLength: 255,
    indexCount: 1,
    fkOnDelete: "cascade",
    sql: `
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
CREATE INDEX idx_posts_user_id ON posts (user_id);
`,
  },
  {
    name: "SQLite",
    dialect: DatabaseDialect.SQLITE,
    idAutoIncrement: false,
    varcharMaxLength: undefined,
    indexCount: 0,
    fkOnDelete: "cascade",
    sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
`,
  },
  {
    name: "Oracle",
    dialect: DatabaseDialect.ORACLE,
    idAutoIncrement: false,
    varcharMaxLength: 255,
    indexCount: 0,
    fkOnDelete: undefined,
    sql: `
CREATE TABLE users (
  id NUMBER PRIMARY KEY,
  email VARCHAR2(255) NOT NULL UNIQUE,
  status VARCHAR2(20) DEFAULT 'active' NOT NULL
);
CREATE TABLE posts (
  id NUMBER PRIMARY KEY,
  user_id NUMBER NOT NULL,
  title VARCHAR2(255) NOT NULL,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id)
);
`,
  },
  {
    name: "SQL Server",
    dialect: DatabaseDialect.MSSQL,
    idAutoIncrement: true,
    varcharMaxLength: 255,
    indexCount: 0,
    fkOnDelete: undefined,
    sql: `
CREATE TABLE users (
  id INT IDENTITY(1,1) PRIMARY KEY,
  email NVARCHAR(255) NOT NULL UNIQUE,
  status NVARCHAR(20) NOT NULL DEFAULT 'active'
);
CREATE TABLE posts (
  id INT IDENTITY(1,1) PRIMARY KEY,
  user_id INT NOT NULL,
  title NVARCHAR(255) NOT NULL,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id)
);
`,
  },
];

describe("getImporter().parseSql - CREATE TABLE across dialects", () => {
  for (const c of cases) {
    describe(c.name, () => {
      const parse = () =>
        getImporter(c.dialect, getDataTypes(c.dialect)).parseSql(c.sql);
      const typeById = new Map(
        getDataTypes(c.dialect).map((dt) => [dt.id, dt]),
      );

      it("parses both tables with their columns and no errors", () => {
        const r = parse();

        expect(r.errors).toHaveLength(0);
        expect(r.tables.map((t) => t.name).sort()).toEqual(["posts", "users"]);
        const users = r.tables.find(
          (t) => t.name === "users",
        ) as TableInsertType;
        const posts = r.tables.find(
          (t) => t.name === "posts",
        ) as TableInsertType;

        expect(users.fields).toHaveLength(3);
        expect(posts.fields).toHaveLength(3);
      });

      it("maps the primary key column", () => {
        const users = parse().tables.find(
          (t) => t.name === "users",
        ) as TableInsertType;
        const id = getField(users, "id");

        expect(id.isPrimary).toBe(true);
        expect(id.nullable).toBe(false);
        expect(id.autoIncrement).toBe(c.idAutoIncrement);
        // id resolves to a numeric family type (integer, or numeric for Oracle NUMBER)
        expect(["integer", "numeric"]).toContain(
          typeById.get(id.typeId as string)?.type,
        );
      });

      it("maps a NOT NULL UNIQUE text column with its length", () => {
        const users = parse().tables.find(
          (t) => t.name === "users",
        ) as TableInsertType;
        const email = getField(users, "email");

        expect(email.unique).toBe(true);
        expect(email.nullable).toBe(false);
        expect(email.isPrimary).toBe(false);
        expect(typeById.get(email.typeId as string)?.type).toBe("text");
        expect(email.maxLength ?? undefined).toBe(c.varcharMaxLength);
      });

      it("parses the DEFAULT value", () => {
        const users = parse().tables.find(
          (t) => t.name === "users",
        ) as TableInsertType;
        const status = getField(users, "status");

        expect(status.defaultValue).toBe("active");
        expect(status.nullable).toBe(false);
      });

      it("captures the foreign key from posts to users", () => {
        const r = parse();
        const byName = new Map(r.tables.map((t) => [t.name, t.id]));

        expect(r.relationships).toHaveLength(1);
        const rel = r.relationships[0];

        // convention: source is the referenced (parent) table, target holds the FK
        expect(rel.sourceTableId).toBe(byName.get("users"));
        expect(rel.targetTableId).toBe(byName.get("posts"));
        expect(rel.cardinality).toBe("one_to_many");
        expect(rel.onDelete).toBe(c.fkOnDelete);
      });

      it("parses CREATE INDEX statements", () => {
        const r = parse();

        expect(r.indexes).toHaveLength(c.indexCount);
        if (c.indexCount > 0) {
          const posts = r.tables.find(
            (t) => t.name === "posts",
          ) as TableInsertType;

          expect(r.indexes[0].name).toBe("idx_posts_user_id");
          expect(r.indexes[0].tableId).toBe(posts.id);
        }
      });
    });
  }
});

describe("getImporter().parseSql - realistic and malformed input", () => {
  it("imports regular and materialized views with qualified names and definitions", () => {
    const result = getImporter(
      DatabaseDialect.POSTGRES,
      getDataTypes(DatabaseDialect.POSTGRES),
    ).parseSql(`
      CREATE VIEW reporting.active_users AS SELECT id, email FROM auth.users WHERE active = true;
      CREATE MATERIALIZED VIEW reporting.user_rollup AS SELECT count(*) AS total FROM auth.users;
    `);

    expect(result.errors).toEqual([]);
    expect(result.tables).toHaveLength(0);
    expect(result.views).toHaveLength(2);
    expect(result.views[0]).toMatchObject({
      name: "active_users",
      namespace: "reporting",
      materialized: false,
      definition: "SELECT id, email FROM auth.users WHERE active = true",
    });
    expect(result.views[1].materialized).toBe(true);
  });

  it("imports namespaced sequences and preserves their options", () => {
    const result = getImporter(
      DatabaseDialect.POSTGRES,
      getDataTypes(DatabaseDialect.POSTGRES),
    ).parseSql(`
      CREATE SEQUENCE reporting.order_seq START WITH 100 INCREMENT BY 5 CACHE 10;
    `);

    expect(result.errors).toEqual([]);
    expect(result.sequences).toHaveLength(1);
    expect(result.sequences[0]).toMatchObject({
      name: "order_seq",
      namespace: "reporting",
      definition: "START WITH 100 INCREMENT BY 5 CACHE 10",
    });
  });

  it("preserves namespaces while resolving qualified foreign keys", () => {
    const result = getImporter(
      DatabaseDialect.POSTGRES,
      getDataTypes(DatabaseDialect.POSTGRES),
    ).parseSql(`
      CREATE TABLE auth.users (
        id integer PRIMARY KEY
      );
      CREATE TABLE blog.posts (
        id integer PRIMARY KEY,
        user_id integer NOT NULL,
        CONSTRAINT posts_user_fk FOREIGN KEY (user_id) REFERENCES auth.users (id)
      );
    `);

    const users = result.tables.find((table) => table.name === "users");
    const posts = result.tables.find((table) => table.name === "posts");
    expect(result.errors).toEqual([]);
    expect(users?.namespace).toBe("auth");
    expect(posts?.namespace).toBe("blog");
    expect(result.relationships[0]).toMatchObject({
      sourceTableId: users?.id,
      targetTableId: posts?.id,
    });
  });

  it("preserves composite primary keys and named multi-column unique constraints", () => {
    const result = getImporter(
      DatabaseDialect.POSTGRES,
      getDataTypes(DatabaseDialect.POSTGRES),
    ).parseSql(`
      CREATE TABLE memberships (
        tenant_id integer NOT NULL,
        user_id integer NOT NULL,
        role varchar(40) NOT NULL,
        CONSTRAINT memberships_pk PRIMARY KEY (tenant_id, user_id),
        CONSTRAINT memberships_tenant_role_key UNIQUE (tenant_id, role)
      );
    `);
    const memberships = result.tables[0];
    const tenantId = getField(memberships, "tenant_id");
    const userId = getField(memberships, "user_id");
    const role = getField(memberships, "role");
    const uniqueConstraint = result.indexes.find(
      (index) => index.name === "memberships_tenant_role_key",
    );

    expect(result.errors).toEqual([]);
    expect([tenantId.isPrimary, userId.isPrimary]).toEqual([true, true]);
    expect([tenantId.unique, role.unique]).toEqual([false, false]);
    expect(uniqueConstraint?.unique).toBe(true);
    expect(uniqueConstraint?.fieldIndices?.map((item) => item.fieldId)).toEqual([
      tenantId.id,
      role.id,
    ]);
  });

  it("preserves multi-column unique constraints added with ALTER TABLE", () => {
    const result = getImporter(
      DatabaseDialect.POSTGRES,
      getDataTypes(DatabaseDialect.POSTGRES),
    ).parseSql(`
      CREATE TABLE memberships (
        tenant_id integer NOT NULL,
        external_id integer NOT NULL
      );
      ALTER TABLE memberships
        ADD CONSTRAINT memberships_external_key UNIQUE (tenant_id, external_id);
    `);

    expect(result.errors).toEqual([]);
    expect(result.indexes).toHaveLength(1);
    expect(result.indexes[0]).toMatchObject({
      name: "memberships_external_key",
      unique: true,
      tableId: result.tables[0].id,
    });
  });

  it("preserves composite foreign keys declared inline on CREATE TABLE", () => {
    const result = getImporter(
      DatabaseDialect.POSTGRES,
      getDataTypes(DatabaseDialect.POSTGRES),
    ).parseSql(`
      CREATE TABLE memberships (
        tenant_id integer NOT NULL,
        user_id integer NOT NULL,
        role varchar(40) NOT NULL,
        CONSTRAINT memberships_pk PRIMARY KEY (tenant_id, user_id)
      );
      CREATE TABLE membership_roles (
        tenant_id integer NOT NULL,
        user_id integer NOT NULL,
        granted_by varchar(40) NOT NULL,
        CONSTRAINT membership_roles_fk FOREIGN KEY (tenant_id, user_id)
          REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
      );
    `);

    expect(result.errors).toEqual([]);
    expect(result.relationships).toHaveLength(1);

    const memberships = result.tables.find((t) => t.name === "memberships") as TableInsertType;
    const membershipRoles = result.tables.find((t) => t.name === "membership_roles") as TableInsertType;
    const tenantId = getField(memberships, "tenant_id");
    const userId = getField(memberships, "user_id");
    const roleTenantId = getField(membershipRoles, "tenant_id");
    const roleUserId = getField(membershipRoles, "user_id");

    const rel = result.relationships[0];
    expect(rel.name).toBe("membership_roles_fk");
    expect(rel.sourceTableId).toBe(memberships.id);
    expect(rel.targetTableId).toBe(membershipRoles.id);
    expect(rel.sourceFieldId).toBe(tenantId.id);
    expect(rel.targetFieldId).toBe(roleTenantId.id);
    expect(rel.onDelete).toBe("cascade");

    // the first pair (tenant_id -> tenant_id) is carried by sourceFieldId/
    // targetFieldId above; the second pair (user_id -> user_id) is the only
    // entry in relationshipFields.
    expect(rel.relationshipFields).toHaveLength(1);
    expect(rel.relationshipFields?.[0]).toMatchObject({
      sourceFieldId: userId.id,
      targetFieldId: roleUserId.id,
      sequence: 1,
    });
  });

  it("rejects a foreign key whose column lists have mismatched length", () => {
    const result = getImporter(
      DatabaseDialect.POSTGRES,
      getDataTypes(DatabaseDialect.POSTGRES),
    ).parseSql(`
      CREATE TABLE memberships (
        tenant_id integer NOT NULL,
        user_id integer NOT NULL,
        CONSTRAINT memberships_pk PRIMARY KEY (tenant_id, user_id)
      );
      CREATE TABLE membership_roles (
        tenant_id integer NOT NULL,
        CONSTRAINT membership_roles_fk FOREIGN KEY (tenant_id)
          REFERENCES memberships (tenant_id, user_id)
      );
    `);

    expect(result.relationships).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it("parses the bundled PostgreSQL dump", () => {
    const r = getImporter(
      DatabaseDialect.POSTGRES,
      getDataTypes(DatabaseDialect.POSTGRES),
    ).parseSql(PostgresSqlExample);

    expect(r.tables.length).toBe(4);
    expect(r.relationships.length).toBe(3);
    expect(r.errors).toHaveLength(0);
  });

  it("collects errors from a malformed statement without dropping valid tables", () => {
    const r = getImporter(
      DatabaseDialect.POSTGRES,
      getDataTypes(DatabaseDialect.POSTGRES),
    ).parseSql(
      "CREATE TABLE good (id integer PRIMARY KEY); CREATE TABLE bad (;",
    );

    expect(r.tables.map((t) => t.name)).toContain("good");
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("handles mixed DDL, DML, comments, quoted semicolons, and case variations", () => {
    const r = getImporter(
      DatabaseDialect.POSTGRES,
      getDataTypes(DatabaseDialect.POSTGRES),
    ).parseSql(`
      -- DML should be ignored by the schema importer
      insert into audit_log(message) values ('keep;this;as;text');
      /* A block comment should not hide the next schema statement. */
      Create Table users (
        id integer primary key,
        note text default 'a;value'
      );
      UPDATE users SET note = 'updated';
      cReAtE vIeW reporting.user_notes AS
        select id, note from users;
      COMMIT;
    `);

    expect(r.errors).toEqual([]);
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0].name).toBe("users");
    expect(r.views).toHaveLength(1);
    expect(r.views[0].name).toBe("user_notes");
    expect(r.views[0].definition).toContain("select id, note from users");
  });

  it("supports SQL Server GO batch separators without treating DML as an error", () => {
    const r = getImporter(
      DatabaseDialect.MSSQL,
      getDataTypes(DatabaseDialect.MSSQL),
    ).parseSql(`
      CREATE TABLE [dbo].[users] (
        [id] INT IDENTITY(1,1) PRIMARY KEY,
        [name] NVARCHAR(100) NOT NULL
      )
      GO
      INSERT INTO [dbo].[users] ([name]) VALUES ('Ada');
      GO
      CREATE TABLE [dbo].[posts] (
        [id] INT IDENTITY(1,1) PRIMARY KEY,
        [user_id] INT NOT NULL
      );
    `);

    expect(r.errors).toEqual([]);
    expect(r.tables.map((table) => table.name).sort()).toEqual(["posts", "users"]);
  });

  it("throws when there is nothing parseable", () => {
    const importer = getImporter(
      DatabaseDialect.POSTGRES,
      getDataTypes(DatabaseDialect.POSTGRES),
    );

    expect(() => importer.parseSql("this is not sql at all")).toThrow();
  });
});
