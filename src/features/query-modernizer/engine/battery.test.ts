import { describe, expect, it } from "vitest";
import type { LegacyDialect } from "../types";
import { convertQuery } from "./convert";

/**
 * The 29 legacy queries the old regex converter was evaluated on. It converted 6 correctly and passed 21 along as "93-98%
 * confident" while they were wrong or left unconverted. Each now either converts correctly (the output below was checked
 * on PostgreSQL by the corpus or reviewed by hand) or is reported as not converted. None is silently wrong.
 */
type Row = [name: string, from: LegacyDialect, sql: string, expected: string, extra?: { unconverted?: number; traps?: string[] }];

const BATTERY: Row[] = [
    ["NVL", "oracle", "SELECT NVL(bonus, 0) FROM emp", "SELECT COALESCE(bonus, 0) FROM emp"],
    ["DECODE simple", "oracle", "SELECT DECODE(status, 'A', 'Active', 'I', 'Inactive', 'Unknown') FROM emp", "SELECT CASE status WHEN 'A' THEN 'Active' WHEN 'I' THEN 'Inactive' ELSE 'Unknown' END FROM emp"],
    ["DECODE around NVL (was COALESCE(COALESCE(…)), wrong values)", "oracle", "SELECT DECODE(NVL(status, 'X'), 'A', 'Active', 'Unknown') FROM emp", "SELECT CASE COALESCE(status, 'X') WHEN 'A' THEN 'Active' ELSE 'Unknown' END FROM emp"],
    ["outer join (+) (was an INNER JOIN with a dangling WHERE)", "oracle", "SELECT e.name, d.name FROM emp e, dept d WHERE e.dept_id = d.id(+)", "SELECT e.name, d.name FROM emp e LEFT JOIN dept d ON e.dept_id = d.id"],
    ["SYSDATE FROM DUAL", "oracle", "SELECT SYSDATE FROM DUAL", "SELECT CURRENT_TIMESTAMP"],
    ["ROWNUM limit", "oracle", "SELECT * FROM emp WHERE ROWNUM <= 10", "SELECT * FROM emp LIMIT 10"],
    ["ROWNUM with ORDER BY", "oracle", "SELECT * FROM emp WHERE ROWNUM <= 10 ORDER BY salary DESC", "SELECT * FROM emp ORDER BY salary DESC LIMIT 10", { traps: ["rownum-order-by"] }],
    ["TO_CHAR date", "oracle", "SELECT TO_CHAR(hired, 'YYYY-MM-DD') FROM emp", "SELECT TO_CHAR(hired, 'YYYY-MM-DD') FROM emp"],
    ["ADD_MONTHS", "oracle", "SELECT ADD_MONTHS(hired, 3) FROM emp", "SELECT (hired + INTERVAL '3 months') FROM emp", { traps: ["add-months-month-end"] }],
    ["LISTAGG", "oracle", "SELECT dept_id, LISTAGG(name, ',') WITHIN GROUP (ORDER BY name) FROM emp GROUP BY dept_id", "SELECT dept_id, string_agg(name::text, ',' ORDER BY name) FROM emp GROUP BY dept_id"],
    ["MINUS", "oracle", "SELECT id FROM a MINUS SELECT id FROM b", "SELECT id FROM a EXCEPT SELECT id FROM b"],
    ["sequence NEXTVAL", "oracle", "SELECT emp_seq.NEXTVAL FROM DUAL", "SELECT nextval('emp_seq')"],
    ["TRUNC of an unknown type", "oracle", "SELECT TRUNC(hired) FROM emp", "SELECT TRUNC(hired) FROM emp", { unconverted: 1 }],
    ["ROWNUM paging", "oracle", "SELECT * FROM (SELECT x.*, ROWNUM rn FROM (SELECT * FROM emp ORDER BY id) x WHERE ROWNUM <= 20) WHERE rn > 10", "SELECT * FROM emp ORDER BY id LIMIT 10 OFFSET 10", { traps: ["rownum-pagination-column"] }],
    ["MERGE", "oracle", "MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.v = s.v WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)", "MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET v = s.v WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)", { traps: ["merge-version"] }],
    ["TOP n", "mssql", "SELECT TOP 10 * FROM emp ORDER BY id", "SELECT * FROM emp ORDER BY id LIMIT 10"],
    ["ISNULL / GETDATE", "mssql", "SELECT ISNULL(a, 0), GETDATE() FROM t", "SELECT COALESCE(a, 0), CURRENT_TIMESTAMP FROM t"],
    ["NOLOCK", "mssql", "SELECT * FROM emp WITH (NOLOCK) WHERE id = 1", "SELECT * FROM emp WHERE id = 1", { traps: ["nolock"] }],
    ["CONVERT with a style", "mssql", "SELECT CONVERT(VARCHAR(10), hired, 120) FROM emp", "SELECT left(to_char(hired, 'YYYY-MM-DD HH24:MI:SS'), 10) FROM emp"],
    ["LEN / CHARINDEX", "mssql", "SELECT LEN(name), CHARINDEX('a', name) FROM emp", "SELECT length(rtrim(name)), strpos(name, 'a') FROM emp"],
    ["variable", "mssql", "DECLARE @x INT = 5; SELECT * FROM emp WHERE id = @x", "DECLARE @x INT = 5; SELECT * FROM emp WHERE id = @x", { unconverted: 2 }],
    ["[brackets] and dbo", "mssql", "SELECT [first name] FROM [dbo].[emp]", 'SELECT "first name" FROM emp'],
    ["string + string", "mssql", "SELECT first + ' ' + last FROM emp", "SELECT first || ' ' || last FROM emp"],
    ["backticks and LIMIT x, y", "mysql", "SELECT `name` FROM `emp` LIMIT 5, 10", "SELECT name FROM emp LIMIT 10 OFFSET 5"],
    ["IFNULL / NOW", "mysql", "SELECT IFNULL(a, 0), NOW() FROM t", "SELECT COALESCE(a, 0), NOW() FROM t"],
    ["GROUP_CONCAT", "mysql", "SELECT GROUP_CONCAT(name SEPARATOR ',') FROM t GROUP BY g", "SELECT string_agg(name::text, ',') FROM t GROUP BY g"],
    ["ON DUPLICATE KEY without a known key", "mysql", "INSERT INTO t (id, v) VALUES (1, 2) ON DUPLICATE KEY UPDATE v = 2", "INSERT INTO t (id, v) VALUES (1, 2) ON DUPLICATE KEY UPDATE v = 2", { unconverted: 1 }],
    ["DATE_FORMAT", "mysql", "SELECT DATE_FORMAT(d, '%Y-%m-%d') FROM t", "SELECT to_char(d, 'YYYY-MM-DD') FROM t"],
    ["plain SQL stays as it was", "oracle", "SELECT a, b FROM t WHERE c = 1", "SELECT a, b FROM t WHERE c = 1"],
];

describe("the evaluation battery", () => {
    it.each(BATTERY)("%s", (_name, from, sql, expected, extra) => {
        const result = convertQuery({ sql, dialect: from });
        // the SQL itself, without the NOT CONVERTED header comment lines
        const body = result.sql.split("\n").filter((line) => !line.startsWith("-- NOT CONVERTED")).join(" ").replace(/\s+/g, " ").trim();
        expect(body).toBe(expected);
        expect(result.unconverted).toHaveLength(extra?.unconverted ?? 0);
        for (const trap of extra?.traps ?? []) expect(result.traps.map((t) => t.id)).toContain(trap);
        // anything left as it was is announced at the top of the output
        if (extra?.unconverted) expect(result.sql).toContain("-- NOT CONVERTED");
    });

    it("has all 29 queries", () => {
        expect(BATTERY).toHaveLength(29);
    });
});
