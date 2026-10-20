import { describe, expect, it } from "vitest";
import { CELL_MAX_CHARS } from "./pg-data.js";
import { ROW_CAP, buildRunBatch, changesData, extractResults, mapError, mapResult, unknownTypeOids, type PgResultLike } from "./sql-run.js";

const result = (partial: Partial<PgResultLike>): PgResultLike => ({ command: "SELECT", rowCount: 0, fields: [], rows: [], ...partial });

describe("buildRunBatch", () => {
    it("opens a transaction, sets timeouts and wraps the run in a savepoint when none is open", () => {
        const batch = buildRunBatch("UPDATE t SET a = 1", { mode: "in-transaction", transactionOpen: false, cursor: false });
        expect(batch.text).toBe("BEGIN; SET LOCAL statement_timeout = 60000; SET LOCAL lock_timeout = 10000; SAVEPOINT goforge_run; UPDATE t SET a = 1\n; RELEASE SAVEPOINT goforge_run");
        expect(batch.text.slice(batch.prefixLength)).toMatch(/^UPDATE t SET a = 1/);
        expect(batch.resultStart).toBe(4);
    });

    it("only adds a savepoint when the transaction is already open", () => {
        const batch = buildRunBatch("DELETE FROM t", { mode: "in-transaction", transactionOpen: true, cursor: false });
        expect(batch.text).toBe("SAVEPOINT goforge_run; DELETE FROM t\n; RELEASE SAVEPOINT goforge_run");
        expect(batch.resultStart).toBe(1);
    });

    it("runs a plain read in a read-only transaction that is rolled back", () => {
        const batch = buildRunBatch("SELECT 1", { mode: "one-shot-read", transactionOpen: false, cursor: false });
        expect(batch.text).toBe("BEGIN READ ONLY; SET LOCAL statement_timeout = 60000; SET LOCAL lock_timeout = 10000; SELECT 1\n; ROLLBACK");
        expect(batch.resultStart).toBe(3);
    });

    it("fetches a single query through a cursor capped at one more than the row limit", () => {
        const batch = buildRunBatch("SELECT * FROM big", { mode: "one-shot-read", transactionOpen: false, cursor: true });
        expect(batch.text).toContain("DECLARE goforge_cur NO SCROLL CURSOR FOR SELECT * FROM big\n; FETCH FORWARD 1001 FROM goforge_cur; CLOSE goforge_cur; ROLLBACK");
        expect(batch.text.slice(batch.prefixLength)).toMatch(/^SELECT \* FROM big/);
        expect(batch.resultCount).toBe(1);
        expect(ROW_CAP).toBe(1000);
    });

    it("puts a newline before the closing `;` so a trailing comment cannot swallow it", () => {
        const batch = buildRunBatch("SELECT 1 -- done", { mode: "in-transaction", transactionOpen: true, cursor: false });
        expect(batch.text).toContain("SELECT 1 -- done\n; RELEASE");
    });
});

describe("extractResults", () => {
    it("returns only the user's statements, dropping the wrapper statements and empty results", () => {
        const batch = buildRunBatch("INSERT INTO t VALUES (1); SELECT 1", { mode: "in-transaction", transactionOpen: true, cursor: false });
        const raw = [result({ command: "SAVEPOINT" }), result({ command: "INSERT", rowCount: 1 }), result({ command: "SELECT" }), result({ command: "RELEASE" })];
        expect(extractResults(raw, batch).map((r) => r.command)).toEqual(["INSERT", "SELECT"]);
    });

    it("takes just the FETCH result in cursor mode", () => {
        const batch = buildRunBatch("SELECT 1", { mode: "one-shot-read", transactionOpen: false, cursor: true });
        const raw = [result({ command: "BEGIN" }), result({ command: "SET" }), result({ command: "SET" }), result({ command: "DECLARE CURSOR" }), result({ command: "FETCH", rowCount: 1 }), result({ command: "CLOSE" }), result({ command: "ROLLBACK" })];
        expect(extractResults(raw, batch).map((r) => r.command)).toEqual(["FETCH"]);
    });
});

describe("mapResult", () => {
    it("names columns from built-in types and the looked-up ones, and keeps NULL as null", () => {
        const mapped = mapResult(
            result({ fields: [{ name: "id", dataTypeID: 23 }, { name: "mood", dataTypeID: 99999 }, { name: "x", dataTypeID: 88888 }], rows: [["1", "happy", null]], rowCount: 1 }),
            new Map([[99999, "mood"]]),
        );
        expect(mapped.columns).toEqual([
            { name: "id", dataType: "integer" },
            { name: "mood", dataType: "mood" },
            { name: "x", dataType: "unknown" },
        ]);
        expect(mapped.rows).toEqual([["1", "happy", null]]);
    });

    it("caps rows and flags the result as truncated", () => {
        const rows = Array.from({ length: ROW_CAP + 5 }, (_, i) => [String(i)]);
        const mapped = mapResult(result({ fields: [{ name: "n", dataTypeID: 23 }], rows }), new Map());
        expect(mapped.rows).toHaveLength(ROW_CAP);
        expect(mapped.truncated).toBe(true);
        expect(mapResult(result({ rows: [["1"]], fields: [{ name: "n", dataTypeID: 23 }] }), new Map()).truncated).toBe(false);
    });

    it("cuts oversized cells and records where", () => {
        const mapped = mapResult(result({ fields: [{ name: "a", dataTypeID: 25 }, { name: "b", dataTypeID: 25 }], rows: [["x", "y".repeat(CELL_MAX_CHARS + 10)]] }), new Map());
        expect(mapped.truncatedCells).toEqual([[0, 1]]);
        expect(mapped.rows[0][1]).toHaveLength(CELL_MAX_CHARS);
    });

    it("keeps duplicate column names apart (rows are arrays, not objects)", () => {
        const mapped = mapResult(result({ fields: [{ name: "a", dataTypeID: 23 }, { name: "a", dataTypeID: 23 }], rows: [["1", "2"]] }), new Map());
        expect(mapped.rows[0]).toEqual(["1", "2"]);
    });
});

describe("unknownTypeOids", () => {
    it("lists only types that are neither built in nor already resolved", () => {
        const results = [result({ fields: [{ name: "a", dataTypeID: 23 }, { name: "b", dataTypeID: 5000 }, { name: "c", dataTypeID: 5001 }, { name: "d", dataTypeID: 5000 }] })];
        expect(unknownTypeOids(results, new Map([[5001, "known"]]))).toEqual([5000]);
    });
});

describe("mapError", () => {
    it("shifts the position from the wrapped batch onto the user's SQL", () => {
        const batch = buildRunBatch("SELEC 1", { mode: "in-transaction", transactionOpen: true, cursor: false });
        const error = Object.assign(new Error('syntax error at or near "SELEC"'), { code: "42601", position: String(batch.prefixLength + 1), hint: "Did you mean SELECT?" });
        expect(mapError(error, batch.prefixLength, 7)).toEqual({ message: 'syntax error at or near "SELEC"', code: "42601", position: 1, hint: "Did you mean SELECT?" });
    });

    it("drops a position that points into the wrapper rather than the user's SQL", () => {
        const error = Object.assign(new Error("boom"), { position: "3" });
        expect(mapError(error, 50, 10).position).toBeUndefined();
    });

    it("maps a statement offset with a negative prefix (autocommit mode)", () => {
        const error = Object.assign(new Error("bad"), { position: "4" });
        expect(mapError(error, -20, 100).position).toBe(24);
    });

    it("copes with non-Error values", () => {
        expect(mapError("nope", 0, 0)).toEqual({ message: "nope" });
    });
});

describe("changesData", () => {
    it("treats reads as unchanged and everything else as a change", () => {
        expect(changesData([{ command: "SELECT" } as never, { command: "SHOW" } as never])).toBe(false);
        expect(changesData([{ command: "SELECT" } as never, { command: "UPDATE" } as never])).toBe(true);
        expect(changesData([{ command: "create" } as never])).toBe(true);
    });
});
