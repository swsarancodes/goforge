import { describe, it, expect } from "vitest";
import { DatabaseDialect } from "@/lib/database";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { SchemaLinter, lintSchema } from "./linter";
import { Cardinality, RelationshipType } from "@/lib/schemas/relationship-schema";

describe("SchemaLinter - Integrity Rules", () => {
    it("flags tables without a primary key and provides an auto-fix", () => {
        const db = buildSampleDatabase(DatabaseDialect.POSTGRES);
        // Remove primary key from posts table
        const posts = db.tables.find(t => t.name === "posts")!;
        for (const f of posts.fields) {
            f.isPrimary = false;
        }

        const linter = new SchemaLinter();
        const result = linter.lint(db);

        const pkIssue = result.issues.find(i => i.ruleId === "require-primary-key" && i.tableName === "posts");
        expect(pkIssue).toBeDefined();
        expect(pkIssue?.severity).toBe("error");
        expect(pkIssue?.fixable).toBe(true);

        // Apply fix
        const fixedDb = linter.applyFix(db, pkIssue!.id);
        const fixedPosts = fixedDb.tables.find(t => t.name === "posts")!;
        expect(fixedPosts.fields.some(f => f.isPrimary && f.name === "id")).toBe(true);
    });
});

describe("SchemaLinter - Performance Rules", () => {
    it("detects unindexed foreign keys and creates an index on fix", () => {
        const db = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const posts = db.tables.find(t => t.name === "posts")!;
        // Ensure posts has no index on user_id
        posts.indices = [];

        const linter = new SchemaLinter();
        const result = linter.lint(db);

        const fkIssue = result.issues.find(i => i.ruleId === "unindexed-foreign-key" && i.tableName === "posts");
        expect(fkIssue).toBeDefined();
        expect(fkIssue?.severity).toBe("warning");
        expect(fkIssue?.fixable).toBe(true);

        // Apply fix
        const fixedDb = linter.applyFix(db, fkIssue!.id);
        const fixedPosts = fixedDb.tables.find(t => t.name === "posts")!;
        expect(fixedPosts.indices?.some(idx => idx.name.includes("user_id"))).toBe(true);
    });

    it("detects exact duplicate indexes and cleans them up", () => {
        const db = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const users = db.tables.find(t => t.name === "users")!;
        const emailField = users.fields.find(f => f.name === "email")!;

        users.indices = [
            {
                id: "idx_users_email_1",
                tableId: users.id,
                name: "idx_users_email_1",
                unique: false,
                fieldIndices: [{ id: "fi_1", indexId: "idx_users_email_1", fieldId: emailField.id } as any],
            } as any,
            {
                id: "idx_users_email_2",
                tableId: users.id,
                name: "idx_users_email_2",
                unique: false,
                fieldIndices: [{ id: "fi_2", indexId: "idx_users_email_2", fieldId: emailField.id } as any],
            } as any,
        ];

        const linter = new SchemaLinter();
        const result = linter.lint(db);

        const dupIssue = result.issues.find(i => i.ruleId === "redundant-index");
        expect(dupIssue).toBeDefined();
        expect(dupIssue?.targetId).toBe("idx_users_email_2");

        const fixedDb = linter.applyFix(db, dupIssue!.id);
        const fixedUsers = fixedDb.tables.find(t => t.name === "users")!;
        expect(fixedUsers.indices?.length).toBe(1);
    });
});

describe("SchemaLinter - Naming Rules", () => {
    it("flags SQL reserved keywords used as table or column names", () => {
        const db = buildSampleDatabase(DatabaseDialect.POSTGRES);
        db.tables[0].name = "order"; // reserved SQL word
        db.tables[0].fields[0].name = "select"; // reserved SQL word

        const linter = new SchemaLinter();
        const result = linter.lint(db);

        const tableIssue = result.issues.find(i => i.ruleId === "reserved-keyword-collision" && i.targetType === "table");
        expect(tableIssue).toBeDefined();
        expect(tableIssue?.severity).toBe("error");

        const fieldIssue = result.issues.find(i => i.ruleId === "reserved-keyword-collision" && i.targetType === "field");
        expect(fieldIssue).toBeDefined();
    });

    it("enforces snake_case naming conventions and fixes violations", () => {
        const db = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const users = db.tables.find(t => t.name === "users")!;
        users.name = "UserAccounts"; // PascalCase
        users.fields.push({
            id: "f_createdDate",
            tableId: users.id,
            name: "createdDate", // camelCase
            typeId: users.fields[0].typeId,
            type: users.fields[0].type,
            isPrimary: false,
            unique: false,
            nullable: true,
            defaultValue: null,
            sequence: 4,
        } as any);

        const linter = new SchemaLinter({ namingConvention: "snake_case" });
        const result = linter.lint(db);

        const tableNaming = result.issues.find(i => i.ruleId === "table-naming-convention");
        expect(tableNaming).toBeDefined();
        expect(tableNaming?.suggestion).toContain("user_accounts");

        const colNaming = result.issues.find(i => i.ruleId === "column-naming-convention" && i.fieldName === "createdDate");
        expect(colNaming).toBeDefined();
        expect(colNaming?.suggestion).toContain("created_date");

        // Fix table name
        const fixedDb = linter.applyFix(db, tableNaming!.id);
        expect(fixedDb.tables.some(t => t.name === "user_accounts")).toBe(true);
    });
});

describe("SchemaLinter - Options & Bulk Fixes", () => {
    it("honors disabled rules and severity overrides", () => {
        const db = buildSampleDatabase(DatabaseDialect.POSTGRES);
        // Force missing note
        for (const t of db.tables) t.note = "";

        const linter = new SchemaLinter({
            disabledRules: ["missing-documentation"],
            severityOverrides: { "unindexed-foreign-key": "error" },
        });
        const result = linter.lint(db);

        expect(result.issues.some(i => i.ruleId === "missing-documentation")).toBe(false);
        const fkIssue = result.issues.find(i => i.ruleId === "unindexed-foreign-key");
        if (fkIssue) {
            expect(fkIssue.severity).toBe("error");
        }
    });

    it("applies all fixable issues in bulk with applyAllFixes()", () => {
        const db = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const users = db.tables.find(t => t.name === "users")!;
        users.name = "UsersList"; // naming violation
        const posts = db.tables.find(t => t.name === "posts")!;
        posts.indices = []; // unindexed FK

        const linter = new SchemaLinter();
        const { database: fixedDb, appliedCount } = linter.applyAllFixes(db);

        expect(appliedCount).toBeGreaterThanOrEqual(2);
        expect(fixedDb.tables.some(t => t.name === "users_list")).toBe(true);
        expect(fixedDb.tables.find(t => t.name === "posts")?.indices?.length).toBeGreaterThanOrEqual(1);
    });
});
