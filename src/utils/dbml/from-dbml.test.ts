import { describe, expect, it } from "vitest";
import { DatabaseDialect } from "@/lib/database";
import { Cardinality } from "@/lib/schemas/relationship-schema";
import { getDataTypes } from "@/test/fixtures/data-types";
import { idFactory, parse, typeNamed } from "@/test/fixtures/dbml-builders";
import { parseProjectFile, projectToBundle } from "../project-file";
import { DbmlParseError, parseDbml } from "./from-dbml";

describe("parseDbml", () => {
    const dialect = DatabaseDialect.POSTGRES;

    const SAMPLE = `
Project shop {
  database_type: 'PostgreSQL'
}

Enum order_status {
  pending
  shipped
}

Table users [headerColor: #3366ff, note: 'ignored header note'] {
  id integer [pk, increment]
  email varchar(255) [unique, not null, note: 'login']
  balance numeric(10,2) [default: 0]
  created_at timestamp [default: \`now()\`]
  Note: 'People'

  indexes {
    (email, created_at) [name: 'ix_email_created', unique]
  }
  checks {
    \`balance >= 0\` [name: 'chk_balance']
  }
}

Table sales.orders {
  id integer [pk]
  user_id integer [not null, ref: > users.id]
  status order_status [default: 'pending']
}

Table links {
  a integer
  b integer
  indexes {
    (a, b) [pk]
  }
}
`;

    it("builds tables, fields, types and defaults", async () => {
        const { file, warnings } = await parse(SAMPLE, dialect);
        const users = file.project.tables.find((table) => table.name === "users")!;
        expect(file.project.name).toBe("shop");
        expect(file.project.dialect).toBe(dialect);
        expect(users.note).toBe("People");
        expect(users.color).toBe("#3366ff");

        const id = users.fields.find((field) => field.name === "id")!;
        expect(id).toMatchObject({ isPrimary: true, nullable: false, autoIncrement: true });
        const email = users.fields.find((field) => field.name === "email")!;
        expect(email).toMatchObject({ unique: true, nullable: false, maxLength: 255, note: "login" });
        expect(email.typeId).toBe(typeNamed(dialect, "varchar").id);
        const balance = users.fields.find((field) => field.name === "balance")!;
        expect(balance).toMatchObject({ precision: 10, scale: 2, defaultValue: "0" });
        expect(users.fields.find((field) => field.name === "created_at")!.defaultValue).toBe("now");
        expect(warnings).toEqual([]);
    });

    it("builds indexes, composite primary keys and checks", async () => {
        const { file } = await parse(SAMPLE, dialect);
        const users = file.project.tables.find((table) => table.name === "users")!;
        expect(users.indices).toHaveLength(1);
        expect(users.indices[0]).toMatchObject({ name: "ix_email_created", unique: true });
        expect(users.indices[0].fieldIndices).toHaveLength(2);
        expect(users.checks).toEqual([expect.objectContaining({ name: "chk_balance", expression: "balance >= 0" })]);

        const links = file.project.tables.find((table) => table.name === "links")!;
        expect(links.fields.map((field) => field.isPrimary)).toEqual([true, true]);
        expect(links.indices).toHaveLength(0);
    });

    it("maps schemas to namespaces and refs to relationships with the right direction", async () => {
        const { file } = await parse(SAMPLE, dialect);
        const orders = file.project.tables.find((table) => table.name === "orders")!;
        const users = file.project.tables.find((table) => table.name === "users")!;
        expect(orders.namespace).toBe("sales");
        expect(users.namespace).toBeNull();

        expect(file.project.relationships).toHaveLength(1);
        const [relationship] = file.project.relationships;
        // The referenced table is the source; the table holding the key is the target.
        expect(relationship.sourceTableId).toBe(users.id);
        expect(relationship.targetTableId).toBe(orders.id);
        expect(relationship.cardinality).toBe(Cardinality.one_to_many);
        expect(orders.fields.find((field) => field.name === "user_id")!.isForeign).toBe(true);
    });

    it("reads composite references, actions, one-to-one and many-to-many", async () => {
        const { file } = await parse(`
Table a {
  x integer
  y integer
}
Table b {
  x integer
  y integer
  solo integer
}
Table c {
  id integer
}
Ref fk: b.(x, y) > a.(x, y) [delete: set null, update: cascade]
Ref: c.id - b.solo
Ref: a.x <> c.id
`, dialect);
        const byName = (name: string) => file.project.tables.find((table) => table.name === name)!;
        const composite = file.project.relationships.find((relationship) => relationship.name === "fk")!;
        expect(composite.sourceTableId).toBe(byName("a").id);
        expect(composite.targetTableId).toBe(byName("b").id);
        expect(composite.onDelete).toBe("set_null");
        expect(composite.onUpdate).toBe("cascade");
        expect(composite.relationshipFields).toHaveLength(1);
        expect(composite.relationshipFields[0].sequence).toBe(1);

        const oneToOne = file.project.relationships.find((relationship) => relationship.cardinality === Cardinality.one_to_one)!;
        expect(oneToOne.sourceTableId).toBe(byName("c").id);
        expect(file.project.relationships.some((relationship) => relationship.cardinality === Cardinality.many_to_many)).toBe(true);
    });

    it("stores enums on dialects that have an enum type", async () => {
        const { file } = await parse(SAMPLE, dialect);
        const orders = file.project.tables.find((table) => table.name === "orders")!;
        const status = orders.fields.find((field) => field.name === "status")!;
        expect(status.typeId).toBe(typeNamed(dialect, "enum").id);
        expect(JSON.parse(status.values as string)).toEqual(["pending", "shipped"]);
        expect(status.defaultValue).toBe("pending");
    });

    it("warns instead of silently dropping unsupported DBML", async () => {
        const { file, warnings } = await parse(`
Table t {
  id integer [pk]
  weird gibberishtype
  token uuid [default: \`some_custom_fn()\`]
  indexes {
    \`lower(name)\` [name: 'ix_lower']
    id [type: hash]
  }
  checks {
    \`id > 0; drop table t\` [name: 'chk_bad']
  }
}
TableGroup g {
  t
}
`, dialect);
        const codes = warnings.map((warning) => warning.code).sort();
        expect(codes).toEqual(["ignored-index-type", "ignored-table-groups", "unknown-type", "unsupported-check", "unsupported-default", "unsupported-index"]);
        const table = file.project.tables[0];
        expect(table.checks).toHaveLength(0);
        // The unknown type still imports, as text, so the table is usable.
        const weird = table.fields.find((field) => field.name === "weird")!;
        expect(weird.typeId).toBeTruthy();
    });

    it("names unnamed checks and honours inline column checks", async () => {
        const { file } = await parse(`
Table t {
  qty integer [check: \`qty > 0\`]
  price integer
  checks {
    \`price >= 0\`
  }
}
`, dialect);
        const names = file.project.tables[0].checks!.map((check) => check.name);
        expect(names).toHaveLength(2);
        expect(new Set(names).size).toBe(2);
        names.forEach((name) => expect(name).toMatch(/^chk_t_/));
    });

    it("produces a file the project importer accepts", async () => {
        const { file } = await parse(SAMPLE, dialect);
        const typeIds = new Set(getDataTypes(dialect).map((dataType) => dataType.id as string));
        const validated = parseProjectFile(JSON.stringify(file), typeIds);
        const bundle = projectToBundle(validated, idFactory, "From DBML");
        expect(bundle.tables).toHaveLength(3);
        expect(bundle.relationships).toHaveLength(1);
        expect(bundle.indexes).toHaveLength(1);
    });

    it("reports a syntax error with its position", async () => {
        const failure = await parse("Table x {\n id integer [pk\n}", dialect).catch((error) => error);
        expect(failure).toBeInstanceOf(DbmlParseError);
        expect(failure.details[0]).toMatch(/line \d+, column \d+/);
    });

    it("matches type synonyms and aliases", async () => {
        const { file, warnings } = await parse(`
Table t {
  a "character varying"(20)
  b int
  c string
  d float8
}
`, dialect);
        const typeOf = (name: string) => getDataTypes(dialect).find((dataType) => dataType.id === file.project.tables[0].fields.find((field) => field.name === name)!.typeId)!.name;
        expect(typeOf("a")).toBe("varchar");
        expect(file.project.tables[0].fields[0].maxLength).toBe(20);
        expect(typeOf("b")).toBe("integer");
        expect(typeOf("c")).toBe("varchar");
        expect(typeOf("d")).toBe("double precision");
        expect(warnings).toEqual([]);
    });

    it("falls back to a default project name", async () => {
        const result = await parseDbml("Table t {\n id integer\n}", { dialect, dataTypes: getDataTypes(dialect), fallbackName: "my.dbml", newId: idFactory });
        expect(result.file.project.name).toBe("my.dbml");
    });
});

