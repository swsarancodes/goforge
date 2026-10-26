import { describe, expect, it } from "vitest";
import { foldName, planMigration, type OracleColumn, type OracleTable } from "./oracle-migration.js";
import { translateCheck, type CheckColumn, type OracleObjects } from "./oracle-carry.js";
import { applyOperations, type MigrationEdits } from "./oracle-type-edits.js";

const col = (oracleName: string, family: CheckColumn["family"], pgType: string, typeEdited = false): CheckColumn => ({ oracleName, pgName: oracleName.toLowerCase(), family, pgType, typeEdited });
const columns = [
    col("AMT", "number", "numeric(12,2)"),
    col("QTY", "number", "integer"),
    col("STAT", "string", "varchar(2)"),
    col("EFF_DT", "date", "timestamp(0)"),
    col("EXP_DT", "date", "timestamp(0)"),
    col("TS", "timestamp", "timestamp(6)"),
    col("RATE", "float", "double precision"),
    col("NOTE", "clob", "text"),
    col("FLAG", "number", "boolean", true),
];
const sql = (condition: string) => {
    const result = translateCheck(condition, columns);
    return "sql" in result ? result.sql : `REFUSED: ${result.reason}`;
};

describe("translating a CHECK condition", () => {
    it("carries a number compared with a number, and writes the PostgreSQL names", () => {
        expect(sql("AMT >= 0")).toBe('"amt" >= 0');
        expect(sql("amt > -1.5")).toBe('"amt" > -1.5');
        expect(sql("QTY <> 3")).toBe('"qty" <> 3');
        expect(sql("QTY != 3")).toBe('"qty" <> 3');
        expect(sql("QTY ^= 3")).toBe('"qty" <> 3');
        expect(sql('"AMT" >= 0')).toBe('"amt" >= 0');
    });

    it("carries two columns of the same type, and IN, BETWEEN and IS NULL, joined by AND, OR and NOT", () => {
        expect(sql("EXP_DT >= EFF_DT")).toBe('"exp_dt" >= "eff_dt"');
        expect(sql("STAT in ('OP','CL') or STAT is null")).toBe(`"stat" IN ('OP', 'CL') OR "stat" IS NULL`);
        expect(sql("AMT between 0 and 100000")).toBe('"amt" BETWEEN 0 AND 100000');
        expect(sql("QTY not in (1, 2)")).toBe('"qty" NOT IN (1, 2)');
        expect(sql("AMT >= 0 AND (QTY > 0 OR NOT STAT = 'X')")).toBe(`"amt" >= 0 AND ("qty" > 0 OR NOT "stat" = 'X')`);
        expect(sql("AMT IS NOT NULL")).toBe('"amt" IS NOT NULL');
    });

    it("refuses a function, because its meaning is not the same on both sides", () => {
        expect(sql("UPPER(STAT) = STAT")).toMatch(/REFUSED: it calls UPPER\(\)/);
        expect(sql("EFF_DT < SYSDATE")).toMatch(/REFUSED: SYSDATE is not a column/);
        expect(sql("REGEXP_LIKE(STAT, '^A')")).toMatch(/REFUSED/);
    });

    it("refuses a date literal, a date format and a mix of types", () => {
        expect(sql("EFF_DT > DATE '2000-01-01'")).toMatch(/REFUSED/);
        expect(sql("EFF_DT > '01-JAN-2000'")).toMatch(/REFUSED: it compares EFF_DT \(date\) with a value \(str\)/);
        expect(sql("AMT > STAT")).toMatch(/REFUSED: it compares AMT \(num\) with STAT \(str\)/);
        expect(sql("EFF_DT >= TS")).toMatch(/REFUSED: it compares EFF_DT/);
    });

    it("refuses an ordering of text (the two databases sort it differently), but not an equality", () => {
        expect(sql("STAT > 'M'")).toMatch(/REFUSED: it orders text/);
        expect(sql("STAT between 'A' and 'C'")).toMatch(/REFUSED: it orders text/);
        expect(sql("STAT = 'M'")).toBe(`"stat" = 'M'`);
    });

    it("refuses an empty string (Oracle reads it as NULL), two constants, a float, a LOB, and a column whose type you changed", () => {
        expect(sql("STAT <> ''")).toMatch(/REFUSED: it compares with an empty string/);
        expect(sql("1 = 1")).toMatch(/REFUSED: it compares two constants/);
        expect(sql("RATE > 0")).toMatch(/REFUSED: RATE is a floating-point column/);
        expect(sql("NOTE IS NOT NULL")).toMatch(/REFUSED: NOTE is a clob column/);
        expect(sql("FLAG = 1")).toMatch(/REFUSED: you changed the type of FLAG/);
    });

    it("refuses what it cannot read, and never produces SQL from a condition it did not fully read", () => {
        expect(sql("AMT >= 0 ;")).toMatch(/REFUSED/);
        expect(sql("AMT >= 0 )")).toMatch(/REFUSED: it continues/);
        expect(sql("(AMT >= 0")).toMatch(/REFUSED: a bracket that is not closed/);
        expect(sql("AMT")).toMatch(/REFUSED/);
        expect(sql("NO_SUCH > 1")).toMatch(/REFUSED: NO_SUCH is not a column/);
        expect(sql("AMT >= 0 -- drop")).toMatch(/REFUSED/);
        expect(sql("")).toMatch(/REFUSED: it has no condition/);
        expect(sql("AMT >= 1e3")).toMatch(/REFUSED/);
    });
});

// ---- planning ----------------------------------------------------------------------------------------------------------------------

const column = (name: string, type: string, extra: Partial<OracleColumn> = {}): OracleColumn => ({ name, type, charLength: null, dataLength: null, precision: null, scale: null, nullable: true, defaultValue: null, ...extra });
const tables: OracleTable[] = [
    {
        name: "CLM_DTL",
        columns: [column("CLM_ID", "NUMBER", { precision: 10, scale: 0, nullable: false }), column("CLM_AMT", "NUMBER", { precision: 12, scale: 2 }), column("STAT", "VARCHAR2", { charLength: 2, dataLength: 2 }), column("CLM_DT", "DATE")],
        primaryKey: { name: "PK_CLM", columns: ["CLM_ID"] },
        uniques: [{ name: "UQ_CLM_STAT", columns: ["STAT"] }],
        foreignKeys: [],
    },
];
const found: OracleObjects = {
    indexes: [
        { name: "IX_CLM_DT", table: "CLM_DTL", unique: false, type: "NORMAL", valid: true, partitioned: false, columns: [{ name: "CLM_DT", descending: false }, { name: "CLM_ID", descending: false }] },
        { name: "UX_CLM_AMT", table: "CLM_DTL", unique: true, type: "NORMAL", valid: true, partitioned: false, columns: [{ name: "CLM_AMT", descending: false }, { name: "STAT", descending: false }] },
        { name: "IX_BM", table: "CLM_DTL", unique: false, type: "BITMAP", valid: true, partitioned: false, columns: [{ name: "STAT", descending: false }] },
        { name: "IX_DESC", table: "CLM_DTL", unique: false, type: "FUNCTION-BASED NORMAL", valid: true, partitioned: false, columns: [{ name: "SYS_NC00006$", descending: true }] },
        { name: "IX_BROKEN", table: "CLM_DTL", unique: false, type: "NORMAL", valid: false, partitioned: false, columns: [{ name: "STAT", descending: false }] },
        { name: "UQ_CLM_STAT", table: "CLM_DTL", unique: false, type: "NORMAL", valid: true, partitioned: false, columns: [{ name: "STAT", descending: false }] },
    ],
    checks: [
        { name: "CK_AMT", table: "CLM_DTL", condition: "CLM_AMT >= 0", enabled: true, validated: true },
        { name: "CK_FN", table: "CLM_DTL", condition: "UPPER(STAT) = STAT", enabled: true, validated: true },
        { name: "CK_OFF", table: "CLM_DTL", condition: "CLM_AMT > 1", enabled: false, validated: false },
        { name: "CK_NOVAL", table: "CLM_DTL", condition: "CLM_AMT > 2", enabled: true, validated: false },
    ],
};
const plan = (edits: MigrationEdits = {}, tablesIn = tables) => planMigration(tablesIn, new Map(), edits, found);
const by = (p: ReturnType<typeof plan>, name: string) => p.objects.find((object) => object.oracleName === name)!;

describe("the indexes and CHECK constraints of a plan", () => {
    it("lists every one, says which can be carried and why the rest cannot, and carries none by default", () => {
        const p = plan();
        expect(p.objects).toHaveLength(10);
        expect(p.objects.every((object) => !object.carried)).toBe(true);
        expect(p.objectSql).toEqual([]);
        expect([...p.objects].filter((object) => object.carriable).map((object) => object.oracleName)).toEqual(["IX_CLM_DT", "UX_CLM_AMT", "CK_AMT"]);
        expect(by(p, "IX_BM").reason).toMatch(/no bitmap indexes/);
        expect(by(p, "IX_DESC").reason).toMatch(/expression, or with a descending column/);
        expect(by(p, "IX_BROKEN").reason).toMatch(/unusable/);
        expect(by(p, "UQ_CLM_STAT").reason).toMatch(/already be called uq_clm_stat/);
        expect(by(p, "CK_FN").reason).toMatch(/calls UPPER/);
        expect(by(p, "CK_OFF").reason).toMatch(/disabled/);
        expect(by(p, "CK_NOVAL").reason).toMatch(/not validated/);
    });

    it("creates what the person chose, with the PostgreSQL names, after the rows", () => {
        const p = plan({ objects: { "index:IX_CLM_DT": { carry: true }, "index:UX_CLM_AMT": { carry: true }, "check:CK_AMT": { carry: true } } });
        expect(p.objectSql).toEqual([
            'CREATE INDEX "ix_clm_dt" ON "clm_dtl" ("clm_dt", "clm_id")',
            'CREATE UNIQUE INDEX "ux_clm_amt" ON "clm_dtl" ("clm_amt", "stat")',
            'ALTER TABLE "clm_dtl" ADD CONSTRAINT "ck_amt" CHECK ("clm_amt" >= 0)',
        ]);
        expect(p.objects.filter((object) => object.carried).map((object) => object.oracleName)).toEqual(["IX_CLM_DT", "UX_CLM_AMT", "CK_AMT"]);
        expect(p.editProblems).toEqual([]);
    });

    it("follows the names the person chose for the table and its columns", () => {
        const p = plan({ tables: { CLM_DTL: { pgName: "claims" } }, columns: { "CLM_DTL.CLM_AMT": { pgName: "amount" } }, objects: { "index:UX_CLM_AMT": { carry: true }, "check:CK_AMT": { carry: true } } });
        expect(p.objectSql).toEqual(['CREATE UNIQUE INDEX "ux_clm_amt" ON "claims" ("amount", "stat")', 'ALTER TABLE "claims" ADD CONSTRAINT "ck_amt" CHECK ("amount" >= 0)']);
    });

    it("does not carry a condition or a unique index whose column the person gave another type", () => {
        const p = plan({ columns: { "CLM_DTL.CLM_AMT": { pgType: "bigint" } }, objects: { "check:CK_AMT": { carry: true }, "index:UX_CLM_AMT": { carry: true }, "index:IX_CLM_DT": { carry: true } } });
        expect(by(p, "CK_AMT").reason).toMatch(/you changed the type of CLM_AMT/);
        expect(by(p, "UX_CLM_AMT").reason).toMatch(/unique and you changed the type/);
        expect(by(p, "IX_CLM_DT").carriable).toBe(true);
        expect(p.editProblems.join(" ")).toMatch(/check CK_AMT cannot be carried over/);
        expect(p.objectSql).toEqual(['CREATE INDEX "ix_clm_dt" ON "clm_dtl" ("clm_dt", "clm_id")']);
    });

    it("says so when the edits name an object the schema does not have, and when they ask for one that cannot be carried", () => {
        const p = plan({ objects: { "index:NOPE": { carry: true }, "index:IX_BM": { carry: true } } });
        expect(p.editProblems.join("\n")).toMatch(/no index NOPE/);
        expect(p.editProblems.join("\n")).toMatch(/index IX_BM cannot be carried over: PostgreSQL has no bitmap/);
        expect(p.objectSql).toEqual([]);
    });

    it("refuses an index that would take the name of a table", () => {
        const clash: OracleObjects = { indexes: [{ name: "CLM_DTL_IDX", table: "CLM_DTL", unique: false, type: "NORMAL", valid: true, partitioned: false, columns: [{ name: "STAT", descending: false }] }], checks: [] };
        const renamed = planMigration(tables, new Map(), { tables: { CLM_DTL: { pgName: "clm_dtl_idx" } } }, clash);
        expect(renamed.objects[0].reason).toMatch(/already be called clm_dtl_idx/);
    });
});

describe("asking for them through the assistant's operations", () => {
    const options = plan().objects.map((object) => ({ kind: object.kind, name: object.oracleName, carriable: object.carriable, reason: object.reason }));
    const apply = (operations: Parameters<typeof applyOperations>[2], edits: MigrationEdits = {}) => applyOperations(tables, edits, operations, options);

    it("carries one object, or leaves it behind again", () => {
        const carried = apply([{ op: "carry_object", kind: "index", name: "ix_clm_dt" }]);
        expect(carried.edits.objects).toEqual({ "index:IX_CLM_DT": { carry: true } });
        expect(carried.applied).toEqual(["carry over the index IX_CLM_DT"]);
        const skipped = apply([{ op: "skip_object", kind: "index", name: "IX_CLM_DT" }], carried.edits);
        expect(skipped.edits.objects).toEqual({});
    });

    it("refuses an object that cannot be carried, with its reason, and one that does not exist", () => {
        const result = apply([
            { op: "carry_object", kind: "index", name: "IX_BM" },
            { op: "carry_object", kind: "check", name: "CK_FN" },
            { op: "carry_object", kind: "index", name: "NOPE" },
        ]);
        expect(result.applied).toEqual([]);
        expect(result.rejected.map((entry) => entry.reason)).toEqual([expect.stringMatching(/no bitmap/), expect.stringMatching(/calls UPPER/), expect.stringMatching(/no index NOPE/)]);
    });

    it("carries every one of a kind that can be, and says which could not", () => {
        const result = apply([{ op: "carry_all", kind: "index" }]);
        expect(Object.keys(result.edits.objects!).sort()).toEqual(["index:IX_CLM_DT", "index:UX_CLM_AMT"]);
        expect(result.rejected.map((entry) => entry.operation).join(" ")).toMatch(/IX_BM/);
        expect(apply([{ op: "skip_all", kind: "index" }], result.edits).edits.objects).toEqual({});
    });

    it("keeps the other changes when objects are carried, and leaves the plan's object edits when a column is reset", () => {
        const result = apply([{ op: "rename_table", table: "CLM_DTL", newName: "claims" }, { op: "carry_all", kind: "check" }]);
        expect(result.edits.tables).toEqual({ CLM_DTL: { pgName: "claims" } });
        expect(result.edits.objects).toEqual({ "check:CK_AMT": { carry: true } });
        const after = apply([{ op: "reset_table", table: "CLM_DTL" }], result.edits);
        expect(after.edits.objects).toEqual({ "check:CK_AMT": { carry: true } });
    });

    it("names are folded like every other name", () => {
        expect(foldName("IX_CLM_DT")).toBe("ix_clm_dt");
    });
});
