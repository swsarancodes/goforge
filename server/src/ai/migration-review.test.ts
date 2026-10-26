import { describe, expect, it } from "vitest";
import { buildReport, describeEdits, digestForReview, foreignKeysOf } from "../services/migration-report.js";
import { planMigration, type OracleColumn, type OracleTable } from "../services/oracle-migration.js";
import { buildMigrationReviewInstructions, checkFindings, migrationReviewResultSchema, type ReviewFinding } from "./migration-review.js";

const column = (name: string, type: string, extra: Partial<OracleColumn> = {}): OracleColumn => ({ name, type, charLength: null, dataLength: null, precision: null, scale: null, nullable: true, defaultValue: null, ...extra });
const tables: OracleTable[] = [
    { name: "PARENT", columns: [column("ID", "NUMBER", { precision: 10, scale: 0, nullable: false }), column("NAME", "VARCHAR2", { charLength: 20, dataLength: 20 })], primaryKey: { name: "PK_P", columns: ["ID"] }, uniques: [], foreignKeys: [] },
    {
        name: "CHILD",
        columns: [column("CID", "NUMBER", { precision: 10, scale: 0, nullable: false }), column("PARENT_ID", "NUMBER", { precision: 10, scale: 0 })],
        primaryKey: { name: "PK_C", columns: ["CID"] },
        uniques: [],
        foreignKeys: [{ name: "FK_C_P", columns: ["PARENT_ID"], refTable: "PARENT", refColumns: ["ID"] }],
    },
];
const reportOf = (edits = {}) => buildReport(planMigration(tables, new Map([["PARENT", 3], ["CHILD", 5]]), edits), { source: "fixture", edits: Object.keys(edits).length });

describe("the review digest", () => {
    it("lists each foreign key with the PostgreSQL type of both sides, and says when they differ", () => {
        const same = foreignKeysOf(tables, reportOf());
        expect(same).toEqual([{ from: "CHILD(PARENT_ID)", to: "PARENT(ID)", fromTypes: ["bigint"], toTypes: ["bigint"], sameTypes: true }]);
        const split = foreignKeysOf(tables, reportOf({ columns: { "CHILD.PARENT_ID": { pgType: "integer" } } }));
        expect(split[0]).toMatchObject({ fromTypes: ["integer"], toTypes: ["bigint"], sameTypes: false });
    });

    it("says what the person changed, one line each", () => {
        expect(describeEdits({ tables: { PARENT: { pgName: "parents" } }, columns: { "CHILD.PARENT_ID": { pgType: "integer", pgName: "pid", dropDefault: true } }, objects: { "index:IX_X": { carry: true }, "check:CK_Y": { carry: false } } })).toEqual([
            "table PARENT is called parents",
            "column CHILD.PARENT_ID is called pid",
            "column CHILD.PARENT_ID is integer",
            "the default of CHILD.PARENT_ID is dropped",
            "index IX_X is carried over",
        ]);
    });

    it("holds every column with how it fares, what the person changed, the foreign keys and what is left behind, and no sample value", () => {
        const report = reportOf({ columns: { "CHILD.PARENT_ID": { pgType: "integer" } } });
        const digest = digestForReview({ ...report, notCarried: [{ kind: "index", name: "IX_C", detail: "on CHILD", canCarry: false, reason: "PostgreSQL has no bitmap indexes" }] }, { edits: { columns: { "CHILD.PARENT_ID": { pgType: "integer" } } }, tables });
        expect(digest.columnsListed).toBe("all");
        expect(digest.tables.map((table) => table.table)).toEqual(["PARENT", "CHILD"]);
        expect(digest.tables[1].columns.find((entry) => entry.column === "PARENT_ID")).toMatchObject({ from: "NUMBER", to: "integer", changedByThem: ["type"] });
        expect(digest.foreignKeys[0].sameTypes).toBe(false);
        expect(digest.changesTheyMade).toEqual(["column CHILD.PARENT_ID is integer"]);
        expect(digest.leftBehind).toEqual(["index IX_C (on CHILD): cannot be carried over, PostgreSQL has no bitmap indexes"]);
        expect(JSON.stringify(digest)).not.toMatch(/"sample"|"oracle":\[/);
    });

    it("lists only the columns that are not plain 'exact' once there are hundreds, and says so", () => {
        const wide: OracleTable = { name: "WIDE", columns: Array.from({ length: 320 }, (_, at) => column(`C${at}`, at === 7 ? "DATE" : "VARCHAR2", { charLength: 5, dataLength: 5 })), primaryKey: undefined, uniques: [], foreignKeys: [] };
        const report = buildReport(planMigration([wide], new Map(), {}), { source: "wide" });
        const digest = digestForReview(report, { edits: {}, tables: [wide] });
        expect(digest.columnsListed).toMatch(/only those that are not plain 'exact', of 320/);
        expect(digest.tables[0].columns.map((entry) => entry.column)).toEqual(["C7"]);
    });
});

describe("checking what the reviewer says against the plan", () => {
    const known = [{ oracleName: "CHILD", columns: [{ oracleName: "CID" }, { oracleName: "PARENT_ID" }] }, { oracleName: "PARENT", columns: [{ oracleName: "ID" }] }];
    const finding = (table: string | null, column: string | null, title = "t", severity: ReviewFinding["severity"] = "warning"): ReviewFinding => ({ severity, table, column, title, detail: "d", suggestion: null });

    it("keeps a finding about something in the plan, in the plan's spelling, and the ones about the plan as a whole", () => {
        const result = checkFindings([finding("child", "parent_id"), finding("PARENT", null), finding(null, null, "whole")], known);
        expect(result.findings.map((entry) => [entry.table, entry.column])).toEqual([["CHILD", "PARENT_ID"], ["PARENT", null], [null, null]]);
        expect(result.dropped).toBe(0);
    });

    it("drops a finding about a table or column the plan does not have, and a column with no table, and counts them", () => {
        const result = checkFindings([finding("GHOST", null), finding("CHILD", "GHOST"), finding(null, "ID"), finding("CHILD", "CID")], known);
        expect(result.findings).toHaveLength(1);
        expect(result.dropped).toBe(3);
    });

    it("reads an empty string for table, column or suggestion as null, which is what a model that means 'none' sometimes writes", () => {
        const result = checkFindings([{ severity: "note", table: "", column: "", title: "whole plan", detail: "d", suggestion: "" }, { severity: "note", table: "  ", column: null, title: "also whole", detail: "d", suggestion: "  " }, { severity: "note", table: "", column: "ID", title: "a column with no table", detail: "d", suggestion: null }], known);
        expect(result.findings.map((entry) => [entry.table, entry.column, entry.suggestion])).toEqual([[null, null, null], [null, null, null]]);
        expect(result.dropped).toBe(1);
    });

    it("shows a repeated finding once", () => {
        expect(checkFindings([finding("CHILD", "CID", "same"), finding("CHILD", "CID", "Same")], known).findings).toHaveLength(1);
    });
});

describe("what the reviewer is told and may answer", () => {
    it("is told it is separate, cannot change anything, must not invent, and is not a proof", () => {
        const text = buildMigrationReviewInstructions();
        expect(text).toMatch(/separate, independent reviewer/);
        expect(text).toMatch(/cannot change it/);
        expect(text).toMatch(/Never invent a table, column, count or type/);
        expect(text).toMatch(/not a proof/);
        expect(text).toMatch(/never SQL/);
    });

    it("answers in a fixed shape: severity from a short list, at most twenty findings", () => {
        expect(migrationReviewResultSchema.safeParse({ overview: "ok", findings: [] }).success).toBe(true);
        expect(migrationReviewResultSchema.safeParse({ overview: "ok", findings: [{ severity: "fatal", table: null, column: null, title: "t", detail: "d", suggestion: null }] }).success).toBe(false);
        expect(migrationReviewResultSchema.safeParse({ overview: "ok", findings: Array.from({ length: 21 }, () => ({ severity: "note", table: null, column: null, title: "t", detail: "d", suggestion: null })) }).success).toBe(false);
    });
});
