import { describe, expect, it } from "vitest";
import type { LegacyDialect, SchemaContext } from "../types";
import { CASES } from "./corpus/cases";
import { FIXTURE_SCHEMA } from "./corpus/fixture";
import { convertQuery } from "./convert";

const sql = (dialect: LegacyDialect, text: string, schema?: SchemaContext) => convertQuery({ sql: text, dialect, schema }).sql;
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

describe("null handling and conditionals", () => {
    it("converts DECODE with literals to a simple CASE, and keeps NULL matching for everything else", () => {
        expect(sql("oracle", "SELECT DECODE(status, 'A', 'Active', 'Unknown') FROM emp")).toBe("SELECT CASE status WHEN 'A' THEN 'Active' ELSE 'Unknown' END FROM emp");
        expect(sql("oracle", "SELECT DECODE(a, b, 'same', 'diff') FROM t")).toBe("SELECT CASE WHEN a IS NOT DISTINCT FROM b THEN 'same' ELSE 'diff' END FROM t");
        expect(sql("oracle", "SELECT DECODE(a, NULL, 'none', a) FROM t")).toBe("SELECT CASE WHEN a IS NULL THEN 'none' ELSE a END FROM t");
    });

    it("converts the inside of a DECODE before the DECODE itself (no COALESCE(COALESCE(…)) mistake)", () => {
        expect(sql("oracle", "SELECT DECODE(NVL(status, 'X'), 'A', 'Active', 'Unknown') FROM emp")).toBe("SELECT CASE COALESCE(status, 'X') WHEN 'A' THEN 'Active' ELSE 'Unknown' END FROM emp");
    });

    it("converts NVL, ISNULL, IFNULL, VALUE, NVL2 and IIF/IF", () => {
        expect(sql("oracle", "SELECT NVL(a, 0), NVL2(b, 1, 0) FROM t")).toBe("SELECT COALESCE(a, 0), CASE WHEN b IS NOT NULL THEN 1 ELSE 0 END FROM t");
        expect(sql("mssql", "SELECT ISNULL(a, 0), IIF(b > 1, 'x', 'y') FROM t")).toBe("SELECT COALESCE(a, 0), CASE WHEN b > 1 THEN 'x' ELSE 'y' END FROM t");
        expect(sql("mysql", "SELECT IFNULL(a, 0), IF(b > 1, 'x', 'y') FROM t")).toBe("SELECT COALESCE(a, 0), CASE WHEN b > 1 THEN 'x' ELSE 'y' END FROM t");
        expect(sql("db2", "SELECT VALUE(a, 0) FROM t")).toBe("SELECT COALESCE(a, 0) FROM t");
    });

    it("only rewrites a function in the dialect that has it", () => {
        // ISNULL(x) in Oracle is not a function; IFNULL in SQL Server is not either
        expect(sql("oracle", "SELECT ISNULL(a, 0) FROM t")).toBe("SELECT ISNULL(a, 0) FROM t");
        expect(sql("mssql", "SELECT IFNULL(a, 0) FROM t")).toBe("SELECT IFNULL(a, 0) FROM t");
    });
});

describe("outer joins", () => {
    it("turns (+) into LEFT JOIN, moving the join condition into ON", () => {
        expect(flat(sql("oracle", "SELECT e.name, d.name FROM emp e, dept d WHERE e.dept_id = d.id(+)"))).toBe("SELECT e.name, d.name FROM emp e LEFT JOIN dept d ON e.dept_id = d.id");
    });

    it("puts conditions marked (+) in ON and leaves ordinary filters in WHERE", () => {
        const out = flat(sql("oracle", "SELECT * FROM emp e, dept d WHERE e.dept_id = d.id(+) AND d.name(+) = 'Sales' AND e.salary > 5000"));
        expect(out).toBe("SELECT * FROM emp e LEFT JOIN dept d ON e.dept_id = d.id AND d.name = 'Sales' WHERE e.salary > 5000");
    });

    it("orders chained outer joins by what each one depends on", () => {
        const out = flat(sql("oracle", "SELECT * FROM ord o, emp e, dept d WHERE e.dept_id = d.id(+) AND o.emp_id = e.id(+)"));
        expect(out).toBe("SELECT * FROM ord o LEFT JOIN emp e ON o.emp_id = e.id LEFT JOIN dept d ON e.dept_id = d.id");
    });

    it("moves inner join conditions into INNER JOIN … ON", () => {
        const out = flat(sql("oracle", "SELECT * FROM emp e, dept d, ord o WHERE e.dept_id = d.id AND e.id = o.emp_id(+)"));
        expect(out).toBe("SELECT * FROM emp e LEFT JOIN ord o ON e.id = o.emp_id INNER JOIN dept d ON e.dept_id = d.id");
    });

    it("leaves a (+) it cannot place and says so", () => {
        const result = convertQuery({ sql: "SELECT * FROM emp e, dept d WHERE e.dept_id = d.id(+) OR d.id(+) = 1", dialect: "oracle" });
        expect(result.unconverted[0].reason).toMatch(/OR/);
        expect(result.sql).toContain("-- NOT CONVERTED");
        const noAlias = convertQuery({ sql: "SELECT * FROM emp e, dept d WHERE dept_id = id(+)", dialect: "oracle" });
        expect(noAlias.unconverted.length).toBeGreaterThan(0);
    });
});

describe("row limiting", () => {
    it("converts TOP, including TOP (n), DISTINCT TOP and WITH TIES", () => {
        expect(sql("mssql", "SELECT TOP 10 * FROM emp ORDER BY id")).toBe("SELECT * FROM emp ORDER BY id LIMIT 10");
        expect(sql("mssql", "SELECT TOP (5) id FROM emp")).toBe("SELECT id FROM emp LIMIT 5");
        expect(sql("mssql", "SELECT DISTINCT TOP 2 a FROM t ORDER BY a")).toBe("SELECT DISTINCT a FROM t ORDER BY a LIMIT 2");
        expect(sql("mssql", "SELECT TOP 2 WITH TIES a FROM t ORDER BY a")).toBe("SELECT a FROM t ORDER BY a FETCH FIRST 2 ROWS WITH TIES");
    });

    it("brackets a limited arm of a UNION", () => {
        expect(sql("mssql", "SELECT TOP 1 a FROM t UNION ALL SELECT b FROM u")).toBe("(SELECT a FROM t LIMIT 1) UNION ALL SELECT b FROM u");
        expect(sql("oracle", "SELECT a FROM t WHERE ROWNUM <= 5 UNION SELECT b FROM u")).toBe("(SELECT a FROM t LIMIT 5) UNION SELECT b FROM u");
    });

    it("converts ROWNUM limits and flags the ORDER BY difference", () => {
        expect(sql("oracle", "SELECT * FROM emp WHERE ROWNUM <= 10")).toBe("SELECT * FROM emp LIMIT 10");
        expect(sql("oracle", "SELECT * FROM emp WHERE dept = 1 AND ROWNUM < 4")).toBe("SELECT * FROM emp WHERE dept = 1 LIMIT 3");
        const ordered = convertQuery({ sql: "SELECT * FROM emp WHERE ROWNUM <= 10 ORDER BY salary DESC", dialect: "oracle" });
        expect(ordered.sql).toBe("SELECT * FROM emp ORDER BY salary DESC LIMIT 10");
        expect(ordered.traps.map((t) => t.id)).toContain("rownum-order-by");
        expect(ordered.traps.find((t) => t.id === "rownum-order-by")?.severity).toBe("changes-results");
    });

    it("refuses ROWNUM where a LIMIT would be applied at the wrong moment", () => {
        for (const text of ["SELECT COUNT(*) FROM emp WHERE ROWNUM <= 3", "SELECT DISTINCT a FROM t WHERE ROWNUM <= 3", "SELECT a, COUNT(*) FROM t WHERE ROWNUM <= 3 GROUP BY a", "SELECT ROW_NUMBER() OVER (ORDER BY a) FROM t WHERE ROWNUM <= 3"]) {
            const result = convertQuery({ sql: text, dialect: "oracle" });
            expect(result.unconverted.length, text).toBeGreaterThan(0);
            expect(result.applied.map((a) => a.id), text).not.toContain("rownum-limit");
        }
    });

    it("converts the three-level ROWNUM paging query", () => {
        const text = "SELECT * FROM (SELECT x.*, ROWNUM rn FROM (SELECT id, name FROM emp ORDER BY id) x WHERE ROWNUM <= 20) WHERE rn > 10";
        expect(sql("oracle", text)).toBe("SELECT id, name FROM emp ORDER BY id LIMIT 10 OFFSET 10");
        expect(sql("oracle", "SELECT * FROM (SELECT x.*, ROWNUM rn FROM (SELECT id FROM emp ORDER BY id) x) WHERE rn BETWEEN 11 AND 20")).toBe("SELECT id FROM emp ORDER BY id LIMIT 10 OFFSET 10");
    });

    it("converts MySQL LIMIT offset, count and removes FROM DUAL", () => {
        expect(sql("mysql", "SELECT id FROM t LIMIT 5, 10")).toBe("SELECT id FROM t LIMIT 10 OFFSET 5");
        expect(sql("oracle", "SELECT SYSDATE FROM DUAL")).toBe("SELECT CURRENT_TIMESTAMP");
        expect(sql("oracle", "SELECT 1 FROM sys.dual")).toBe("SELECT 1");
        expect(sql("db2", "SELECT 1 FROM sysibm.sysdummy1")).toBe("SELECT 1");
    });
});

describe("dates and times", () => {
    it("turns SYSDATE ± days into interval arithmetic, with exact division", () => {
        expect(sql("oracle", "SELECT SYSDATE - 7 FROM DUAL")).toBe("SELECT CURRENT_TIMESTAMP - INTERVAL '7 day'");
        expect(sql("oracle", "SELECT SYSDATE + 1/24 FROM DUAL")).toBe("SELECT CURRENT_TIMESTAMP + (1.0/24) * INTERVAL '1 day'");
    });

    it("converts TRUNC by what is being truncated", () => {
        expect(sql("oracle", "SELECT TRUNC(SYSDATE) FROM DUAL")).toBe("SELECT CURRENT_DATE");
        expect(sql("oracle", "SELECT TRUNC(hired, 'MM') FROM emp")).toBe("SELECT CAST(date_trunc('month', hired) AS date) FROM emp");
        expect(sql("oracle", "SELECT TRUNC(12.345, 1) FROM DUAL")).toBe("SELECT TRUNC(12.345, 1)");
        expect(sql("oracle", "SELECT TRUNC(hired) FROM emp", FIXTURE_SCHEMA)).toBe("SELECT CAST(hired AS date) FROM emp");
        expect(sql("oracle", "SELECT TRUNC(salary) FROM emp", FIXTURE_SCHEMA)).toBe("SELECT TRUNC(salary) FROM emp");
        // without knowing the type, it says so instead of guessing
        expect(convertQuery({ sql: "SELECT TRUNC(x) FROM t", dialect: "oracle" }).unconverted).toHaveLength(1);
    });

    it("uses to_timestamp when TO_DATE has a time part (PostgreSQL's date would drop it)", () => {
        expect(sql("oracle", "SELECT TO_DATE('2020-01-01', 'YYYY-MM-DD') FROM DUAL")).toBe("SELECT TO_DATE('2020-01-01', 'YYYY-MM-DD')");
        expect(sql("oracle", "SELECT TO_DATE('2020-01-01 10:00', 'YYYY-MM-DD HH24:MI') FROM DUAL")).toBe("SELECT to_timestamp('2020-01-01 10:00', 'YYYY-MM-DD HH24:MI')::timestamp");
    });

    it("converts SQL Server date functions exactly", () => {
        expect(sql("mssql", "SELECT DATEADD(day, 7, d) FROM t")).toBe("SELECT (d + INTERVAL '7 day') FROM t");
        expect(sql("mssql", "SELECT DATEADD(quarter, 2, d) FROM t")).toBe("SELECT (d + INTERVAL '6 month') FROM t");
        expect(sql("mssql", "SELECT DATEDIFF(day, a, b) FROM t")).toBe("SELECT (CAST(b AS date) - CAST(a AS date)) FROM t");
        expect(sql("mssql", "SELECT YEAR(d), DATEPART(month, d) FROM t")).toBe("SELECT EXTRACT(YEAR FROM d)::int, EXTRACT(MONTH FROM d)::int FROM t");
        expect(sql("mssql", "SELECT CONVERT(VARCHAR(10), d, 120) FROM t")).toBe("SELECT left(to_char(d, 'YYYY-MM-DD HH24:MI:SS'), 10) FROM t");
        expect(convertQuery({ sql: "SELECT DATEDIFF(week, a, b) FROM t", dialect: "mssql" }).unconverted).toHaveLength(1);
    });

    it("converts MySQL format codes", () => {
        expect(sql("mysql", "SELECT DATE_FORMAT(d, '%Y-%m-%d %H:%i:%s') FROM t")).toBe("SELECT to_char(d, 'YYYY-MM-DD HH24:MI:SS') FROM t");
        expect(sql("mysql", "SELECT DATE_FORMAT(d, 'T%Y') FROM t")).toBe(`SELECT to_char(d, '"T"YYYY') FROM t`);
        expect(convertQuery({ sql: "SELECT DATE_FORMAT(d, '%U') FROM t", dialect: "mysql" }).unconverted).toHaveLength(1);
    });

    it("converts DB2 labeled durations and special registers", () => {
        expect(sql("db2", "SELECT CURRENT DATE + 7 DAYS FROM sysibm.sysdummy1")).toBe("SELECT CURRENT_DATE + INTERVAL '7 day'");
    });
});

describe("strings", () => {
    it("converts + to || only when a text operand is evident", () => {
        expect(sql("mssql", "SELECT a + ' ' + b FROM t")).toBe("SELECT a || ' ' || b FROM t");
        expect(sql("mssql", "SELECT a + b FROM t")).toBe("SELECT a + b FROM t");
        expect(sql("mssql", "SELECT name + email FROM emp", FIXTURE_SCHEMA)).toBe("SELECT name || email FROM emp");
        expect(sql("mssql", "SELECT salary + bonus FROM emp", FIXTURE_SCHEMA)).toBe("SELECT salary + bonus FROM emp");
    });

    it("converts aggregates that join strings", () => {
        expect(sql("oracle", "SELECT LISTAGG(name, ',') WITHIN GROUP (ORDER BY name) FROM t")).toBe("SELECT string_agg(name::text, ',' ORDER BY name) FROM t");
        expect(sql("mysql", "SELECT GROUP_CONCAT(DISTINCT n ORDER BY n SEPARATOR '/') FROM t")).toBe("SELECT string_agg(DISTINCT n::text, '/' ORDER BY n) FROM t");
        expect(sql("mssql", "SELECT STRING_AGG(n, ',') WITHIN GROUP (ORDER BY n) FROM t")).toBe("SELECT string_agg(n::text, ',' ORDER BY n) FROM t");
    });

    it("keeps Oracle's replace-all behaviour of REGEXP_REPLACE", () => {
        expect(sql("oracle", "SELECT REGEXP_REPLACE(a, 'x', 'y') FROM t")).toBe("SELECT regexp_replace(a, 'x', 'y', 'g') FROM t");
    });

    it("casts a number or date given to a text function when it knows the type", () => {
        expect(sql("oracle", "SELECT LPAD(id, 4, '0') FROM emp", FIXTURE_SCHEMA)).toBe("SELECT LPAD(CAST(id AS text), 4, '0') FROM emp");
        expect(sql("oracle", "SELECT LPAD(name, 4, '0') FROM emp", FIXTURE_SCHEMA)).toBe("SELECT LPAD(name, 4, '0') FROM emp");
    });
});

describe("names and quoting", () => {
    it("rewrites [brackets], `backticks` and the dbo schema", () => {
        expect(sql("mssql", "SELECT [Name], [first name] FROM [dbo].[Emp]")).toBe(`SELECT name, "first name" FROM emp`);
        expect(sql("mysql", "SELECT `name` FROM `emp`")).toBe("SELECT name FROM emp");
    });

    it("removes optimizer hints and table hints, and says what NOLOCK meant", () => {
        expect(sql("oracle", "SELECT /*+ FULL(e) */ id FROM emp e")).toBe("SELECT id FROM emp e");
        const result = convertQuery({ sql: "SELECT id FROM emp WITH (NOLOCK) WHERE id = 1 OPTION (RECOMPILE)", dialect: "mssql" });
        expect(result.sql).toBe("SELECT id FROM emp WHERE id = 1");
        expect(result.traps.map((t) => t.id)).toContain("nolock");
    });

    it("gives subqueries in FROM a name", () => {
        expect(sql("oracle", "SELECT COUNT(*) FROM (SELECT id FROM emp)")).toBe("SELECT COUNT(*) FROM (SELECT id FROM emp) AS subquery_1");
    });
});

describe("hierarchical queries", () => {
    it("converts CONNECT BY to a recursive CTE", () => {
        const out = flat(sql("oracle", "SELECT LEVEL, id FROM emp START WITH mgr_id IS NULL CONNECT BY PRIOR id = mgr_id ORDER BY id"));
        expect(out).toBe(
            "WITH RECURSIVE emp_hierarchy AS (SELECT emp.*, 1 AS level FROM emp WHERE mgr_id IS NULL UNION ALL SELECT emp.*, emp_hierarchy.level + 1 FROM emp JOIN emp_hierarchy ON emp_hierarchy.id = emp.mgr_id) SELECT LEVEL, id FROM emp_hierarchy ORDER BY id",
        );
    });

    it("walks upwards when PRIOR is on the child side, and warns about cycles", () => {
        const result = convertQuery({ sql: "SELECT id FROM emp START WITH id = 4 CONNECT BY PRIOR mgr_id = id", dialect: "oracle" });
        expect(flat(result.sql)).toContain("ON emp_hierarchy.mgr_id = emp.id");
        expect(result.traps.map((t) => t.id)).toEqual(expect.arrayContaining(["connect-by-cycles", "connect-by-order"]));
    });

    it("converts the CONNECT BY LEVEL row generator", () => {
        expect(sql("oracle", "SELECT LEVEL FROM DUAL CONNECT BY LEVEL <= 5")).toBe("SELECT LEVEL FROM generate_series(1, 5) AS level");
    });

    it("leaves hierarchies it can't convert, with the reason", () => {
        for (const text of ["SELECT id FROM emp START WITH id = 1 CONNECT BY NOCYCLE PRIOR id = mgr_id", "SELECT e.id FROM emp e, dept d WHERE e.dept_id = d.id START WITH e.mgr_id IS NULL CONNECT BY PRIOR e.id = e.mgr_id", "SELECT SYS_CONNECT_BY_PATH(name, '/') FROM emp START WITH mgr_id IS NULL CONNECT BY PRIOR id = mgr_id"]) {
            expect(convertQuery({ sql: text, dialect: "oracle" }).unconverted.length, text).toBeGreaterThan(0);
        }
    });
});

describe("data changes", () => {
    it("handles DELETE without FROM, MERGE, INSERT IGNORE and ON DUPLICATE KEY", () => {
        expect(sql("oracle", "DELETE emp WHERE id = 1")).toBe("DELETE FROM emp WHERE id = 1");
        expect(sql("oracle", "MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.v = s.v, t.w = 1 WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)")).toBe(
            "MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET v = s.v, w = 1 WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)",
        );
        expect(sql("mysql", "INSERT IGNORE INTO t (id) VALUES (1)")).toBe("INSERT INTO t (id) VALUES (1) ON CONFLICT DO NOTHING");
        expect(sql("mysql", "INSERT INTO dept (id, name) VALUES (1, 'x') ON DUPLICATE KEY UPDATE name = VALUES(name)", FIXTURE_SCHEMA)).toBe("INSERT INTO dept (id, name) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name");
    });

    it("won't guess the conflict columns of ON DUPLICATE KEY", () => {
        const result = convertQuery({ sql: "INSERT INTO t (id, v) VALUES (1, 2) ON DUPLICATE KEY UPDATE v = 2", dialect: "mysql" });
        expect(result.unconverted).toHaveLength(1);
        expect(result.sql).toContain("ON DUPLICATE KEY UPDATE");
    });
});

describe("reporting", () => {
    it("lists what changed, with before and after, and the plain-English reason", () => {
        const result = convertQuery({ sql: "SELECT NVL(a, 0), NVL(b, 1) FROM t", dialect: "oracle" });
        expect(result.applied).toHaveLength(1);
        expect(result.applied[0]).toMatchObject({ id: "nvl", family: "Null handling", count: 2 });
        expect(result.applied[0].examples[0]).toEqual({ before: "NVL(a, 0)", after: "COALESCE(a, 0)" });
        expect(result.applied[0].why.length).toBeGreaterThan(10);
    });

    it("reports bind variables but still lets the query be checked by the database", () => {
        const result = convertQuery({ sql: "SELECT * FROM emp WHERE id = :id AND name = :name", dialect: "oracle" });
        expect(result.parameters).toEqual([":id", ":name"]);
        expect(result.validationSql).toBe("SELECT * FROM emp WHERE id = NULL AND name = NULL");
        expect(result.sql).toContain(":id");
        expect(result.unconverted).toHaveLength(2);
    });

    it("compares table names with the tables it was given", () => {
        expect(convertQuery({ sql: "SELECT * FROM emp e, nope n WHERE e.id = n.id", dialect: "oracle", schema: FIXTURE_SCHEMA }).unknownTables).toEqual(["nope"]);
        expect(convertQuery({ sql: "SELECT * FROM emp e, dept d", dialect: "oracle", schema: FIXTURE_SCHEMA }).unknownTables).toEqual([]);
        expect(convertQuery({ sql: "WITH x AS (SELECT 1) SELECT * FROM x, emp", dialect: "oracle", schema: FIXTURE_SCHEMA }).unknownTables).toEqual([]);
        // with no tables to compare against it has nothing to say
        expect(convertQuery({ sql: "SELECT * FROM nope", dialect: "oracle" }).unknownTables).toEqual([]);
    });

    it("explains traps that change results, ranked first", () => {
        const result = convertQuery({ sql: "SELECT GREATEST(a, b), ADD_MONTHS(d, 1) FROM t ORDER BY a", dialect: "oracle" });
        const severities = result.traps.map((t) => t.severity);
        expect(severities.indexOf("changes-results")).toBeLessThan(severities.length);
        expect(result.traps.every((t) => t.explanation.length > 40)).toBe(true);
    });

    it("leaves statements it doesn't handle as written and says so", () => {
        const result = convertQuery({ sql: "CREATE TABLE x (id NUMBER); SELECT NVL(a, 0) FROM x", dialect: "oracle" });
        expect(result.statements.map((s) => s.handled)).toEqual([false, true]);
        expect(result.statements[0].sql).toBe("CREATE TABLE x (id NUMBER);");
        expect(result.sql).toContain("COALESCE(a, 0)");
    });

    it("returns the original text when it can't even be tokenized", () => {
        const result = convertQuery({ sql: "SELECT 'oops FROM t", dialect: "oracle" });
        expect(result.syntaxError).toMatch(/never closed/);
        expect(result.sql).toBe("SELECT 'oops FROM t");
    });
});

describe("robustness", () => {
    it("never throws on truncated or damaged input", () => {
        const dialects: LegacyDialect[] = ["oracle", "mssql", "mysql", "db2"];
        let seed = 7;
        const random = () => {
            seed = (seed * 1664525 + 1013904223) % 4294967296;
            return seed / 4294967296;
        };
        for (const c of CASES.filter((candidate) => candidate.sql.length < 400)) {
            for (const dialect of dialects) {
                const text = c.sql;
                const damaged = [text.slice(0, Math.floor(random() * text.length)), text.slice(Math.floor(random() * text.length)), text.replace(/[(),']/g, (m) => (random() < 0.3 ? "" : m)), text + " )", "(" + text];
                for (const input of damaged) expect(() => convertQuery({ sql: input, dialect }), input).not.toThrow();
            }
        }
    });

    it("leaves SQL that needs no conversion exactly as it was written", () => {
        for (const c of CASES.filter((candidate) => candidate.family === "No change needed")) {
            expect(convertQuery({ sql: c.sql, dialect: c.from }).sql).toBe(c.sql);
        }
    });

    it("handles empty input", () => {
        expect(convertQuery({ sql: "", dialect: "oracle" }).sql).toBe("");
        expect(convertQuery({ sql: "   \n", dialect: "oracle" }).statements).toEqual([]);
    });
});
