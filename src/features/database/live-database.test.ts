import { beforeAll, describe, expect, it } from "vitest";
import { init } from "@guanmingchiu/sqlparser-ts";
import { DatabaseDialect } from "@/lib/database";
import { getDataTypes } from "@/test/fixtures/data-types";
import { makeDatabase, makeTable } from "@/test/fixtures/dbml-builders";
import { getImporter } from "@/utils/import/import-utils";
import { prepareSqlSchemaChange } from "@/utils/import/prepare-sql-schema-change";
import { PAGE_CONNECTION_KEYS, isValidDatabaseName, liveSchemaSql, liveTargetFromImport, readLivePreference, rememberConnectionOnPages, suggestDatabaseName, writeLivePreference } from "./live-database";

const dialect = DatabaseDialect.POSTGRES;
const dataTypes = getDataTypes(dialect);

beforeAll(async () => {
    await init();
});

describe("database names", () => {
    it("suggests a valid name from whatever the diagram is called", () => {
        expect(suggestDatabaseName("db_example")).toBe("db_example");
        expect(suggestDatabaseName("My Shop (2)")).toBe("my_shop_2");
        expect(suggestDatabaseName("Café Münster")).toBe("cafe_munster");
        expect(suggestDatabaseName("2026 plan")).toBe("db_2026_plan");
        expect(suggestDatabaseName("   ")).toBe("database");
        expect(suggestDatabaseName(undefined)).toBe("database");
        expect(suggestDatabaseName("x".repeat(100))).toHaveLength(63);
        for (const name of ["db_example", "My Shop (2)", "2026 plan", "!!!", "x".repeat(100), "-"]) expect(isValidDatabaseName(suggestDatabaseName(name)), name).toBe(true);
    });

    it("accepts what the server accepts and nothing else", () => {
        for (const ok of ["a", "_a", "Sales_2026", "a".repeat(63)]) expect(isValidDatabaseName(ok), ok).toBe(true);
        for (const bad of ["", "1a", "a b", "a-b", 'a"b', "a;b", "a".repeat(64), "é"]) expect(isValidDatabaseName(bad), bad).toBe(false);
    });
});

const DBML = `
Table regions {
  id uuid [pk]
  code varchar(20) [not null]
}
Table opportunities {
  id uuid [pk]
  region_id uuid [not null, ref: > regions.id]
  title varchar(255) [not null]
}
`;

describe("the script that builds a live database", () => {
    it("is plain PostgreSQL that creates every pasted table, its keys and its relationship", async () => {
        const empty = makeDatabase(dialect, []);
        const { targetDatabase } = await prepareSqlSchemaChange(DBML, empty, dataTypes);
        const sql = await liveSchemaSql(targetDatabase, dataTypes);

        expect(sql).toMatch(/CREATE TABLE\s+(IF NOT EXISTS\s+)?"?regions"?/i);
        expect(sql).toMatch(/CREATE TABLE\s+(IF NOT EXISTS\s+)?"?opportunities"?/i);
        expect(sql).toMatch(/PRIMARY KEY/i);
        expect(sql).toMatch(/FOREIGN KEY|REFERENCES/i);
        expect(sql).not.toMatch(/CREATE DATABASE|\\connect|USE\s/i);
    });

    it("refuses a diagram that is not PostgreSQL", async () => {
        const mysql = makeDatabase(DatabaseDialect.MYSQL, []);
        await expect(liveSchemaSql(mysql, getDataTypes(DatabaseDialect.MYSQL))).rejects.toThrow(/Only PostgreSQL schemas/);
    });
});

describe("what an import leaves behind", () => {
    const parse = (sql: string) => getImporter(dialect, dataTypes)!.parseSql(sql);

    it("is the imported schema alone when the diagram is empty", async () => {
        const target = liveTargetFromImport(parse("CREATE TABLE a (id uuid PRIMARY KEY); CREATE TABLE b (id uuid PRIMARY KEY, a_id uuid REFERENCES a(id));"), makeDatabase(dialect, []), dataTypes);
        expect(target.tables.map((table) => table.name).sort()).toEqual(["a", "b"]);
        expect(target.relationships).toHaveLength(1);
    });

    it("keeps the tables the diagram already has, because importing adds to a diagram", async () => {
        const existing = makeDatabase(dialect, [makeTable(dialect, "legacy", [{ name: "id", type: "uuid", primary: true }])]);
        const target = liveTargetFromImport(parse("CREATE TABLE a (id uuid PRIMARY KEY);"), existing, dataTypes);
        expect(target.tables.map((table) => table.name).sort()).toEqual(["a", "legacy"]);
        expect(target.numOfTables).toBe(2);
        const sql = await liveSchemaSql(target, dataTypes);
        expect(sql).toMatch(/"?legacy"?/);
        expect(sql).toMatch(/"?a"?\s*\(/);
    });
});

describe("what the option remembers", () => {
    const memory = () => {
        const data = new Map<string, string>();
        return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
    };

    it("keeps the switch and the server, and starts from nothing", () => {
        const storage = memory();
        expect(readLivePreference(storage)).toBeUndefined();
        writeLivePreference({ enabled: false, connectionId: "c1" }, storage);
        expect(readLivePreference(storage)).toEqual({ enabled: false, connectionId: "c1" });
        storage.data.set("goforge.liveDatabase.v1", "not json");
        expect(readLivePreference(storage)).toBeUndefined();
    });

    it("points every page that remembers a connection at the new database", () => {
        const storage = memory();
        rememberConnectionOnPages("new-db", storage);
        for (const key of PAGE_CONNECTION_KEYS) expect(storage.data.get(key), key).toBe("new-db");
        expect(PAGE_CONNECTION_KEYS).toEqual(expect.arrayContaining(["goforge.sql.connection", "goforge.schemaChange.connection", "goforge.modernizer.connection"]));
    });

    it("does not fail when storage is blocked", () => {
        const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
        expect(readLivePreference(blocked)).toBeUndefined();
        expect(() => writeLivePreference({ enabled: true }, blocked)).not.toThrow();
        expect(() => rememberConnectionOnPages("x", blocked)).not.toThrow();
    });
});
