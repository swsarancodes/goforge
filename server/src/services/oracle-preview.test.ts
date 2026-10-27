import { describe, expect, it } from "vitest";
import { isOracleReadQuery, previewOracleQuery, PREVIEW_ROWS, SETTLE_ATTEMPTS, type OracleReader } from "./oracle-preview.js";

const oracleError = (message: string, errorNum: number) => Object.assign(new Error(message), { errorNum });

/** A connection that records what it was asked and answers from `answer`. */
function standIn(answer: (sql: string) => { metaData?: unknown[]; rows?: unknown[] } | Error) {
    const calls: { sql: string; options?: Record<string, unknown> }[] = [];
    let rolledBack = 0;
    const reader: OracleReader = {
        async execute(sql, _binds, options) {
            calls.push({ sql, options });
            const result = answer(sql);
            if (result instanceof Error) throw result;
            return result;
        },
        async rollback() {
            rolledBack += 1;
        },
    };
    return { reader, calls, rolledBack: () => rolledBack, run: <T>(fn: (connection: OracleReader) => Promise<T>) => fn(reader) };
}

describe("isOracleReadQuery", () => {
    it.each([
        "SELECT 1 FROM dual",
        "select * from cust_mst;",
        "  -- the customers\n  SELECT * FROM cust_mst",
        "/* note */ WITH a AS (SELECT 1 x FROM dual) SELECT x FROM a",
    ])("accepts %j", (sql) => expect(isOracleReadQuery(sql)).toBe(true));

    it.each([
        "DELETE FROM cust_mst",
        "UPDATE cust_mst SET cust_nm = 'x'",
        "INSERT INTO cust_mst VALUES (1)",
        "MERGE INTO cust_mst USING dual ON (1 = 1) WHEN MATCHED THEN UPDATE SET cust_nm = 'x'",
        "DROP TABLE cust_mst",
        "BEGIN DELETE FROM cust_mst; END;",
        "SELECT 1 FROM dual; DELETE FROM cust_mst",
        "SELECT 1 FROM dual;\nSELECT 2 FROM dual",
        "",
        "-- only a comment",
    ])("refuses %j", (sql) => expect(isOracleReadQuery(sql)).toBe(false));

    it("is not fooled by a semicolon inside a string or a q-quote", () => {
        expect(isOracleReadQuery("SELECT 'a;b' AS t, q'[x;y]' AS u FROM dual")).toBe(true);
    });
});

describe("previewOracleQuery", () => {
    it("opens a read-only transaction first, runs the statement without its terminator, reads at most one row more than it shows, and rolls back", async () => {
        const db = standIn(() => ({ metaData: [{ name: "CUST_ID", dbTypeName: "NUMBER" }, { name: "CUST_NM", dbTypeName: "VARCHAR2" }], rows: [["1", "Asha"], ["2", null]] }));
        const outcome = await previewOracleQuery("SELECT cust_id, cust_nm FROM cust_mst;", db.run);
        expect(db.calls.map((call) => call.sql)).toEqual(["SET TRANSACTION READ ONLY", "SELECT cust_id, cust_nm FROM cust_mst"]);
        expect(db.calls[1].options).toMatchObject({ maxRows: PREVIEW_ROWS + 1 });
        expect(db.rolledBack()).toBe(1);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.result.columns).toEqual([{ name: "CUST_ID", dataType: "NUMBER" }, { name: "CUST_NM", dataType: "VARCHAR2" }]);
        expect(outcome.result.rows).toEqual([["1", "Asha"], ["2", null]]);
        expect(outcome.result.truncated).toBe(false);
    });

    it("shows PREVIEW_ROWS rows and says there were more when Oracle gave PREVIEW_ROWS + 1", async () => {
        const rows = Array.from({ length: PREVIEW_ROWS + 1 }, (_, index) => [String(index)]);
        const db = standIn(() => ({ metaData: [{ name: "N", dbTypeName: "NUMBER" }], rows }));
        const outcome = await previewOracleQuery("SELECT n FROM t", db.run);
        expect(outcome.ok && outcome.result.rows).toHaveLength(PREVIEW_ROWS);
        expect(outcome.ok && outcome.result.truncated).toBe(true);
    });

    it("returns an error in the query as a result, with its ORA- code, and still rolls back", async () => {
        const db = standIn((sql) => (sql.startsWith("SET") ? { rows: [] } : oracleError("ORA-00942: table or view does not exist\nHelp: https://docs.oracle.com/error-help/db/ora-00942/", 942)));
        const outcome = await previewOracleQuery("SELECT * FROM nope", db.run);
        expect(outcome).toMatchObject({ ok: false, error: { code: "ORA-00942", message: "ORA-00942: table or view does not exist" } });
        expect(db.rolledBack()).toBe(1);
    });

    it("says so when Oracle refuses a write inside the read-only transaction", async () => {
        const db = standIn((sql) => (sql.startsWith("SET") ? { rows: [] } : oracleError("ORA-01456: may not perform insert/delete/update operation inside a READ ONLY transaction", 1456)));
        const outcome = await previewOracleQuery("DELETE FROM cust_mst", db.run);
        expect(outcome).toMatchObject({ ok: false, error: { code: "ORA-01456" } });
    });

    it("reports a call timeout as a stop, not as a failure of the connection", async () => {
        const db = standIn((sql) => (sql.startsWith("SET") ? { rows: [] } : new Error("NJS-123: call timeout of 15000 ms exceeded with ORA-03156")));
        const outcome = await previewOracleQuery("SELECT * FROM big", db.run);
        expect(outcome).toMatchObject({ ok: false, error: { code: "timeout" } });
    });

    it("throws, rather than reporting as the query's result, an error of the connection", async () => {
        const db = standIn((sql) => (sql.startsWith("SET") ? { rows: [] } : oracleError("ORA-03113: end-of-file on communication channel", 3113)));
        await expect(previewOracleQuery("SELECT 1 FROM dual", db.run)).rejects.toThrow(/ORA-03113/);
        expect(db.rolledBack()).toBe(1);
    });

    it("tries again, in a fresh read-only transaction, when Oracle says the table was only just created (ORA-01466)", async () => {
        let queries = 0;
        const db = standIn((sql) => {
            if (sql.startsWith("SET")) return { rows: [] };
            queries += 1;
            return queries < 2 ? oracleError("ORA-01466: unable to read data - table definition has changed", 1466) : { metaData: [{ name: "N", dbTypeName: "NUMBER" }], rows: [["1"]] };
        });
        const outcome = await previewOracleQuery("SELECT n FROM fresh", db.run, { settleMs: 0 });
        expect(outcome.ok && outcome.result.rows).toEqual([["1"]]);
        expect(db.calls.map((call) => call.sql)).toEqual(["SET TRANSACTION READ ONLY", "SELECT n FROM fresh", "SET TRANSACTION READ ONLY", "SELECT n FROM fresh"]);
    });

    it("gives up on ORA-01466 after a few tries and says what Oracle said", async () => {
        const db = standIn((sql) => (sql.startsWith("SET") ? { rows: [] } : oracleError("ORA-01466: unable to read data - table definition has changed", 1466)));
        const outcome = await previewOracleQuery("SELECT n FROM fresh", db.run, { settleMs: 0 });
        expect(outcome).toMatchObject({ ok: false, error: { code: "ORA-01466" } });
        expect(db.calls.filter((call) => call.sql.startsWith("SELECT"))).toHaveLength(SETTLE_ATTEMPTS);
    });

    it("refuses more than one statement", async () => {
        const db = standIn(() => ({ rows: [] }));
        await expect(previewOracleQuery("SELECT 1 FROM dual; SELECT 2 FROM dual", db.run)).rejects.toThrow(/one SELECT/);
        expect(db.calls).toEqual([]);
    });
});
