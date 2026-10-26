import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseDialect } from "@/lib/database";
import { parse } from "@/test/fixtures/dbml-builders";

const example = (file: string) => readFileSync(resolve(import.meta.dirname, "../../../examples/oracle-insurance-10", file), "utf8");
const DBML = example("schema.dbml");
const DDL = example("schema_oracle.sql");

const TABLES = ["AGNT_MST", "PROD_MST", "ADJSTR_MST", "CUST_MST", "CUST_ADDR", "POLCY_HDR", "POLCY_COVG", "PREM_PMT", "CLM_DTL", "CLM_PYMT"];

describe("the 10-table legacy insurer as DBML", () => {
    it("imports as an Oracle diagram with the ten tables and no warnings", async () => {
        const { file, warnings } = await parse(DBML, DatabaseDialect.ORACLE);
        expect(warnings).toEqual([]);
        expect(file.project.dialect).toBe(DatabaseDialect.ORACLE);
        expect(file.project.tables.map((table) => table.name).sort()).toEqual([...TABLES].sort());
        for (const table of file.project.tables) expect(table.fields.filter((field) => field.isPrimary), table.name).toHaveLength(1);
    });

    it("has the same tables and columns as the Oracle DDL", async () => {
        const { file } = await parse(DBML, DatabaseDialect.ORACLE);
        const fromDdl = new Map<string, string[]>();
        for (const match of DDL.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
            const columns = match[2].split("\n").map((line) => /^\s{4}(\w+)\s+(?:NUMBER|VARCHAR2|CHAR|DATE|CLOB|TIMESTAMP)/.exec(line)?.[1]).filter((name): name is string => !!name);
            fromDdl.set(match[1], columns);
        }
        expect([...fromDdl.keys()].sort()).toEqual([...TABLES].sort());
        for (const table of file.project.tables) expect(table.fields.map((field) => field.name), table.name).toEqual(fromDdl.get(table.name));
    });

    it("has the ten foreign keys of the DDL, from the child to the parent", async () => {
        const { file } = await parse(DBML, DatabaseDialect.ORACLE);
        expect(file.project.relationships).toHaveLength(10);
        expect((DDL.match(/REFERENCES \w+ \(/g) ?? []).length).toBe(10);
        const nameOf = new Map(file.project.tables.map((table) => [table.id, table.name] as const));
        // the table a key points at is the source, the table that holds the key is the target
        const edges = file.project.relationships.map((relationship) => `${nameOf.get(relationship.targetTableId)}>${nameOf.get(relationship.sourceTableId)}`).sort();
        expect(edges).toEqual(
            [
                "CUST_ADDR>CUST_MST", "POLCY_HDR>CUST_MST", "POLCY_HDR>AGNT_MST", "POLCY_HDR>PROD_MST", "POLCY_COVG>POLCY_HDR",
                "PREM_PMT>POLCY_HDR", "CLM_DTL>POLCY_HDR", "CLM_DTL>ADJSTR_MST", "CLM_PYMT>CLM_DTL", "CLM_PYMT>ADJSTR_MST",
            ].sort(),
        );
    });

    it("carries the indexes, the unique rules and the CHECK constraints the DDL has", async () => {
        const { file } = await parse(DBML, DatabaseDialect.ORACLE);
        const table = (name: string) => file.project.tables.find((candidate) => candidate.name === name)!;
        expect(table("POLCY_HDR").indices.map((index) => index.name).sort()).toEqual(["IX_POLCY_AGNT", "IX_POLCY_CUST"]);
        expect(table("POLCY_COVG").indices.find((index) => index.name === "UQ_POLCY_COVG")).toMatchObject({ unique: true });
        expect(table("POLCY_HDR").checks?.map((check) => check.name)).toEqual(["CK_POLCY_DATES"]);
        expect(table("CLM_DTL").checks?.map((check) => check.name)).toEqual(["CK_CLM_AMT"]);
        expect(table("ADJSTR_MST").fields.find((field) => field.name === "LCNS_NO")).toMatchObject({ unique: true });
        for (const name of ["IX_POLCY_CUST", "IX_POLCY_AGNT", "IX_PMT_POLCY", "IX_CLM_POLCY", "CK_POLCY_DATES", "CK_CLM_AMT", "UQ_POLCY_COVG"]) expect(DDL, name).toContain(name);
    });

    it("keeps the three original tables' columns, so the earlier Oracle queries still run", async () => {
        const { file } = await parse(DBML, DatabaseDialect.ORACLE);
        const columns = (name: string) => file.project.tables.find((table) => table.name === name)!.fields.map((field) => field.name);
        expect(columns("CUST_MST")).toEqual(["CUST_ID", "CUST_NM", "CUST_EMAIL", "SEGMT_CD", "JOIN_DT"]);
        expect(columns("POLCY_HDR").slice(0, 7)).toEqual(["POLCY_ID", "CUST_ID", "POLCY_TYP_CD", "EFF_DT", "EXP_DT", "ANNL_PREM", "STAT_CD"]);
        expect(columns("CLM_DTL").slice(0, 7)).toEqual(["CLM_ID", "POLCY_ID", "CLM_DT", "CLM_AMT", "CLM_STAT_CD", "ADJ_NOTE", "PAID_AMT"]);
    });
});
