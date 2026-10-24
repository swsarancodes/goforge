import { describe, expect, it } from "vitest";
import golden from "./corpus/golden.json";
import { CASES } from "./corpus/cases";
import { FIXTURE_SCHEMA } from "./corpus/fixture";
import { checkPostgresSyntax } from "./checks";
import { convertQuery } from "./convert";

/**
 * The corpus's executable half (running the converted SQL on PostgreSQL and comparing rows) is `npm run test:corpus`.
 * These checks need no database: every case converts, says what it says it does, keeps its exact output, and the SQL
 * it produces is accepted by a PostgreSQL grammar.
 */
const run = (id: string) => {
    const c = CASES.find((candidate) => candidate.id === id)!;
    return { c, conversion: convertQuery({ sql: c.sql, dialect: c.from, schema: c.schema ? FIXTURE_SCHEMA : undefined }) };
};

describe("modernizer corpus", () => {
    it("has enough cases, with unique ids", () => {
        expect(CASES.length).toBeGreaterThanOrEqual(150);
        expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    });

    it("covers every source dialect and every rule family", () => {
        expect(new Set(CASES.map((c) => c.from))).toEqual(new Set(["oracle", "mssql", "mysql", "db2"]));
        expect(new Set(CASES.map((c) => c.family)).size).toBeGreaterThanOrEqual(10);
    });

    it.each(CASES.map((c) => [c.id]))("%s converts and reports what it should", (id) => {
        const { c, conversion } = run(id);
        expect(conversion.syntaxError).toBeUndefined();
        if (c.unconverted) {
            expect(conversion.unconverted.length, "an unconvertible query must say so").toBeGreaterThan(0);
            return;
        }
        expect(conversion.unconverted, "nothing should be left unconverted").toEqual([]);
        for (const trap of [...(c.trap ? [c.trap] : []), ...(c.traps ?? [])]) {
            expect(conversion.traps.map((t) => t.id), `trap ${trap}`).toContain(trap);
        }
    });

    it("keeps the exact output of every case (regenerate with `npm run corpus:golden` and review the diff)", () => {
        const changed: string[] = [];
        for (const c of CASES) {
            const sql = convertQuery({ sql: c.sql, dialect: c.from, schema: c.schema ? FIXTURE_SCHEMA : undefined }).sql;
            if ((golden as Record<string, string>)[c.id] !== sql) changed.push(c.id);
        }
        expect(changed).toEqual([]);
    });

    it("produces SQL that a PostgreSQL grammar accepts", async () => {
        const rejected: string[] = [];
        for (const c of CASES) {
            if (c.unconverted) continue;
            const conversion = convertQuery({ sql: c.sql, dialect: c.from, schema: c.schema ? FIXTURE_SCHEMA : undefined });
            const check = await checkPostgresSyntax(conversion.validationSql);
            if (!check.ok) rejected.push(`${c.id}: ${check.error}`);
        }
        expect(rejected).toEqual([]);
    });
});
