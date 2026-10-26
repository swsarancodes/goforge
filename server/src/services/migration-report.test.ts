import { describe, expect, it } from "vitest";
import { buildReport, digestForSummary, type DataFacts, type ReportSample } from "./migration-report.js";
import { planMigration, type MigrationEdits, type OracleColumn, type OracleTable } from "./oracle-migration.js";

// Everything here is built from a plan made of a fixture: there is no Oracle to reach, and the report does not ask for one.
const column = (name: string, type: string, extra: Partial<OracleColumn> = {}): OracleColumn => ({ name, type, charLength: null, dataLength: null, precision: null, scale: null, nullable: true, defaultValue: null, ...extra });
const tables: OracleTable[] = [
    {
        name: "POLCY_HDR",
        columns: [
            column("POLCY_ID", "NUMBER", { precision: 10, scale: 0, nullable: false }),
            column("EFF_DT", "DATE", { nullable: false }),
            column("AT", "TIMESTAMP(6) WITH TIME ZONE"),
            column("NOTE", "CLOB"),
            column("STAT_CD", "VARCHAR2", { charLength: 2, dataLength: 2, defaultValue: "'AC'" }),
            column("MADE", "DATE", { defaultValue: "SYSDATE" }),
            column("FLAG", "NUMBER", { precision: 1, scale: 0, defaultValue: "0" }),
            column("OPT", "VARCHAR2", { charLength: 5, dataLength: 5, defaultValue: "NULL" }),
        ],
        primaryKey: { name: "POLCY_PK", columns: ["POLCY_ID"] },
        uniques: [],
        foreignKeys: [],
    },
    { name: "Mixed Case", columns: [column("Id", "NUMBER", { precision: 5, scale: 0, nullable: false })], primaryKey: { name: "MC_PK", columns: ["Id"] }, uniques: [], foreignKeys: [] },
];
const plan = (edits: MigrationEdits = {}) => planMigration(tables, new Map([["POLCY_HDR", 340], ["Mixed Case", 3]]), edits);
const report = (edits: MigrationEdits = {}, extra: Partial<Parameters<typeof buildReport>[1]> = {}) => buildReport(plan(edits), { source: "insurance", now: () => new Date("2026-10-26T12:00:00Z"), ...extra });

describe("a report built from a plan alone", () => {
    it("needs no connection, and says the data was not read", () => {
        const built = report();
        expect(built.dataRead).toBe(false);
        expect(built.source).toBe("insurance");
        expect(built.generatedAt).toBe("2026-10-26T12:00:00.000Z");
        expect(built.tables.every((table) => table.sample === undefined && table.columns.every((c) => c.facts === undefined))).toBe(true);
    });

    it("summarizes tables, columns, rows and how the columns fare", () => {
        const { summary } = report();
        expect(summary).toMatchObject({ tables: 2, columns: 9, rows: 343, notCarried: 0, problems: 0, changesByYou: 0 });
        expect(summary.exact + summary.changed + summary.risk).toBe(9);
        // the time zone column is the one real change; the DATE columns behave differently in queries
        expect(summary.risk).toBe(1);
        expect(summary.changed).toBe(2);
    });

    it("counts the columns by what the copy does to their values", () => {
        const { summary } = report();
        expect(summary.values).toEqual({ kept: 8, reformatted: 0, converted: 1, dropped: 0 });
        expect(report({ columns: { "POLCY_HDR.EFF_DT": { pgType: "date" } } }).summary.values.dropped).toBe(1);
        expect(report({ columns: { "POLCY_HDR.EFF_DT": { pgType: "text" } } }).summary.values.reformatted).toBe(1);
    });

    it("puts the rule for each column's values on the column", () => {
        const built = report();
        const header = built.tables[0];
        const byName = (name: string) => header.columns.find((c) => c.oracleName === name)!;
        expect(byName("EFF_DT").dataChange).toMatchObject({ effect: "kept", status: "exact", load: "timestamp(0)" });
        expect(byName("AT").dataChange).toMatchObject({ effect: "converted", status: "risk" });
        expect(byName("NOTE").dataChange.load).toBe("text");
        expect(byName("POLCY_ID").dataChange.read).toContain("fetched as text");
    });
});

describe("renames and defaults", () => {
    it("lists Oracle's upper-case names written in lower case, and the names chosen by the person, apart", () => {
        const built = report({ tables: { POLCY_HDR: { pgName: "policy" } }, columns: { "POLCY_HDR.EFF_DT": { pgName: "starts_on" } } });
        expect(built.renames.filter((r) => r.by === "you")).toEqual([
            { kind: "table", table: "POLCY_HDR", from: "POLCY_HDR", to: "policy", by: "you" },
            { kind: "column", table: "POLCY_HDR", from: "EFF_DT", to: "starts_on", by: "you" },
        ]);
        expect(built.renames.filter((r) => r.by === "case").length).toBe(7);
        expect(built.renames.find((r) => r.from === "STAT_CD")).toEqual({ kind: "column", table: "POLCY_HDR", from: "STAT_CD", to: "stat_cd", by: "case" });
        // a quoted mixed-case name is kept as it is, so it is not a rename
        expect(built.renames.some((r) => r.from === "Mixed Case" || r.from === "Id")).toBe(false);
    });

    it("lists a default the person dropped, and one that no longer fits the type, each with its reason", () => {
        const built = report({ columns: { "POLCY_HDR.STAT_CD": { dropDefault: true }, "POLCY_HDR.FLAG": { pgType: "boolean" } } });
        expect(built.droppedDefaults).toEqual([
            { table: "POLCY_HDR", column: "STAT_CD", oracleDefault: "'AC'", detail: "you dropped it" },
            { table: "POLCY_HDR", column: "FLAG", oracleDefault: "0", detail: "it does not fit boolean" },
        ]);
    });

    it("lists a default written another way, and does not call a NULL default a loss", () => {
        const built = report();
        expect(built.rewrittenDefaults).toEqual([{ table: "POLCY_HDR", column: "MADE", oracleDefault: "SYSDATE", detail: "becomes CURRENT_TIMESTAMP" }]);
        expect(built.droppedDefaults).toEqual([]);
    });
});

describe("what the report says about getting started", () => {
    it("is ready when nothing blocks the migration", () => {
        expect(report().verdict).toBe("ready");
        expect(report().mustAccept).toEqual([]);
    });

    it("is blocked, with the reasons, when the plan has a problem", () => {
        const blocked = buildReport(planMigration([{ ...tables[0], columns: [...tables[0].columns, column("G", "VARCHAR2", { charLength: 40, defaultValue: "SYS_GUID()" })] }], new Map()), { source: "x" });
        expect(blocked.verdict).toBe("blocked");
        expect(blocked.problems).toEqual(["POLCY_HDR.G: its default SYS_GUID() is Oracle code."]);
        expect(blocked.summary.problems).toBe(1);
    });

    it("needs acceptance when a check on the data found values that would change, or could not run", () => {
        const base = plan({ columns: { "POLCY_HDR.EFF_DT": { pgType: "date" } } });
        const column0 = base.tables[0].columns[1];
        column0.check = { description: "values with a time of day, which a date does not keep", sql: "SELECT COUNT(*) FROM \"POLCY_HDR\" WHERE ...", count: 340 };
        const found = buildReport(base, { source: "x" });
        expect(found.verdict).toBe("needs-acceptance");
        expect(found.mustAccept).toEqual([{ table: "polcy_hdr", column: "eff_dt", description: "values with a time of day, which a date does not keep", count: 340, sql: expect.stringContaining("SELECT COUNT(*)") }]);
        column0.check = { description: "d", sql: "s", count: null, error: "ORA-00942" };
        expect(buildReport(base, { source: "x" }).mustAccept[0]).toMatchObject({ count: null, error: "ORA-00942" });
        column0.check = { description: "d", sql: "s", count: 0 };
        expect(buildReport(base, { source: "x" }).verdict).toBe("ready");
    });

    it("carries what is left behind, how queries behave differently, and the changes that could not be made", () => {
        const built = report({ columns: { "POLCY_HDR.EFF_DT": { pgType: "integer" } } });
        expect(built.behaviour.length).toBeGreaterThan(0);
        expect(built.editProblems).toEqual([expect.stringContaining("DATE cannot become integer")]);
        expect(built.notCarried).toEqual([]);
        const withLeftBehind = buildReport({ ...plan(), notCarried: [{ kind: "index", name: "IX_X", detail: "on POLCY_HDR" }] }, { source: "x" });
        expect(withLeftBehind.notCarried).toEqual([{ kind: "index", name: "IX_X", detail: "on POLCY_HDR" }]);
        expect(withLeftBehind.summary.notCarried).toBe(1);
    });
});

describe("what reading the data adds, and the fingerprint of what was read", () => {
    const facts: DataFacts = { "POLCY_HDR.EFF_DT": { nulls: 0, values: 340, affected: [] }, "POLCY_HDR.AT": { nulls: 12, values: 328, affected: [{ label: "written in another offset than UTC", count: 41, sql: "SELECT COUNT(*) ..." }] } };
    const sample: ReportSample = { columns: ["polcy_id"], oracle: [["1"]], postgres: [["1"]], ordered: true, sql: "SELECT 1 FROM dual" };

    it("puts the counts on their columns and the samples on their tables, and says the data was read", () => {
        const built = report({}, { facts, samples: { POLCY_HDR: sample } });
        expect(built.dataRead).toBe(true);
        expect(built.tables[0].columns.find((c) => c.oracleName === "AT")?.facts).toEqual(facts["POLCY_HDR.AT"]);
        expect(built.tables[0].sample).toEqual(sample);
        expect(built.tables[1].sample).toBeUndefined();
    });

    it("has the same fingerprint whenever and however often it is built, and whatever sample rows it shows", () => {
        const a = report({}, { facts, samples: { POLCY_HDR: sample } });
        const later = buildReport(plan(), { source: "insurance", facts, samples: { POLCY_HDR: { ...sample, postgres: [["2"]] } }, now: () => new Date("2027-01-01T00:00:00Z") });
        expect(later.hash).toBe(a.hash);
        expect(later.generatedAt).not.toBe(a.generatedAt);
        expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("has another fingerprint when what the person reads changes: an edit, or a count", () => {
        const base = report({}, { facts }).hash;
        expect(report({ columns: { "POLCY_HDR.EFF_DT": { pgType: "date" } } }, { facts }).hash).not.toBe(base);
        expect(report({}, { facts: { ...facts, "POLCY_HDR.AT": { nulls: 12, values: 328, affected: [{ label: "written in another offset than UTC", count: 42, sql: "SELECT COUNT(*) ..." }] } } }).hash).not.toBe(base);
        expect(report({}).hash).not.toBe(base);
    });
});

describe("what the model is shown to write the opening paragraph", () => {
    const facts: DataFacts = { "POLCY_HDR.AT": { nulls: 12, values: 328, affected: [{ label: "values written in an offset other than UTC, which is not kept", count: 41, sql: "SELECT COUNT(*) ..." }] } };
    const sample: ReportSample = { columns: ["note"], oracle: [["a secret customer note"]], postgres: [["a secret customer note"]], ordered: true, sql: "SELECT ..." };

    it("holds the figures, the names, the notes and the counts, and never a sample row", () => {
        const digest = digestForSummary(report({ tables: { POLCY_HDR: { pgName: "policy" } } }, { facts, samples: { POLCY_HDR: sample } }));
        const text = JSON.stringify(digest);
        expect(text).not.toContain("secret customer note");
        expect(text).not.toContain("SELECT COUNT");
        expect(digest).toMatchObject({ source: "insurance", verdict: "ready", renamedByYou: ["POLCY_HDR to policy"], dataRead: true });
        expect(digest.summary).toMatchObject({ tables: 2, columns: 9 });
    });

    it("lists the columns worth reading with what the copy does and what was counted, and not the ones that are plainly fine", () => {
        const digest = digestForSummary(report({}, { facts }));
        const names = digest.columnsToRead.map((entry) => entry.column);
        expect(names).toContain("polcy_hdr.at");
        expect(names).not.toContain("polcy_hdr.polcy_id");
        const zone = digest.columnsToRead.find((entry) => entry.column === "polcy_hdr.at")!;
        expect(zone.counted).toEqual(["41 values written in an offset other than UTC, which is not kept", "12 NULL of 340"]);
        expect(zone.whatTheCopyDoes).toContain("Converted to UTC");
    });

    it("says what has to be accepted, in words, and what blocks the migration", () => {
        const base = plan();
        base.tables[0].columns[1].check = { description: "values with a time of day", sql: "s", count: 7 };
        const digest = digestForSummary(buildReport(base, { source: "x" }));
        expect(digest.mustAccept).toEqual(["polcy_hdr.eff_dt: 7 values with a time of day"]);
    });
});
