import { describe, expect, it } from "vitest";
import { errorRange, positionToLineColumn } from "./error-position";
import { applySqlHandoff, setSqlHandoff, takeSqlHandoff } from "./handoff";
import { MAX_HISTORY, addSqlHistory, clearSqlHistory, loadSqlHistory, type SqlHistoryEntry, type StringStorage } from "./sql-history";

const memoryStorage = (): StringStorage => {
    const data = new Map<string, string>();
    return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
};
const entry = (sql: string, extra: Partial<SqlHistoryEntry> = {}): SqlHistoryEntry => ({ id: sql, sql, connectionId: "c1", at: 1, ok: true, ms: 5, ...extra });

describe("positionToLineColumn", () => {
    it("maps a 1-based position to line and column", () => {
        expect(positionToLineColumn("SELECT 1", 1)).toEqual({ line: 1, column: 1 });
        expect(positionToLineColumn("SELECT 1;\nSELEC 2", 11)).toEqual({ line: 2, column: 1 });
        expect(positionToLineColumn("SELECT 1;\nSELEC 2", 17)).toEqual({ line: 2, column: 7 });
    });

    it("clamps positions outside the text", () => {
        expect(positionToLineColumn("abc", 0)).toEqual({ line: 1, column: 1 });
        expect(positionToLineColumn("a\nb", 99)).toEqual({ line: 2, column: 2 });
    });
});

describe("errorRange", () => {
    it("selects the word at the position", () => {
        expect(errorRange("SELEC 1", 1)).toEqual({ from: 0, to: 5 });
        expect(errorRange("SELECT foo_bar FROM t", 8)).toEqual({ from: 7, to: 14 });
    });

    it("selects one character for punctuation and stays inside the text", () => {
        expect(errorRange("SELECT ,", 8)).toEqual({ from: 7, to: 8 });
        expect(errorRange("abc", 99)).toEqual({ from: 3, to: 3 });
    });
});

describe("SQL handoff", () => {
    it("is taken once", () => {
        setSqlHandoff({ sql: "CREATE INDEX i ON t (a)", source: "Modernizer" });
        expect(takeSqlHandoff()).toEqual({ sql: "CREATE INDEX i ON t (a)", source: "Modernizer" });
        expect(takeSqlHandoff()).toBeUndefined();
    });

    it("replaces an empty editor and appends under a source comment otherwise", () => {
        const handoff = { sql: "  ALTER TABLE t ADD COLUMN c int;  ", source: "AI Schema" };
        expect(applySqlHandoff("  \n", handoff)).toBe("ALTER TABLE t ADD COLUMN c int;\n");
        expect(applySqlHandoff("SELECT 1;\n\n", handoff)).toBe("SELECT 1;\n\n-- From AI Schema\nALTER TABLE t ADD COLUMN c int;\n");
    });
});

describe("SQL history", () => {
    it("keeps newest first and survives a reload", () => {
        const storage = memoryStorage();
        addSqlHistory(entry("SELECT 1"), storage);
        addSqlHistory(entry("SELECT 2"), storage);
        expect(loadSqlHistory(storage).map((e) => e.sql)).toEqual(["SELECT 2", "SELECT 1"]);
    });

    it("does not repeat the same SQL on the same connection, but keeps it per connection", () => {
        const storage = memoryStorage();
        addSqlHistory(entry("SELECT 1"), storage);
        addSqlHistory(entry("SELECT 2"), storage);
        addSqlHistory(entry("SELECT 1 ", { ok: false, id: "again" }), storage);
        addSqlHistory(entry("SELECT 1", { connectionId: "c2", id: "other" }), storage);
        const loaded = loadSqlHistory(storage);
        expect(loaded.map((e) => `${e.connectionId}:${e.sql.trim()}`)).toEqual(["c2:SELECT 1", "c1:SELECT 1", "c1:SELECT 2"]);
        expect(loaded[1].ok).toBe(false);
    });

    it("caps the length", () => {
        const storage = memoryStorage();
        for (let i = 0; i < MAX_HISTORY + 10; i++) addSqlHistory(entry(`SELECT ${i}`), storage);
        const loaded = loadSqlHistory(storage);
        expect(loaded).toHaveLength(MAX_HISTORY);
        expect(loaded[0].sql).toBe(`SELECT ${MAX_HISTORY + 9}`);
    });

    it("ignores corrupt storage and never throws when storage is unavailable", () => {
        const corrupt = memoryStorage();
        corrupt.setItem("goforge.sql.history.v1", "{nope");
        expect(loadSqlHistory(corrupt)).toEqual([]);
        corrupt.setItem("goforge.sql.history.v1", JSON.stringify([{ sql: "x" }, entry("ok")]));
        expect(loadSqlHistory(corrupt).map((e) => e.sql)).toEqual(["ok"]);

        const throwing: StringStorage = {
            getItem() {
                throw new Error("blocked");
            },
            setItem() {
                throw new Error("quota");
            },
        };
        expect(loadSqlHistory(throwing)).toEqual([]);
        expect(() => addSqlHistory(entry("SELECT 1"), throwing)).not.toThrow();
        expect(() => clearSqlHistory(throwing)).not.toThrow();
        expect(loadSqlHistory(undefined)).toEqual([]);
    });
});
