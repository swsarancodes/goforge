import { beforeAll, describe, expect, it } from "vitest";
import { init } from "@guanmingchiu/sqlparser-ts";

import { DatabaseDialect } from "@/lib/database";
import { ForeignKeyActions } from "@/lib/field";
import { getRenderer } from "@/utils/render/render-uttils";
import { getImporter } from "@/utils/import/import-utils";
import { getDataTypes } from "@/test/fixtures/data-types";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { CheckConstraintType } from "@/lib/schemas/check-constraint-schema";
import { prepareSqlSchemaChange } from "@/utils/import/prepare-sql-schema-change";

beforeAll(async () => {
    await init();
});

const hydrate = (db: DatabaseType): DatabaseType => {
    for (const table of db.tables) {
        table.databaseId = db.id;
        table.color = table.color ?? "#ff6363";
        table.createdAt = "2026-01-01T00:00:00.000Z";
        table.note ??= null;
        table.fields.forEach((field, index) => {
            field.sequence = index;
            field.note ??= null;
            field.defaultValue = field.defaultValue ?? null;
            field.maxLength = field.maxLength ?? null;
            field.unsigned = field.unsigned ?? false;
            field.isForeign = field.isForeign ?? false;
            field.zeroFill = field.zeroFill ?? false;
            field.precision = field.precision ?? null;
            field.scale = field.scale ?? null;
            field.charset = field.charset ?? null;
            field.collate = field.collate ?? null;
            field.values = field.values ?? null;
        });
    }
    for (const relationship of db.relationships) {
        relationship.name = relationship.name ?? `fk_${relationship.sourceTable.name}_${relationship.targetTable.name}`;
        relationship.sourceAliasName = null;
        relationship.targetAliasName = null;
        relationship.createdAt = "2026-01-01T00:00:00.000Z";
        relationship.onUpdate = relationship.onUpdate ?? ForeignKeyActions.NO_ACTION;
    }
    return db;
};

const check = (over: Partial<CheckConstraintType> = {}): CheckConstraintType => ({
    id: "chk-1",
    tableId: "users",
    name: "chk_users_status",
    expression: "status IN ('active','banned') AND length(email) > 3",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
});

const buildWithChecks = (dialect: DatabaseDialect, checks: CheckConstraintType[]): DatabaseType => {
    const db = hydrate(buildSampleDatabase(dialect));
    db.tables.find((table) => table.id === "users")!.checks = checks;
    db.tables.find((table) => table.id === "posts")!.checks = [];
    return db;
};

const significant = (operations: { type: string }[]) => operations.filter((op) => op.type !== "UPDATE_NUM_TABLES");
const checkOps = (operations: { type: string }[]) => operations.filter((op) => /_CHECK$/.test(op.type));

// SQLite is covered separately below: its renderer writes `TEXT (255)`, which the SQLite
// importer already rejects with or without checks, so a render -> import loop cannot run.
const dialects = [DatabaseDialect.POSTGRES, DatabaseDialect.MYSQL, DatabaseDialect.MARIADB, DatabaseDialect.ORACLE, DatabaseDialect.MSSQL];

describe("CHECK constraints survive render -> import", () => {
    for (const dialect of dialects) {
        it(`${dialect}: rendered DDL imports back to the same check`, async () => {
            const dataTypes = getDataTypes(dialect);
            const sql = await getRenderer(dialect, dataTypes)!.renderDDL(buildWithChecks(dialect, [check()]));
            const parsed = getImporter(dialect, dataTypes)!.parseSql(sql);

            const users = parsed.tables.find((table) => table.name.toLowerCase() === "users")!;
            expect(users.checks).toHaveLength(1);
            expect(users.checks![0].name).toBe("chk_users_status");
            expect(users.checks![0].expression.replace(/\s+/g, "").replace(/'\s*,\s*'/g, "','")).toBe(check().expression.replace(/\s+/g, ""));
        });

        it(`${dialect}: applying unchanged SQL with a check is a no-op for checks`, async () => {
            const dataTypes = getDataTypes(dialect);
            const current = buildWithChecks(dialect, [check()]);
            const sql = await getRenderer(dialect, dataTypes)!.renderDDL(current);
            const prepared = await prepareSqlSchemaChange(sql, current, dataTypes);
            expect(checkOps(prepared.operations)).toEqual([]);
            expect(prepared.warnings).toEqual([]);
        });
    }
});

describe("SQLite CHECK import", () => {
    it("reads named, unnamed and column-level checks", () => {
        const dataTypes = getDataTypes(DatabaseDialect.SQLITE);
        const parsed = getImporter(DatabaseDialect.SQLITE, dataTypes)!.parseSql(`
            CREATE TABLE "items" (
                id INTEGER PRIMARY KEY,
                qty INTEGER NOT NULL CHECK (qty >= 0),
                status TEXT,
                CONSTRAINT chk_status CHECK (status IN ('a', 'b')),
                CHECK (qty < 1000)
            );`);
        expect(parsed.tables[0].checks!.map((entry) => [entry.name, entry.expression])).toEqual([
            ["chk_items_1", "qty >= 0"],
            ["chk_status", "status IN ('a', 'b')"],
            ["chk_items_3", "qty < 1000"],
        ]);
    });

    it("renders checks inline in CREATE TABLE", async () => {
        const dataTypes = getDataTypes(DatabaseDialect.SQLITE);
        const sql = await getRenderer(DatabaseDialect.SQLITE, dataTypes)!.renderDDL(buildWithChecks(DatabaseDialect.SQLITE, [check()]));
        expect(sql).toMatch(/CONSTRAINT "chk_users_status" CHECK \(/);
    });
});

describe("editing SQL changes checks through the diff", () => {
    const dialect = DatabaseDialect.POSTGRES;
    const dataTypes = getDataTypes(dialect);
    const baseSql = (checkLine: string) => `
        CREATE TABLE users (
            id serial PRIMARY KEY,
            email varchar(255) NOT NULL UNIQUE,
            status varchar(20) NOT NULL DEFAULT 'active'${checkLine}
        );
        CREATE TABLE posts (
            id serial PRIMARY KEY,
            user_id integer NOT NULL,
            title varchar(255) NOT NULL,
            CONSTRAINT fk_posts_users FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        );`;

    it("a newly added CHECK becomes CREATE_CHECK", async () => {
        const current = buildWithChecks(dialect, []);
        const prepared = await prepareSqlSchemaChange(baseSql(",\n CONSTRAINT chk_new CHECK (length(email) > 5)"), current, dataTypes);
        const ops = checkOps(prepared.operations) as any[];
        expect(ops.map((op) => op.type)).toEqual(["CREATE_CHECK"]);
        expect(ops[0].check.name).toBe("chk_new");
        expect(ops[0].check.expression).toBe("length(email) > 5");
        expect(ops[0].check.tableId).toBe("users");
    });

    it("a CHECK removed from the SQL becomes DELETE_CHECK and counts as destructive-free but visible", async () => {
        const current = buildWithChecks(dialect, [check({ name: "chk_old", expression: "length(email) > 5" })]);
        const prepared = await prepareSqlSchemaChange(baseSql(""), current, dataTypes);
        const ops = checkOps(prepared.operations) as any[];
        expect(ops.map((op) => op.type)).toEqual(["DELETE_CHECK"]);
        expect(ops[0].checkId).toBe("chk-1");
    });

    it("a changed expression becomes UPDATE_CHECK keeping the same id", async () => {
        const current = buildWithChecks(dialect, [check({ name: "chk_old", expression: "length(email) > 5" })]);
        const prepared = await prepareSqlSchemaChange(baseSql(",\n CONSTRAINT chk_old CHECK (length(email) > 9)"), current, dataTypes);
        const ops = checkOps(prepared.operations) as any[];
        expect(ops.map((op) => op.type)).toEqual(["UPDATE_CHECK"]);
        expect(ops[0].checkId).toBe("chk-1");
        expect(ops[0].changes).toEqual({ expression: "length(email) > 9" });
    });

    it("a pure formatting change is not an edit", async () => {
        const current = buildWithChecks(dialect, [check({ name: "chk_old", expression: "length(email)>5" })]);
        const prepared = await prepareSqlSchemaChange(baseSql(",\n CONSTRAINT chk_old CHECK (length( email ) > 5)"), current, dataTypes);
        expect(checkOps(prepared.operations)).toEqual([]);
    });

    it("column-level and unnamed checks get stable generated names", async () => {
        const current = buildWithChecks(dialect, []);
        const sql = baseSql("").replace("status varchar(20) NOT NULL DEFAULT 'active'", "status varchar(20) NOT NULL DEFAULT 'active' CHECK (status <> '')");
        const prepared = await prepareSqlSchemaChange(sql, current, dataTypes);
        const ops = checkOps(prepared.operations) as any[];
        expect(ops).toHaveLength(1);
        expect(ops[0].check.name).toBe("chk_users_1");
        expect(ops[0].check.expression).toBe("status <> ''");
    });

    it("ALTER TABLE ... ADD CONSTRAINT CHECK is picked up too", async () => {
        const current = buildWithChecks(dialect, []);
        const sql = baseSql("") + `\nALTER TABLE users ADD CONSTRAINT chk_alter CHECK (id > 0);`;
        const prepared = await prepareSqlSchemaChange(sql, current, dataTypes);
        const ops = checkOps(prepared.operations) as any[];
        expect(ops.map((op) => op.type)).toEqual(["CREATE_CHECK"]);
        expect(ops[0].check.name).toBe("chk_alter");
    });
});
