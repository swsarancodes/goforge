import { describe, expect, it } from "vitest";
import { DatabaseDialect } from "@/lib/database";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { parse } from "@/test/fixtures/dbml-builders";
import { toDbml } from "@/utils/dbml/to-dbml";
import { isDestructiveSqlOperation } from "./prepare-sql-schema-change";
import { prepareProjectFileChange } from "./prepare-project-change";
import { summarizeSchemaChange } from "./summarize-schema-change";

const dialect = DatabaseDialect.POSTGRES;
const dataTypes = getDataTypes(dialect);

// The sample project is a minimal fixture; fill in what a stored project always has.
const current = () => {
    const database = buildSampleDatabase(dialect);
    for (const table of database.tables) {
        table.databaseId = database.id;
        table.posX = 100;
        table.posY = 50;
        table.fields.forEach((field, index) => {
            field.sequence = index;
            field.isForeign = false;
            field.type = dataTypes.find((dataType) => dataType.id === field.typeId)!;
        });
    }
    for (const relationship of database.relationships) relationship.onUpdate = "no_action";
    return database;
};

const fileFrom = async (dbml: string, as: DatabaseDialect = dialect) => (await parse(dbml, as)).file;

describe("prepareProjectFileChange", () => {
    it("sees nothing to do when the file describes the open project", async () => {
        const database = current();
        const file = await fileFrom(toDbml(database).dbml);
        for (const mode of ["merge", "replace"] as const) {
            const change = prepareProjectFileChange(file, database, dataTypes, mode);
            const summary = summarizeSchemaChange(change.operations, database, change.targetDatabase);
            expect(summary.isEmpty, `${mode}: ${JSON.stringify(summary)}`).toBe(true);
        }
    });

    const EDITED = `
Table users {
  id integer [pk, increment]
  email varchar(255) [unique, not null]
  status varchar(20) [not null, default: 'active']
  nickname varchar(40)
}

Table comments {
  id integer [pk]
  body text
}
`;

    it("merge adds and updates but never deletes", async () => {
        const database = current();
        const change = prepareProjectFileChange(await fileFrom(EDITED), database, dataTypes, "merge");
        const summary = summarizeSchemaChange(change.operations, database, change.targetDatabase);

        expect(summary.tablesAdded).toEqual(["comments"]);
        expect(summary.tablesRemoved).toEqual([]);
        expect(summary.tablesChanged).toEqual([{ name: "users", details: ["1 field added"] }]);
        expect(change.destructiveOperations).toEqual([]);
        expect(change.operations.some(isDestructiveSqlOperation)).toBe(false);
    });

    it("replace also removes what the file leaves out, and flags it as destructive", async () => {
        const database = current();
        const change = prepareProjectFileChange(await fileFrom(EDITED), database, dataTypes, "replace");
        const summary = summarizeSchemaChange(change.operations, database, change.targetDatabase);

        expect(summary.tablesAdded).toEqual(["comments"]);
        expect(summary.tablesRemoved).toEqual(["posts"]);
        expect(change.destructiveOperations.length).toBeGreaterThan(0);
    });

    it("keeps the ids and positions of tables that already exist", async () => {
        const database = current();
        const change = prepareProjectFileChange(await fileFrom(EDITED), database, dataTypes, "merge");
        const users = change.targetDatabase.tables.find((table) => table.name === "users")!;
        expect(users.id).toBe("users");
        expect(users.posX).toBe(100);
        expect(change.operations.some((operation) => operation.type === "CREATE_TABLE" && operation.table.name === "users")).toBe(false);
    });

    it("places new tables beside the diagram instead of on top of it", async () => {
        const database = current();
        const change = prepareProjectFileChange(await fileFrom(EDITED), database, dataTypes, "merge");
        const created = change.operations.find((operation) => operation.type === "CREATE_TABLE");
        expect(created?.type === "CREATE_TABLE" && created.table.posX).toBeGreaterThanOrEqual(100 + 260);
    });

    it("reports relationship edits", async () => {
        const database = current();
        const dbml = toDbml(database).dbml.replace("[delete: cascade]", "[delete: set null]");
        const change = prepareProjectFileChange(await fileFrom(dbml), database, dataTypes, "merge");
        const summary = summarizeSchemaChange(change.operations, database, change.targetDatabase);
        expect(summary.relationships).toEqual({ added: 0, removed: 0, changed: 1 });
    });

    it("refuses a file written for another dialect", async () => {
        const database = current();
        const file = await fileFrom("Table t {\n id integer\n}", DatabaseDialect.MYSQL);
        expect(() => prepareProjectFileChange(file, database, dataTypes, "merge")).toThrow(/mysql.*postgres/i);
    });
});
