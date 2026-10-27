import { describe, expect, it } from "vitest";
import type { PreviewResponse } from "@/lib/modernizer-api";
import { compareSides, defaultIgnoreOrder, isSelectQuery, postgresHint, runBoth, runBothBlocker, sideSummary, takesUnorderedFirstRows, type Side } from "./run-both";

const rowsResponse = (columns: string[], rows: (string | null)[][], truncated = false): PreviewResponse => ({
    ok: true,
    elapsedMs: 5,
    result: { command: "SELECT", rowCount: rows.length, columns: columns.map((name) => ({ name, dataType: "text" })), rows, truncated, truncatedCells: [] },
});
const failure = (message: string, code?: string): PreviewResponse => ({ ok: false, elapsedMs: 3, error: { message, code } });

/** A promise that is settled from outside, so a test decides when each database "answers". */
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
};

describe("runBoth", () => {
    it("starts both queries before either has answered", async () => {
        const events: string[] = [];
        const oracle = deferred<PreviewResponse>();
        const postgres = deferred<PreviewResponse>();
        const running = runBoth(
            () => (events.push("oracle started"), oracle.promise),
            () => (events.push("postgres started"), postgres.promise),
        );
        // both are under way while nothing has come back
        await Promise.resolve();
        expect(events).toEqual(["oracle started", "postgres started"]);
        // the slower one first: the result still waits for both
        postgres.resolve(rowsResponse(["N"], [["1"]]));
        oracle.resolve(rowsResponse(["N"], [["1"]]));
        const both = await running;
        expect(both.oracle.ok && both.postgres.ok).toBe(true);
    });

    it("keeps the side that worked when the other one fails", async () => {
        const both = await runBoth(
            async () => failure("ORA-00942: table or view does not exist", "ORA-00942"),
            async () => rowsResponse(["N"], [["1"]]),
        );
        expect(both.oracle).toEqual({ ok: false, message: "ORA-00942: table or view does not exist", code: "ORA-00942", elapsedMs: 3 });
        expect(both.postgres.ok).toBe(true);
    });

    it("turns a request that throws (a database that cannot be reached) into a failed side, not an exception", async () => {
        const both = await runBoth(
            async () => {
                throw new Error("connect ECONNREFUSED 127.0.0.1:1521");
            },
            async () => rowsResponse(["N"], [["1"]]),
        );
        expect(both.oracle).toMatchObject({ ok: false, message: "connect ECONNREFUSED 127.0.0.1:1521" });
        expect(both.postgres.ok).toBe(true);
    });
});

describe("compareSides", () => {
    const side = (columns: string[], rows: (string | null)[][], truncated = false): Side => {
        const response = rowsResponse(columns, rows, truncated);
        if (!response.ok) throw new Error("test setup");
        return { ok: true, result: response.result, elapsedMs: 1 };
    };

    it("says the two are the same when every value matches, whatever the formatting: 100 and 100.00, a date and its midnight, NULL and nothing", () => {
        const outcome = compareSides(side(["ID", "AMT", "DAY", "NOTE"], [["1", "100", "2026-03-01 00:00:00", null]]), side(["id", "amt", "day", "note"], [["1", "100.00", "2026-03-01 00:00:00", ""]]), false);
        expect(outcome?.comparison.matches).toBe(true);
        expect(outcome?.marked.left.size).toBe(0);
        expect(outcome?.marked.right.size).toBe(0);
    });

    it("finds the silent difference: the same row count, one value different (integer division)", () => {
        const outcome = compareSides(side(["POLCY_ID", "OPEN_SHARE"], [["101", "0.5"], ["102", "0"]]), side(["polcy_id", "open_share"], [["101", "0"], ["102", "0"]]), false);
        expect(outcome?.comparison.matches).toBe(false);
        expect(outcome?.comparison.expectedRows).toBe(2);
        expect(outcome?.comparison.actualRows).toBe(2);
        expect(outcome?.comparison.differences).toEqual([{ row: 1, column: "OPEN_SHARE", expected: "0.5", actual: "0" }]);
        expect([...outcome!.marked.left]).toEqual([0]);
        expect([...outcome!.marked.right]).toEqual([0]);
    });

    it("marks the rows one side has and the other does not, when the order is ignored", () => {
        const outcome = compareSides(side(["N"], [["1"], ["2"], ["3"]]), side(["n"], [["3"], ["1"]]), true);
        expect(outcome?.comparison.matches).toBe(false);
        expect([...outcome!.marked.left]).toEqual([1]);
        expect(outcome!.marked.right.size).toBe(0);
    });

    it("compares row by row when the order matters: the same rows in another order differ", () => {
        const set = compareSides(side(["N"], [["1"], ["2"]]), side(["n"], [["2"], ["1"]]), true);
        const ordered = compareSides(side(["N"], [["1"], ["2"]]), side(["n"], [["2"], ["1"]]), false);
        expect(set?.comparison.matches).toBe(true);
        expect(ordered?.comparison.matches).toBe(false);
    });

    it("compares nothing when either side did not return rows", () => {
        const failed: Side = { ok: false, message: "no" };
        expect(compareSides(failed, side(["N"], [["1"]]), true)).toBeUndefined();
        expect(compareSides(side(["N"], [["1"]]), failed, true)).toBeUndefined();
    });
});

describe("defaultIgnoreOrder", () => {
    it("keeps the order only when the original asks for one", () => {
        expect(defaultIgnoreOrder("SELECT * FROM t")).toBe(true);
        expect(defaultIgnoreOrder("SELECT * FROM t ORDER BY a")).toBe(false);
        expect(defaultIgnoreOrder("select * from t\norder  by a")).toBe(false);
    });
});

describe("postgresHint", () => {
    it("explains a missing table after a migration renamed tables, and nothing else", () => {
        expect(postgresHint({ ok: false, message: "relation does not exist", code: "42P01" })).toMatch(/new names/);
        expect(postgresHint({ ok: false, message: "syntax error", code: "42601" })).toBeUndefined();
    });
});

describe("runBothBlocker", () => {
    const ready = { dialect: "oracle", oracleDatabases: 1, oracleChosen: true, originalIsSelect: true, bindsInOriginal: false, previewBlocker: undefined };
    it("lets it run when everything is in place", () => expect(runBothBlocker(ready)).toBeUndefined());
    it("needs an Oracle query", () => expect(runBothBlocker({ ...ready, dialect: "mssql" })).toMatch(/Oracle/));
    it("says to create an Oracle database when there is none", () => expect(runBothBlocker({ ...ready, oracleDatabases: 0, oracleChosen: false })).toMatch(/Create an Oracle database/));
    it("says to choose one when there are several and none is chosen", () => expect(runBothBlocker({ ...ready, oracleDatabases: 3, oracleChosen: false })).toMatch(/Choose/));
    it("only runs a SELECT: it reads, and the button says so instead of failing when clicked", () => expect(runBothBlocker({ ...ready, originalIsSelect: false })).toMatch(/only runs a SELECT/));
    it("refuses an original with bind variables, which Oracle cannot run without values", () => expect(runBothBlocker({ ...ready, bindsInOriginal: true })).toMatch(/bind variables/));
    it("passes on why the PostgreSQL side cannot run", () => expect(runBothBlocker({ ...ready, previewBlocker: "Choose a connection to run it on." })).toBe("Choose a connection to run it on."));
});

describe("isSelectQuery", () => {
    it.each(["SELECT 1 FROM dual", "select * from t;", "  -- all of them\n  SELECT * FROM t", "/* note */ WITH a AS (SELECT 1 FROM dual) SELECT * FROM a", "WITH\nx AS (SELECT 1 FROM dual) SELECT * FROM x"])("accepts %j", (sql) => expect(isSelectQuery(sql)).toBe(true));
    it.each(["DELETE FROM t", "UPDATE t SET a = 1", "INSERT INTO t VALUES (1)", "MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN UPDATE SET a = 1", "BEGIN NULL; END;", "-- select\nDELETE FROM t", "", "selection_of_things"])("refuses %j", (sql) => expect(isSelectQuery(sql)).toBe(false));
});

describe("sideSummary", () => {
    const rows = (count: number, truncated = false): Side => ({ ok: true, elapsedMs: 32, result: { command: "SELECT", rowCount: count, columns: [], rows: Array.from({ length: count }, () => ["1"]), truncated, truncatedCells: [] } });

    it("says what came back and how long it took", () => {
        expect(sideSummary("Oracle", rows(7))).toBe("Oracle returned 7 rows in 32 ms");
        expect(sideSummary("PostgreSQL", rows(1))).toBe("PostgreSQL returned 1 row in 32 ms");
        expect(sideSummary("Oracle", rows(0))).toBe("Oracle returned 0 rows in 32 ms");
    });

    it("marks a result cut at the first rows", () => expect(sideSummary("Oracle", rows(100, true))).toBe("Oracle returned 100+ rows in 32 ms"));

    it("says a side failed, never that it 'returned failed'", () => {
        expect(sideSummary("Oracle", { ok: false, message: "Connection not found", elapsedMs: 16 })).toBe("Oracle failed in 16 ms");
        expect(sideSummary("Oracle", { ok: false, message: "x" })).toBe("Oracle failed");
    });
});

describe("takesUnorderedFirstRows", () => {
    it("is true for the first N rows without an ORDER BY", () => {
        expect(takesUnorderedFirstRows("SELECT * FROM t WHERE ROWNUM <= 10")).toBe(true);
        expect(takesUnorderedFirstRows("SELECT * FROM t FETCH FIRST 10 ROWS ONLY")).toBe(true);
        expect(takesUnorderedFirstRows("SELECT * FROM t LIMIT 10")).toBe(true);
    });
    it("is false once the rows are ordered, and when there is no limit", () => {
        expect(takesUnorderedFirstRows("SELECT * FROM (SELECT * FROM t ORDER BY a) WHERE ROWNUM <= 10")).toBe(false);
        expect(takesUnorderedFirstRows("SELECT * FROM t")).toBe(false);
        expect(takesUnorderedFirstRows("SELECT rownumber FROM t")).toBe(false);
    });
});
