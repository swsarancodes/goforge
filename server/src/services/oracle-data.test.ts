import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOracle } from "./oracle-client.js";
import { buildOracleRowsQuery, describeOracleType, fetchOracleRows, loadOracleRelations, quoteOracleIdent, textExpression } from "./oracle-data.js";
import { createOracleSchema, dropOracleSchema, newSchemaPassword, oracleSchemaName, oracleServerFromEnv } from "./oracle-schemas.js";
import { DataRequestError } from "./pg-sql.js";

describe("what the Data page asks Oracle for", () => {
    const columns = [
        { name: "ID", type: "NUMBER" },
        { name: "NAME", type: "VARCHAR2" },
        { name: "JOINED", type: "DATE" },
    ];

    it("quotes identifiers", () => {
        expect(quoteOracleIdent('A"B')).toBe('"A""B"');
    });

    it("reads every cell as text, by type", () => {
        expect(textExpression({ name: "ID", type: "NUMBER" })).toContain(`TO_CHAR("ID", 'TM9')`);
        expect(textExpression({ name: "JOINED", type: "DATE" })).toBe(`TO_CHAR("JOINED", 'YYYY-MM-DD HH24:MI:SS')`);
        expect(textExpression({ name: "T", type: "TIMESTAMP(6) WITH TIME ZONE" })).toContain("TZR");
        expect(textExpression({ name: "T", type: "TIMESTAMP(6)" })).not.toContain("TZR");
        expect(textExpression({ name: "C", type: "CLOB" })).toContain("DBMS_LOB.SUBSTR");
        expect(textExpression({ name: "R", type: "RAW" })).toBe(`RAWTOHEX("R")`);
        expect(textExpression({ name: "X", type: "XMLTYPE" })).toContain("not shown");
    });

    it("describes types the way the grid header shows them", () => {
        expect(describeOracleType({ type: "NUMBER", length: 22, charLength: 0, precision: 10, scale: 0 })).toBe("NUMBER(10)");
        expect(describeOracleType({ type: "NUMBER", length: 22, charLength: 0, precision: 12, scale: 2 })).toBe("NUMBER(12,2)");
        expect(describeOracleType({ type: "NUMBER", length: 22, charLength: 0, precision: null, scale: null })).toBe("NUMBER");
        expect(describeOracleType({ type: "VARCHAR2", length: 400, charLength: 100, precision: null, scale: null })).toBe("VARCHAR2(100)");
        expect(describeOracleType({ type: "DATE", length: 7, charLength: 0, precision: null, scale: null })).toBe("DATE");
    });

    it("pages with the primary key as the tie-breaker, and with ROWID when there is none", () => {
        const keyed = buildOracleRowsQuery({ schema: "S", table: "T", columns, pkColumns: ["ID"], kind: "table", limit: 50, offset: 100 });
        expect(keyed.text).toContain(`FROM "S"."T" ORDER BY "ID" OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY`);
        const keyless = buildOracleRowsQuery({ schema: "S", table: "T", columns, pkColumns: [], kind: "table" });
        expect(keyless.text).toContain("ORDER BY ROWID");
        const view = buildOracleRowsQuery({ schema: "S", table: "V", columns, pkColumns: [], kind: "view" });
        expect(view.text).not.toContain("ORDER BY");
    });

    it("sorts on the chosen column first, NULLs last, and does not repeat it as the tie-breaker", () => {
        const sorted = buildOracleRowsQuery({ schema: "S", table: "T", columns, pkColumns: ["ID"], kind: "table", sort: "ID", dir: "desc" });
        expect(sorted.text).toContain(`ORDER BY "ID" DESC NULLS LAST OFFSET`);
        const byName = buildOracleRowsQuery({ schema: "S", table: "T", columns, pkColumns: ["ID"], kind: "table", sort: "NAME" });
        expect(byName.text).toContain(`ORDER BY "NAME" ASC NULLS LAST, "ID" OFFSET`);
    });

    it("clamps the page size and refuses a sort column the table does not have", () => {
        expect(buildOracleRowsQuery({ schema: "S", table: "T", columns, pkColumns: [], kind: "table", limit: 99999 }).limit).toBe(500);
        expect(buildOracleRowsQuery({ schema: "S", table: "T", columns, pkColumns: [], kind: "table", offset: -5 }).offset).toBe(0);
        expect(() => buildOracleRowsQuery({ schema: "S", table: "T", columns, pkColumns: [], kind: "table", sort: "NOPE" })).toThrow(DataRequestError);
        expect(() => buildOracleRowsQuery({ schema: "S", table: "T", columns: [], pkColumns: [], kind: "table" })).toThrow(DataRequestError);
    });
});

/** Against a real Oracle: ORACLE_TEST_ADMIN_URL=oracle://system:password@127.0.0.1:1521/FREEPDB1. Skipped without it. */
const url = process.env.ORACLE_TEST_ADMIN_URL;
const server = url ? oracleServerFromEnv({ ORACLE_ADMIN_URL: url } as NodeJS.ProcessEnv) : undefined;

describe.skipIf(!server)("the Data page on a real Oracle schema", () => {
    const schema = oracleSchemaName("data-page-test", "T1");
    const password = newSchemaPassword();
    const admin = server?.admin as NonNullable<typeof server>["admin"];
    const as = <T>(fn: Parameters<typeof withOracle<T>>[1]) => withOracle({ ...admin, user: schema, password }, fn);

    beforeAll(async () => {
        await dropOracleSchema(admin, schema).catch(() => undefined);
        await createOracleSchema(
            admin,
            schema,
            password,
            `CREATE TABLE things (id NUMBER(5) PRIMARY KEY, label VARCHAR2(20), price NUMBER(8,2), made DATE, stamp TIMESTAMP(3), note CLOB, raw_bytes RAW(4));
             INSERT INTO things VALUES (1, 'alpha', 0.5, DATE '2026-03-04', TIMESTAMP '2026-03-04 05:06:07.123', 'a long note', HEXTORAW('DEADBEEF'));
             INSERT INTO things VALUES (2, NULL, -12.25, DATE '2026-12-31', NULL, NULL, NULL);
             INSERT INTO things VALUES (3, 'gamma', 1000, DATE '2027-01-01', NULL, NULL, NULL);
             CREATE TABLE loose (a VARCHAR2(5));
             INSERT INTO loose VALUES ('x');
             CREATE VIEW cheap AS SELECT id, price FROM things WHERE price < 100;`,
        );
    });
    afterAll(async () => {
        await dropOracleSchema(admin, schema).catch(() => undefined);
    });

    it("lists the tables and views with their types, keys and row counts", async () => {
        const relations = await as(loadOracleRelations);
        expect(relations.map((relation) => `${relation.kind}:${relation.name}`)).toEqual(["table:LOOSE", "table:THINGS", "view:CHEAP"]);
        const things = relations.find((relation) => relation.name === "THINGS")!;
        expect(things.schema).toBe(schema);
        expect(things.primaryKey).toEqual(["ID"]);
        expect(things.estimatedRows).toBe(3);
        expect(things.columns.map((column) => `${column.name} ${column.dataType}`)).toEqual(["ID NUMBER(5)", "LABEL VARCHAR2(20)", "PRICE NUMBER(8,2)", "MADE DATE", "STAMP TIMESTAMP(3)", "NOTE CLOB", "RAW_BYTES RAW(4)"]);
        expect(relations.find((relation) => relation.name === "CHEAP")!.estimatedRows).toBeNull();
    });

    it("reads rows as text, with NULLs kept and numbers and dates in a plain form", async () => {
        const page = await as((connection) => fetchOracleRows(connection, { schema, table: "THINGS", exactCount: true }));
        expect(page.rows).toEqual([
            ["1", "alpha", "0.5", "2026-03-04 00:00:00", "2026-03-04 05:06:07.123", "a long note", "DEADBEEF"],
            ["2", null, "-12.25", "2026-12-31 00:00:00", null, null, null],
            ["3", "gamma", "1000", "2027-01-01 00:00:00", null, null, null],
        ]);
        expect(page.exactTotal).toBe(3);
        expect(page.columns[0]).toEqual({ name: "ID", dataType: "NUMBER(5)", isPrimaryKey: true });
    });

    it("sorts, pages, and reads a table with no key and a view", async () => {
        const sorted = await as((connection) => fetchOracleRows(connection, { schema, table: "THINGS", sort: "PRICE", dir: "desc", limit: 2, offset: 1 }));
        expect(sorted.rows.map((row) => row[0])).toEqual(["1", "2"]);
        expect(sorted.dir).toBe("desc");
        expect((await as((connection) => fetchOracleRows(connection, { schema, table: "LOOSE" }))).rows).toEqual([["x"]]);
        expect((await as((connection) => fetchOracleRows(connection, { schema, table: "CHEAP" }))).rows).toEqual([["1", "0.5"], ["2", "-12.25"]]);
    });

    it("refuses a table that is not there, and a name that is only the right table in another case", async () => {
        await expect(as((connection) => fetchOracleRows(connection, { schema, table: "NOPE" }))).rejects.toThrow(DataRequestError);
        await expect(as((connection) => fetchOracleRows(connection, { schema, table: "things" }))).rejects.toThrow(DataRequestError);
        await expect(as((connection) => fetchOracleRows(connection, { schema: "SYS", table: "THINGS" }))).rejects.toThrow(DataRequestError);
    });
});
