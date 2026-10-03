import { describe, expect, it } from "vitest";
import { DatabaseDialect } from "@/lib/database";
import { Cardinality } from "@/lib/schemas/relationship-schema";
import { makeDatabase, makeTable } from "@/test/fixtures/dbml-builders";
import { detectDbmlDialect, dialectFromDatabaseType } from "./dbml-shared";
import { toDbml } from "./to-dbml";

describe("DBML dialect detection", () => {
    it("maps database_type spellings to dialects", () => {
        expect(dialectFromDatabaseType("PostgreSQL")).toBe(DatabaseDialect.POSTGRES);
        expect(dialectFromDatabaseType("SQL Server")).toBe(DatabaseDialect.MSSQL);
        expect(dialectFromDatabaseType("MariaDB")).toBe(DatabaseDialect.MARIADB);
        expect(dialectFromDatabaseType("Snowflake")).toBeUndefined();
        expect(detectDbmlDialect("Project p {\n  database_type: 'MySQL'\n}")).toBe(DatabaseDialect.MYSQL);
        expect(detectDbmlDialect("Table t {\n id int\n}")).toBeUndefined();
    });
});

describe("toDbml", () => {
    const dialect = DatabaseDialect.POSTGRES;

    it("writes columns, keys, defaults and notes", () => {
        const users = makeTable(dialect, "users", [
            { name: "id", type: "integer", primary: true, autoIncrement: true },
            { name: "email", type: "varchar", maxLength: 255, unique: true, nullable: false, note: "login name" },
            { name: "balance", type: "numeric", precision: 10, scale: 2, defaultValue: "0" },
            { name: "created_at", type: "timestamp", defaultValue: "now" },
            { name: "active", type: "boolean", defaultValue: "true" },
            { name: "role", type: "varchar", maxLength: 20, defaultValue: "it's admin" },
        ], { note: "People who can sign in", color: "#ff8800" });
        const { dbml, warnings } = toDbml(makeDatabase(dialect, [users]));

        expect(dbml).toContain("database_type: 'PostgreSQL'");
        expect(dbml).toContain("Table users [headerColor: #ff8800] {");
        expect(dbml).toContain("id integer [pk, increment]");
        expect(dbml).toContain("email varchar(255) [unique, not null, note: 'login name']");
        expect(dbml).toContain("balance numeric(10,2) [default: 0]");
        expect(dbml).toContain("created_at timestamp [default: `now()`]");
        expect(dbml).toContain("active boolean [default: true]");
        expect(dbml).toContain("role varchar(20) [default: 'it\\'s admin']");
        expect(dbml).toContain("Note: 'People who can sign in'");
        expect(warnings).toEqual([]);
    });

    it("writes composite keys, indexes, checks and foreign keys", () => {
        const memberships = makeTable(dialect, "memberships", [
            { name: "user_id", type: "integer", primary: true },
            { name: "org_id", type: "integer", primary: true },
            { name: "level", type: "integer" },
        ], {
            indices: [{ id: "i1", tableId: "memberships", name: "ix_level", unique: false, fieldIndices: [{ id: "f1", indexId: "i1", fieldId: "memberships.level" }] }],
            checks: [{ id: "c1", tableId: "memberships", name: "chk_level", expression: "level >= 0" }],
        });
        const audit = makeTable(dialect, "audit", [
            { name: "id", type: "integer", primary: true },
            { name: "user_id", type: "integer" },
            { name: "org_id", type: "integer" },
        ]);
        const relationship = {
            id: "r1", name: "fk_audit_membership", cardinality: Cardinality.one_to_many,
            sourceTableId: "memberships", targetTableId: "audit",
            sourceFieldId: "memberships.user_id", targetFieldId: "audit.user_id",
            onDelete: "cascade", onUpdate: "no_action",
            relationshipFields: [{ id: "rf1", relationshipId: "r1", sourceFieldId: "memberships.org_id", targetFieldId: "audit.org_id", sequence: 1 }],
        };
        const { dbml } = toDbml(makeDatabase(dialect, [memberships, audit], [relationship]));

        expect(dbml).toContain("(user_id, org_id) [pk]");
        expect(dbml).toContain("level [name: 'ix_level']");
        expect(dbml).toContain("`level >= 0` [name: 'chk_level']");
        expect(dbml).toContain("Ref fk_audit_membership: audit.(user_id, org_id) > memberships.(user_id, org_id) [delete: cascade]");
    });

    it("quotes names that are not plain identifiers and writes namespaces", () => {
        const table = makeTable(dialect, "order items", [{ name: "unit price", type: "integer" }], { namespace: "sales" });
        const { dbml } = toDbml(makeDatabase(dialect, [table]));
        expect(dbml).toContain('Table sales."order items" {');
        expect(dbml).toContain('"unit price" integer');
    });

    it("emits MySQL enum columns as Enum blocks", () => {
        const mysql = DatabaseDialect.MYSQL;
        const table = makeTable(mysql, "tickets", [
            { name: "id", type: "integer", primary: true },
            { name: "state", type: "enum", values: ["open", "closed"], defaultValue: "open" },
        ]);
        const { dbml } = toDbml(makeDatabase(mysql, [table]));
        expect(dbml).toContain("Enum tickets_state {\n  open\n  closed\n}");
        expect(dbml).toContain("state tickets_state [default: 'open']");
    });

    it("reports what DBML cannot express instead of dropping it silently", () => {
        const table = makeTable(dialect, "t", [{ name: "id", type: "integer", primary: true }], {
            checks: [{ id: "c", tableId: "t", name: "chk_tick", expression: "`id` > 0" }],
        });
        const { dbml, warnings } = toDbml(makeDatabase(dialect, [table], [], {
            views: [{ id: "v", databaseId: "db", name: "recent", namespace: null, materialized: false, definition: "select 1", dependencies: null, note: null, createdAt: null }],
            sequences: [{ id: "s", databaseId: "db", name: "order_seq", namespace: null, definition: "", note: null, createdAt: null }],
        }));
        expect(warnings.map((warning) => warning.code).sort()).toEqual(["unsupported-check", "unsupported-sequence", "unsupported-view"]);
        expect(dbml).toContain("// View recent was not exported");
        expect(dbml).toContain("// Sequence order_seq was not exported");
    });
});

