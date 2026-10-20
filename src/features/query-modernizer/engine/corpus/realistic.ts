import type { CorpusCase } from "./cases";

/**
 * Longer queries in the shape that application code and reports actually have: several features per query, joins,
 * grouping, subqueries. Written after the rules, to find what combinations break them.
 */
const oracle = (id: string, sql: string, reference?: string, extra: Partial<CorpusCase> = {}): CorpusCase => ({ id: `oracle-report-${id}`, family: "Realistic Oracle", from: "oracle", sql, reference, ...extra });
const mssql = (id: string, sql: string, reference?: string, extra: Partial<CorpusCase> = {}): CorpusCase => ({ id: `mssql-report-${id}`, family: "Realistic SQL Server", from: "mssql", sql, reference, ...extra });
const mysql = (id: string, sql: string, reference?: string, extra: Partial<CorpusCase> = {}): CorpusCase => ({ id: `mysql-report-${id}`, family: "Realistic MySQL", from: "mysql", sql, reference, ...extra });
const db2 = (id: string, sql: string, reference?: string, extra: Partial<CorpusCase> = {}): CorpusCase => ({ id: `db2-report-${id}`, family: "Realistic DB2", from: "db2", sql, reference, ...extra });

export const REALISTIC: CorpusCase[] = [
    oracle(
        "headcount-by-dept",
        `SELECT d.name AS dept, COUNT(e.id) AS headcount, NVL(SUM(e.salary), 0) AS payroll,
                DECODE(SIGN(NVL(SUM(e.salary), 0) - 10000), 1, 'big', 'small') AS size_class
           FROM dept d, emp e
          WHERE d.id = e.dept_id(+)
          GROUP BY d.name
         HAVING COUNT(e.id) >= 0
          ORDER BY d.name`,
        `SELECT d.name, COUNT(e.id), COALESCE(SUM(e.salary), 0), CASE SIGN(COALESCE(SUM(e.salary), 0) - 10000) WHEN 1 THEN 'big' ELSE 'small' END
           FROM dept d LEFT JOIN emp e ON d.id = e.dept_id GROUP BY d.name HAVING COUNT(e.id) >= 0 ORDER BY d.name`,
    ),
    oracle("top-n", `SELECT * FROM (SELECT name, salary FROM emp ORDER BY salary DESC) WHERE ROWNUM <= 3`, `SELECT name, salary FROM emp ORDER BY salary DESC LIMIT 3`),
    oracle("count-rownum", `SELECT COUNT(*) FROM emp WHERE ROWNUM <= 3`, undefined, { unconverted: true }),
    oracle("distinct-rownum", `SELECT DISTINCT region FROM emp WHERE ROWNUM <= 3`, undefined, { unconverted: true }),
    oracle("rank-window", `SELECT name, RANK() OVER (PARTITION BY dept_id ORDER BY salary DESC) rk FROM emp WHERE dept_id IS NOT NULL ORDER BY dept_id, rk`, `SELECT name, RANK() OVER (PARTITION BY dept_id ORDER BY salary DESC) FROM emp WHERE dept_id IS NOT NULL ORDER BY dept_id, 2`),
    oracle("keep-dense-rank", `SELECT dept_id, MAX(name) KEEP (DENSE_RANK FIRST ORDER BY hired) FROM emp GROUP BY dept_id`, undefined, { unconverted: true }),
    oracle("lpad-number", `SELECT LPAD(id, 4, '0') FROM emp ORDER BY id`, `SELECT LPAD(id::text, 4, '0') FROM emp ORDER BY id`, { schema: true }),
    oracle("add-months-filter", `SELECT id FROM emp WHERE hired >= ADD_MONTHS(TO_DATE('2021-12-31', 'YYYY-MM-DD'), -36) ORDER BY id`, `SELECT id FROM emp WHERE hired >= DATE '2018-12-31' ORDER BY id`, { trap: "add-months-month-end" }),
    oracle("sum-decode", `SELECT dept_id, SUM(DECODE(status, 'A', 1, 0)) AS active FROM emp WHERE dept_id IS NOT NULL GROUP BY dept_id ORDER BY dept_id`, `SELECT dept_id, COUNT(*) FILTER (WHERE status = 'A') FROM emp WHERE dept_id IS NOT NULL GROUP BY dept_id ORDER BY dept_id`),
    oracle("row-number-wrapper", `SELECT * FROM (SELECT e.id, ROW_NUMBER() OVER (ORDER BY salary DESC) rn FROM emp e) WHERE rn <= 2`, `SELECT id, rn FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY salary DESC) rn FROM emp) q WHERE rn <= 2`),
    oracle("with-dual", `WITH t AS (SELECT 1 AS n FROM DUAL UNION ALL SELECT 2 FROM DUAL) SELECT SUM(n) FROM t`, `SELECT 3`),
    oracle("order-by-nvl", `SELECT name FROM emp ORDER BY NVL(bonus, 0) DESC, id`, `SELECT name FROM emp ORDER BY COALESCE(bonus, 0) DESC, id`),
    oracle("correlated-subquery", `SELECT e.name, (SELECT COUNT(*) FROM benefit b WHERE b.emp_id = e.id) AS plans FROM emp e ORDER BY e.id`, `SELECT e.name, (SELECT COUNT(*) FROM benefit b WHERE b.emp_id = e.id) FROM emp e ORDER BY e.id`),
    oracle("anti-join", `SELECT d.name FROM dept d, emp e WHERE d.id = e.dept_id(+) AND e.id IS NULL ORDER BY d.id`, `SELECT d.name FROM dept d LEFT JOIN emp e ON d.id = e.dept_id WHERE e.id IS NULL ORDER BY d.id`),
    oracle("outer-join-aggregate", `SELECT d.name, NVL(SUM(o.total), 0) FROM dept d, emp e, ord o WHERE d.id = e.dept_id(+) AND e.id = o.emp_id(+) GROUP BY d.name ORDER BY d.name`, `SELECT d.name, COALESCE(SUM(o.total), 0) FROM dept d LEFT JOIN emp e ON d.id = e.dept_id LEFT JOIN ord o ON e.id = o.emp_id GROUP BY d.name ORDER BY d.name`),
    oracle("case-with-concat", `SELECT CASE WHEN bonus IS NULL THEN name || ' (no bonus)' ELSE name || ' (' || TO_CHAR(bonus, 'FM999.00') || ')' END FROM emp ORDER BY id`, `SELECT CASE WHEN bonus IS NULL THEN name || ' (no bonus)' ELSE name || ' (' || to_char(bonus, 'FM999.00') || ')' END FROM emp ORDER BY id`, { traps: ["oracle-concat-null"] }),
    oracle("insert-values", `INSERT INTO emp (id, name, salary, hired) VALUES (7, 'Gus', 1000, TO_DATE('2023-01-01', 'YYYY-MM-DD'))`, `INSERT INTO emp (id, name, salary, hired) VALUES (7, 'Gus', 1000, DATE '2023-01-01')`, { verify: "SELECT id, name, salary, hired FROM emp ORDER BY id" }),
    oracle("update-subquery", `UPDATE emp e SET salary = (SELECT NVL(MAX(o.total), 0) FROM ord o WHERE o.emp_id = e.id) WHERE e.dept_id = 1`, `UPDATE emp e SET salary = (SELECT COALESCE(MAX(o.total), 0) FROM ord o WHERE o.emp_id = e.id) WHERE e.dept_id = 1`, { verify: "SELECT id, salary FROM emp ORDER BY id" }),
    oracle("hierarchy-with-where", `SELECT LEVEL AS depth, name FROM emp WHERE status = 'A' START WITH mgr_id IS NULL CONNECT BY PRIOR id = mgr_id ORDER BY LEVEL, name`, `SELECT 1, 'Alice' UNION ALL SELECT 2, 'Bob' UNION ALL SELECT 2, 'Frank' ORDER BY 1, 2`),
    oracle("trunc-sysdate-compare", `SELECT id FROM emp WHERE hired < TRUNC(SYSDATE) ORDER BY id`, `SELECT id FROM emp ORDER BY id`),
    oracle("trunc-minus-days", `SELECT id FROM emp WHERE hired < TRUNC(SYSDATE) - 7 ORDER BY id`, `SELECT id FROM emp ORDER BY id`),
    oracle("date-series", `SELECT TRUNC(DATE '2020-01-01') + LEVEL - 1 AS d FROM DUAL CONNECT BY LEVEL <= 3`, `SELECT DATE '2020-01-01' + g - 1 FROM generate_series(1, 3) g`),
    oracle("nvl-dates", `SELECT id, NVL(TO_CHAR(hired, 'YYYY'), 'n/a') FROM emp ORDER BY id`, `SELECT id, COALESCE(to_char(hired, 'YYYY'), 'n/a') FROM emp ORDER BY id`),
    oracle("not-in", `SELECT id FROM dept WHERE id NOT IN (SELECT dept_id FROM emp WHERE dept_id IS NOT NULL) ORDER BY id`, `SELECT id FROM dept WHERE id NOT IN (SELECT dept_id FROM emp WHERE dept_id IS NOT NULL) ORDER BY id`),
    oracle("minus-with-nvl", `SELECT NVL(dept_id, 0) FROM emp MINUS SELECT id FROM dept`, `SELECT COALESCE(dept_id, 0) FROM emp EXCEPT SELECT id FROM dept`),
    oracle("decode-in-join", `SELECT e.name, d.name FROM emp e, dept d WHERE e.dept_id = d.id AND DECODE(e.status, 'A', 1, 0) = 1 ORDER BY e.id`, `SELECT e.name, d.name FROM emp e JOIN dept d ON e.dept_id = d.id WHERE e.status = 'A' ORDER BY e.id`),
    oracle("rownum-and-order", `SELECT id FROM (SELECT id FROM emp ORDER BY salary DESC) WHERE ROWNUM = 1`, `SELECT id FROM emp ORDER BY salary DESC LIMIT 1`),
    oracle("exists-with-outer-join", `SELECT name FROM emp e WHERE EXISTS (SELECT 1 FROM dept d, benefit b WHERE d.id = b.emp_id(+) AND d.id = e.dept_id) ORDER BY id`, `SELECT name FROM emp e WHERE EXISTS (SELECT 1 FROM dept d LEFT JOIN benefit b ON d.id = b.emp_id WHERE d.id = e.dept_id) ORDER BY id`),
    oracle("union-all-dual", `SELECT 1 FROM DUAL UNION ALL SELECT 2 FROM DUAL`, `SELECT 1 UNION ALL SELECT 2`),
    oracle("lowercase-compact", `select nvl(bonus,0) from emp where rownum<=2`, `SELECT COALESCE(bonus, 0) FROM emp LIMIT 2`),
    oracle("compact-outer-join", `select e.name from emp e,dept d where e.dept_id=d.id(+) order by e.id`, `SELECT e.name FROM emp e LEFT JOIN dept d ON e.dept_id = d.id ORDER BY e.id`),
    oracle("for-update", `SELECT id FROM emp WHERE ROWNUM <= 1 FOR UPDATE`, `SELECT id FROM emp LIMIT 1 FOR UPDATE`),
    oracle("keywords-in-strings-and-comments", `SELECT 'NVL(x) FROM DUAL (+) ROWNUM' AS s, NVL(bonus, 0) /* (+) ROWNUM DECODE( */ FROM emp WHERE id = 1 -- DECODE(`, `SELECT 'NVL(x) FROM DUAL (+) ROWNUM', COALESCE(bonus, 0) FROM emp WHERE id = 1`),
    oracle("quoted-upper-case-names", `SELECT "NAME", e."ID" FROM "EMP" e WHERE e."ID" = 1`, `SELECT name, e.id FROM emp e WHERE e.id = 1`),
    oracle("decode-number-vs-string", `SELECT DECODE(id, '1', 'one', 'other') FROM emp ORDER BY id`, `SELECT CASE id WHEN '1' THEN 'one' ELSE 'other' END FROM emp ORDER BY id`),
    oracle("top-level-variable-rownum", `SELECT MOD(ROWNUM, 2) FROM emp`, undefined, { unconverted: true }),
    oracle("nested-case-decode", `SELECT id, CASE WHEN NVL(bonus, 0) > 0 THEN DECODE(status, 'A', 'x', 'y') ELSE 'z' END FROM emp ORDER BY id`, `SELECT id, CASE WHEN COALESCE(bonus, 0) > 0 THEN CASE status WHEN 'A' THEN 'x' ELSE 'y' END ELSE 'z' END FROM emp ORDER BY id`),
    oracle("concat-decode-empty", `SELECT name || DECODE(status, 'A', '*', '') FROM emp ORDER BY id`, `SELECT name || CASE status WHEN 'A' THEN '*' ELSE '' END FROM emp ORDER BY id`, { traps: ["oracle-empty-string", "oracle-concat-null"] }),
    oracle("nested-subquery-rownum", `SELECT name FROM emp WHERE salary = (SELECT MAX(salary) FROM (SELECT salary FROM emp WHERE ROWNUM <= 4))`, `SELECT name FROM emp WHERE salary = 9000`),

    mssql(
        "dept-summary",
        `SELECT TOP 5 d.[name] AS dept, COUNT(*) AS cnt, ISNULL(AVG(e.[salary]), 0) AS avg_sal
           FROM [dbo].[dept] d
          INNER JOIN [dbo].[emp] e WITH (NOLOCK) ON e.[dept_id] = d.[id]
          GROUP BY d.[name]
          ORDER BY cnt DESC, d.[name]`,
        `SELECT d.name, COUNT(*), COALESCE(AVG(e.salary), 0) FROM dept d JOIN emp e ON e.dept_id = d.id GROUP BY d.name ORDER BY 2 DESC, d.name LIMIT 5`,
        { traps: ["nolock"] },
    ),
    mssql("recent-hires", `SELECT e.id, CONVERT(VARCHAR(10), e.hired, 120) AS hired_on FROM emp e WHERE e.hired > DATEADD(year, -3, CAST('2024-01-01' AS DATETIME)) ORDER BY e.id`, `SELECT id, to_char(hired, 'YYYY-MM-DD') FROM emp WHERE hired > TIMESTAMP '2021-01-01 00:00:00' ORDER BY id`),
    mssql("concat-isnull", `SELECT ISNULL(name, '') + ' ' + ISNULL(email, '') FROM emp ORDER BY id`, `SELECT COALESCE(name, '') || ' ' || COALESCE(email, '') FROM emp ORDER BY id`),
    mssql("year-group", `SELECT YEAR(hired) AS y, COUNT(*) AS c FROM emp GROUP BY YEAR(hired) ORDER BY y`, `SELECT EXTRACT(YEAR FROM hired)::int, COUNT(*) FROM emp GROUP BY EXTRACT(YEAR FROM hired) ORDER BY 1`),
    mssql("offset-fetch", `SELECT id FROM emp ORDER BY id OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY`, `SELECT id FROM emp ORDER BY id OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY`),
    mssql("leading-semicolon-cte", `;WITH hi AS (SELECT id, salary FROM emp WHERE salary > 6000) SELECT id FROM hi ORDER BY id`, `SELECT id FROM emp WHERE salary > 6000 ORDER BY id`),
    mssql("iif-sum", `SELECT SUM(IIF(status = 'A', 1, 0)) FROM emp`, `SELECT COUNT(*) FILTER (WHERE status = 'A') FROM emp`),
    mssql("top-with-join-hint", `SELECT TOP 3 e.id FROM emp e WITH (NOLOCK) LEFT JOIN dept d WITH (NOLOCK) ON d.id = e.dept_id ORDER BY e.id`, `SELECT e.id FROM emp e LEFT JOIN dept d ON d.id = e.dept_id ORDER BY e.id LIMIT 3`, { trap: "nolock" }),
    mssql("subquery-top-order", `SELECT d.id, (SELECT TOP 1 e.name FROM emp e WHERE e.dept_id = d.id ORDER BY e.salary DESC) AS top_earner FROM dept d ORDER BY d.id`, `SELECT d.id, (SELECT e.name FROM emp e WHERE e.dept_id = d.id ORDER BY e.salary DESC LIMIT 1) FROM dept d ORDER BY d.id`),
    mssql("case-len", `SELECT name, CASE WHEN LEN(name) > 4 THEN 'long' ELSE 'short' END FROM emp ORDER BY id`, `SELECT name, CASE WHEN length(rtrim(name)) > 4 THEN 'long' ELSE 'short' END FROM emp ORDER BY id`),
    mssql("top-variable", `SELECT TOP (@n) id FROM emp`, undefined, { unconverted: true }),
    mssql("select-into", `SELECT id, name INTO #tmp FROM emp`, undefined, { unconverted: true }),

    mysql(
        "dept-people",
        `SELECT d.name, GROUP_CONCAT(e.name ORDER BY e.salary DESC SEPARATOR ', ') AS people, IFNULL(SUM(e.bonus), 0) AS bonus
           FROM dept d LEFT JOIN emp e ON e.dept_id = d.id
          GROUP BY d.name
          ORDER BY d.name`,
        `SELECT d.name, string_agg(e.name, ', ' ORDER BY e.salary DESC), COALESCE(SUM(e.bonus), 0) FROM dept d LEFT JOIN emp e ON e.dept_id = d.id GROUP BY d.name ORDER BY d.name`,
    ),
    mysql("flags", `SELECT id, IF(bonus IS NULL, 'n', 'y'), DATE_FORMAT(hired, '%Y') FROM emp ORDER BY id`, `SELECT id, CASE WHEN bonus IS NULL THEN 'n' ELSE 'y' END, to_char(hired, 'YYYY') FROM emp ORDER BY id`),
    mysql("page", `SELECT id FROM emp ORDER BY id LIMIT 1, 2`, `SELECT id FROM emp ORDER BY id LIMIT 2 OFFSET 1`),
    mysql("concat-ws", `SELECT CONCAT_WS('-', name, region) FROM emp ORDER BY id`, `SELECT concat_ws('-', name, region) FROM emp ORDER BY id`),
    mysql("find-in-set", `SELECT id FROM emp WHERE FIND_IN_SET(region, 'EU,US')`, undefined, { unconverted: true }),
    mysql("timestampdiff-day", `SELECT id, TIMESTAMPDIFF(DAY, hired, '2024-01-01') FROM emp ORDER BY id`, `SELECT id, DATE '2024-01-01' - hired FROM emp ORDER BY id`),
    mysql("timestampdiff-month", `SELECT id, TIMESTAMPDIFF(MONTH, hired, '2024-01-01') FROM emp ORDER BY id`, `SELECT id, (EXTRACT(YEAR FROM age(DATE '2024-01-01', hired)) * 12 + EXTRACT(MONTH FROM age(DATE '2024-01-01', hired)))::bigint FROM emp ORDER BY id`),
    mysql("timestampadd", `SELECT id, TIMESTAMPADD(DAY, 5, hired) FROM emp ORDER BY id`, `SELECT id, hired + INTERVAL '5 day' FROM emp ORDER BY id`),
    mysql("ifnull-sum-group", `SELECT region, IFNULL(SUM(salary), 0) FROM emp GROUP BY region ORDER BY region`, `SELECT region, COALESCE(SUM(salary), 0) FROM emp GROUP BY region ORDER BY region`, { traps: ["null-order"] }),
    mysql("backtick-join", "SELECT e.`name`, d.`name` FROM `emp` e JOIN `dept` d ON d.`id` = e.`dept_id` WHERE e.`id` <= 2 ORDER BY e.`id`", `SELECT e.name, d.name FROM emp e JOIN dept d ON d.id = e.dept_id WHERE e.id <= 2 ORDER BY e.id`),
    mysql("update-ifnull", `UPDATE emp SET bonus = IFNULL(bonus, 0) + 1 WHERE dept_id = 1`, `UPDATE emp SET bonus = COALESCE(bonus, 0) + 1 WHERE dept_id = 1`, { verify: "SELECT id, bonus FROM emp ORDER BY id" }),
    mysql("delete-limit", `DELETE FROM emp WHERE bonus IS NULL LIMIT 1`, undefined, { unconverted: true }),

    db2("fetch-first", `SELECT id, VALUE(bonus, 0) FROM emp ORDER BY id FETCH FIRST 3 ROWS ONLY`, `SELECT id, COALESCE(bonus, 0) FROM emp ORDER BY id LIMIT 3`),
    db2("isolation", `SELECT id FROM emp WHERE dept_id = 1 ORDER BY id WITH UR`, `SELECT id FROM emp WHERE dept_id = 1 ORDER BY id`),
    db2("read-only", `SELECT id FROM emp ORDER BY id FOR READ ONLY`, `SELECT id FROM emp ORDER BY id`),
    db2("labeled-duration", `SELECT id, hired + 7 DAYS FROM emp ORDER BY id`, `SELECT id, hired + INTERVAL '7 day' FROM emp ORDER BY id`),
    db2("current-date-duration", `SELECT CASE WHEN CURRENT DATE + 1 DAY > CURRENT DATE THEN 1 ELSE 0 END FROM SYSIBM.SYSDUMMY1`, `SELECT 1`),
];
