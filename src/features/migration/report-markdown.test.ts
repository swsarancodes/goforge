import { describe, expect, it } from "vitest";
import type { MigrationReport, ReportColumn } from "@/lib/migrations-api";
import { reportToMarkdown } from "./report-markdown";

const column = (extra: Partial<ReportColumn> = {}): ReportColumn => ({
    oracleName: "EFF_DT", pgName: "eff_dt", oracleType: "DATE", pgType: "timestamp(0)", nullable: false, status: "exact", note: "n", edited: [], oracleDefault: null, pgDefault: null,
    dataChange: { summary: "Read as text to the second.", read: "r", load: "timestamp(0)", effect: "kept", status: "exact", notes: [] },
    ...extra,
});
const report = (extra: Partial<MigrationReport> = {}): MigrationReport => ({
    generatedAt: "2026-10-26T12:00:00.000Z", source: "insurance", verdict: "ready",
    summary: { tables: 1, columns: 1, rows: 340, exact: 1, changed: 0, risk: 0, values: { kept: 1, reformatted: 0, converted: 0, dropped: 0 }, changesByYou: 0, notCarried: 0, canBeCarried: 0, carried: 0, problems: 0 },
    renames: [], droppedDefaults: [], rewrittenDefaults: [],
    tables: [{ oracleName: "POLCY_HDR", pgName: "polcy_hdr", renamed: false, rows: 340, primaryKey: ["POLCY_ID"], columns: [column()] }],
    notCarried: [], carried: [], behaviour: [], problems: [], editProblems: [], mustAccept: [], dataRead: false, hash: "a".repeat(64), ...extra,
});

describe("the report as Markdown", () => {
    it("says what it is, whether anything blocks the migration, and its fingerprint", () => {
        const text = reportToMarkdown(report());
        expect(text).toContain("# Migration report: insurance to PostgreSQL");
        expect(text).toContain(`Report fingerprint \`${"a".repeat(64)}\``);
        expect(text).toContain("**Ready: nothing blocks the migration.**");
        expect(reportToMarkdown(report({ verdict: "blocked" }))).toContain("**Blocked: the migration cannot run as planned.**");
        expect(reportToMarkdown(report({ verdict: "needs-acceptance" }))).toContain("have to be accepted by name");
    });

    it("summarizes the counts and says whether the data was read", () => {
        const text = reportToMarkdown(report());
        expect(text).toContain("- 1 table, 1 column, 340 rows.");
        expect(text).toContain("- Values: 1 column stay the same, 0 behave differently, 0 may lose data.");
        expect(text).toContain("The Oracle data was not read for this report: it has no counts or sample rows.");
        expect(reportToMarkdown(report({ dataRead: true }))).toContain("were read from the Oracle data (read only)");
    });

    it("puts each column's rule and what was counted in its table row", () => {
        const text = reportToMarkdown(report({ dataRead: true, tables: [{ ...report().tables[0], columns: [column({ facts: { nulls: 3, values: 337, affected: [{ label: "values with a time of day, which is kept", count: 41, sql: "s" }] } })] }] }));
        expect(text).toContain("| EFF_DT | DATE | eff_dt | timestamp(0) | same | Read as text to the second. | 3 NULL of 340; 41 values with a time of day, which is kept |");
    });

    it("keeps a pipe or a line break in a cell from ending it", () => {
        const text = reportToMarkdown(report({ tables: [{ ...report().tables[0], columns: [column({ dataChange: { summary: "a | b\nc", read: "", load: "", effect: "kept", status: "exact", notes: [] } })] }] }));
        expect(text).toContain("a \\| b c");
    });

    it("lists the values to accept, the blocking problems and the changes that could not be made", () => {
        const text = reportToMarkdown(report({
            verdict: "needs-acceptance",
            mustAccept: [{ table: "polcy_hdr", column: "eff_dt", description: "values with a time of day", count: 340, sql: "s" }, { table: "t", column: "c", description: "d", count: null, sql: "s", error: "ORA-1" }],
            problems: ["T.G: its default SYS_GUID() is Oracle code."], editProblems: ["T.X: not a type"],
        }));
        expect(text).toContain("- `polcy_hdr.eff_dt`: 340 values with a time of day");
        expect(text).toContain("- `t.c`: the check could not run (ORA-1)");
        expect(text).toContain("- T.G: its default SYS_GUID() is Oracle code.");
        expect(text).toContain("## Changes that could not be made");
    });

    it("lists the names the person chose apart from the upper-case names written in lower case", () => {
        const text = reportToMarkdown(report({ renames: [{ kind: "table", table: "POLCY_HDR", from: "POLCY_HDR", to: "policy", by: "you" }, { kind: "column", table: "POLCY_HDR", from: "EFF_DT", to: "eff_dt", by: "case" }, { kind: "column", table: "POLCY_HDR", from: "STAT_CD", to: "stat_cd", by: "case" }] }));
        expect(text).toContain("- table `POLCY_HDR` to `policy`");
        expect(text).toContain("2 names Oracle writes in upper case become lower case");
    });

    it("lists a default that was dropped, with why, and one that was rewritten", () => {
        const text = reportToMarkdown(report({ droppedDefaults: [{ table: "T", column: "A", oracleDefault: "'AC'", detail: "you dropped it" }], rewrittenDefaults: [{ table: "T", column: "B", oracleDefault: "SYSDATE", detail: "becomes CURRENT_TIMESTAMP" }] }));
        expect(text).toContain("- Dropped: `T.A` default `'AC'`, because you dropped it.");
        expect(text).toContain("- Rewritten: `T.B` default `SYSDATE` becomes CURRENT_TIMESTAMP.");
    });

    it("shows a sample as the Oracle value and, when it differs, the value PostgreSQL receives", () => {
        const text = reportToMarkdown(report({ dataRead: true, tables: [{ ...report().tables[0], sample: { columns: ["plain", "tz", "v"], oracle: [[".5", "2026-03-31 16:45:00.500000 +05:30", null]], postgres: [["0.5", "2026-03-31 11:15:00.500000+00", null]], ordered: true, sql: "s" } }] }));
        expect(text).toContain("| plain | .5 → 0.5 |");
        expect(text).toContain("| tz | 2026-03-31 16:45:00.500000 +05:30 → 2026-03-31 11:15:00.500000+00 |");
        expect(text).toContain("| v | NULL |");
        expect(text).toContain("the first by primary key");
        expect(reportToMarkdown(report({ tables: [{ ...report().tables[0], sample: { columns: ["a"], oracle: [["1"]], postgres: [["1"]], ordered: false, sql: "s" } }] }))).toContain("the table has no key");
    });

    it("labels the AI summary as commentary that is not part of what was approved, and only when there is one", () => {
        expect(reportToMarkdown(report())).not.toContain("AI commentary");
        const text = reportToMarkdown(report(), { summary: { text: "Two tables move.", model: "gpt-x" } });
        expect(text).toContain("## AI commentary");
        expect(text).toContain("Written by the model gpt-x");
        expect(text).toContain("not part of what was approved");
        expect(text).toContain("Two tables move.");
        // the commentary comes before the figures it comments on
        expect(text.indexOf("## AI commentary")).toBeLessThan(text.indexOf("## Summary"));
    });

    it("carries the approval, and says when the approved fingerprint is not this document's", () => {
        expect(reportToMarkdown(report())).not.toContain("## Approval");
        const same = reportToMarkdown(report(), { approval: { reportHash: "a".repeat(64), approvedAt: "2026-10-26T12:05:00.000Z" } });
        expect(same).toContain("approved at 2026-10-26T12:05:00.000Z");
        expect(same).toContain("the same as this document's");
        const other = reportToMarkdown(report(), { approval: { reportHash: "b".repeat(64), approvedAt: "2026-10-26T12:05:00.000Z" } });
        expect(other).toContain("which is not this document's");
    });

    it("says nothing is left behind when nothing is, and lists what is when it is", () => {
        expect(reportToMarkdown(report())).toContain("Nothing else in the schema");
        const text = reportToMarkdown(report({ notCarried: [{ kind: "index", name: "IX_A", detail: "on POLCY_HDR" }], behaviour: ["Dividing two integer columns drops the fraction."] }));
        expect(text).toContain("- index `IX_A` (on POLCY_HDR)");
        expect(text).toContain("- Dividing two integer columns drops the fraction.");
    });

    it("is the same document every time for the same report", () => {
        expect(reportToMarkdown(report())).toBe(reportToMarkdown(report()));
    });
    it("lists what is carried over with its statement, and for what is left behind says whether it could be carried", () => {
        const text = reportToMarkdown(report({
            summary: { ...report().summary, carried: 2, notCarried: 3, canBeCarried: 1 },
            carried: [
                { kind: "index", name: "IX_CLM_POLCY", pgName: "ix_clm_polcy", table: "CLM_DTL", pgTable: "clm_dtl", detail: "on CLM_DTL (POLCY_ID)", sql: 'CREATE INDEX "ix_clm_polcy" ON "clm_dtl" ("polcy_id")' },
                { kind: "check", name: "CK_CLM_AMT", pgName: "ck_clm_amt", table: "CLM_DTL", pgTable: "clm_dtl", detail: "CLM_AMT >= 0", sql: 'ALTER TABLE "clm_dtl" ADD CONSTRAINT "ck_clm_amt" CHECK ("clm_amt" >= 0)' },
            ],
            notCarried: [
                { kind: "index", name: "IX_B", detail: "on T", canCarry: true },
                { kind: "check constraint", name: "CK_F", detail: "on T: UPPER(X) = X", canCarry: false, reason: "it calls UPPER()" },
                { kind: "view", name: "V_ALL" },
            ],
        }));
        expect(text).toContain("## Carried over by your choice");
        expect(text).toContain('- index `IX_CLM_POLCY` (on CLM_DTL (POLCY_ID)): `CREATE INDEX "ix_clm_polcy" ON "clm_dtl" ("polcy_id")`');
        expect(text).toContain("2 indexes and check constraints carried over by your choice;");
        expect(text).toContain("- index `IX_B` (on T): could be carried over if asked");
        expect(text).toContain("- check constraint `CK_F` (on T: UPPER(X) = X): cannot be carried over, it calls UPPER()");
        expect(text).toContain("- view `V_ALL`\n");
        expect(reportToMarkdown(report())).not.toContain("Carried over by your choice");
    });

    it("puts the second opinion in a block of its own that says what it is, with its findings and what was left out", () => {
        const text = reportToMarkdown(report(), {
            review: {
                model: "gpt-x",
                overview: "One thing to look at.",
                dropped: 2,
                findings: [
                    { severity: "concern", table: "CHILD", column: "PARENT_ID", title: "Type differs from its parent", detail: "integer against bigint.", suggestion: "Make CHILD.PARENT_ID bigint." },
                    { severity: "note", table: null, column: null, title: "Nothing else", detail: "d", suggestion: null },
                ],
            },
        });
        expect(text).toContain("## AI review");
        expect(text).toContain("a reviewer separate from the assistant that changes the plan");
        expect(text).toContain("not proof, and not part of what was approved");
        expect(text).toContain("- **concern** `CHILD.PARENT_ID`: Type differs from its parent. integer against bigint. Suggestion: Make CHILD.PARENT_ID bigint.");
        expect(text).toContain("- **note**: Nothing else. d");
        expect(text).toContain("2 findings left out because they named a table or column that is not in the plan.");
        expect(text.indexOf("## AI review")).toBeLessThan(text.indexOf("## Summary"));
        expect(reportToMarkdown(report())).not.toContain("## AI review");
    });
});
