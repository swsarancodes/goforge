import type { LegacyDialect } from "../../types";

/**
 * Legacy queries with the answer the legacy database gives on the fixture data (fixture.ts).
 *
 * The answer is a PostgreSQL `reference` query that encodes that legacy behaviour in the plainest way. The corpus
 * converts `sql`, runs the result on PostgreSQL, and compares the rows with the reference's rows.
 */
export interface CorpusCase {
    id: string;
    family: string;
    from: LegacyDialect;
    sql: string;
    /** PostgreSQL that returns what the legacy database returns. */
    reference?: string;
    /** Statements run first (inside a transaction that is rolled back). */
    setup?: string[];
    /** For data changes: a query that reads the result of the statement. */
    verify?: string;
    /** Compare rows in order. Defaults to true when the query has an ORDER BY. */
    ordered?: boolean;
    /** Give the engine the fixture's tables, columns and types. */
    schema?: boolean;
    /** The result may legitimately differ from the legacy database; the engine must report this trap. `reference` is then what PostgreSQL returns once the trap is understood. */
    trap?: string;
    /** The engine must report that it did not convert something. */
    unconverted?: true;
    /** Must be reported by the engine in addition to the checks above. */
    traps?: string[];
}

const make = (family: string, from: LegacyDialect) => {
    return (id: string, sql: string, reference?: string, extra: Partial<CorpusCase> = {}): CorpusCase => ({ id: `${family.toLowerCase().replace(/[^a-z]+/g, "-")}-${id}`, family, from, sql, reference, ...extra });
};

const nullFam = "Null handling";
const orNull = make(nullFam, "oracle");
const msNull = make(nullFam, "mssql");
const myNull = make(nullFam, "mysql");
const dbNull = make(nullFam, "db2");

const nullHandling: CorpusCase[] = [
    orNull("nvl-1", "SELECT id, NVL(bonus, 0) FROM emp ORDER BY id", "SELECT id, COALESCE(bonus, 0) FROM emp ORDER BY id"),
    orNull("nvl-2", "SELECT name, NVL(region, 'none') FROM emp ORDER BY id", "SELECT name, COALESCE(region, 'none') FROM emp ORDER BY id"),
    orNull("nvl-3", "SELECT NVL(NVL(bonus, salary), 0) FROM emp ORDER BY id", "SELECT COALESCE(bonus, salary, 0) FROM emp ORDER BY id"),
    orNull("nvl-4", "SELECT id FROM emp WHERE NVL(bonus, 0) > 100 ORDER BY id", "SELECT id FROM emp WHERE COALESCE(bonus, 0) > 100 ORDER BY id"),
    orNull("nvl-5", "SELECT SUM(NVL(bonus, 0)) FROM emp", "SELECT SUM(COALESCE(bonus, 0)) FROM emp"),
    orNull("nvl-6", "SELECT id, NVL(email, 'unknown@x.com') FROM emp ORDER BY id", "SELECT id, COALESCE(email, 'unknown@x.com') FROM emp ORDER BY id"),
    orNull("nvl2-1", "SELECT id, NVL2(bonus, 'yes', 'no') FROM emp ORDER BY id", "SELECT id, CASE WHEN bonus IS NOT NULL THEN 'yes' ELSE 'no' END FROM emp ORDER BY id"),
    orNull("nvl2-2", "SELECT id, NVL2(bonus, salary + bonus, salary) FROM emp ORDER BY id", "SELECT id, CASE WHEN bonus IS NOT NULL THEN salary + bonus ELSE salary END FROM emp ORDER BY id"),
    msNull("isnull-1", "SELECT id, ISNULL(bonus, 0) FROM emp ORDER BY id", "SELECT id, COALESCE(bonus, 0) FROM emp ORDER BY id"),
    msNull("isnull-2", "SELECT id FROM emp WHERE ISNULL(region, 'EU') = 'EU' ORDER BY id", "SELECT id FROM emp WHERE COALESCE(region, 'EU') = 'EU' ORDER BY id"),
    msNull("isnull-3", "SELECT name, ISNULL(email, '') FROM emp ORDER BY id", "SELECT name, COALESCE(email, '') FROM emp ORDER BY id"),
    myNull("ifnull-1", "SELECT id, IFNULL(region, 'n/a') FROM emp ORDER BY id", "SELECT id, COALESCE(region, 'n/a') FROM emp ORDER BY id"),
    myNull("ifnull-2", "SELECT id FROM emp WHERE IFNULL(bonus, 0) = 0 ORDER BY id", "SELECT id FROM emp WHERE COALESCE(bonus, 0) = 0 ORDER BY id"),
    dbNull("value-1", "SELECT id, VALUE(bonus, -1) FROM emp ORDER BY id", "SELECT id, COALESCE(bonus, -1) FROM emp ORDER BY id"),
    myNull("nullsafe-1", "SELECT id FROM emp WHERE region <=> NULL ORDER BY id", "SELECT id FROM emp WHERE region IS NULL ORDER BY id"),
    myNull("nullsafe-2", "SELECT a.id, b.id FROM emp a JOIN emp b ON a.region <=> b.region AND a.id < b.id ORDER BY 1, 2", "SELECT a.id, b.id FROM emp a JOIN emp b ON a.region IS NOT DISTINCT FROM b.region AND a.id < b.id ORDER BY 1, 2"),
    myNull("nullsafe-3", "SELECT id FROM emp WHERE region <=> 'EU' ORDER BY id", "SELECT id FROM emp WHERE region = 'EU' ORDER BY id"),
];

const orCond = make("Conditionals", "oracle");
const msCond = make("Conditionals", "mssql");
const myCond = make("Conditionals", "mysql");
const dbCond = make("Conditionals", "db2");

const conditionals: CorpusCase[] = [
    orCond("decode-1", "SELECT id, DECODE(status, 'A', 'Active', 'L', 'Leave', 'T', 'Terminated', 'Unknown') FROM emp ORDER BY id", "SELECT id, CASE WHEN status = 'A' THEN 'Active' WHEN status = 'L' THEN 'Leave' WHEN status = 'T' THEN 'Terminated' ELSE 'Unknown' END FROM emp ORDER BY id"),
    orCond("decode-2-nested-nvl", "SELECT id, DECODE(NVL(status, 'X'), 'A', 'Active', 'X', 'Missing', 'Other') FROM emp ORDER BY id", "SELECT id, CASE COALESCE(status, 'X') WHEN 'A' THEN 'Active' WHEN 'X' THEN 'Missing' ELSE 'Other' END FROM emp ORDER BY id"),
    orCond("decode-3-null-search", "SELECT id, DECODE(region, NULL, 'no region', region) FROM emp ORDER BY id", "SELECT id, CASE WHEN region IS NULL THEN 'no region' ELSE region END FROM emp ORDER BY id"),
    orCond("decode-4-columns", "SELECT a.id, b.id, DECODE(a.dept_id, b.dept_id, 'same', 'diff') FROM emp a, emp b WHERE a.id < b.id AND a.id <= 3 ORDER BY 1, 2", "SELECT a.id, b.id, CASE WHEN a.dept_id IS NOT DISTINCT FROM b.dept_id THEN 'same' ELSE 'diff' END FROM emp a, emp b WHERE a.id < b.id AND a.id <= 3 ORDER BY 1, 2"),
    orCond("decode-5-no-default", "SELECT id, DECODE(status, 'A', 1, 'L', 2) FROM emp ORDER BY id", "SELECT id, CASE status WHEN 'A' THEN 1 WHEN 'L' THEN 2 END FROM emp ORDER BY id"),
    orCond("decode-6-numbers", "SELECT id, DECODE(dept_id, 1, 'eng', 2, 'sales', 'other') FROM emp ORDER BY id", "SELECT id, CASE dept_id WHEN 1 THEN 'eng' WHEN 2 THEN 'sales' ELSE 'other' END FROM emp ORDER BY id"),
    orCond("decode-7-where", "SELECT id FROM emp WHERE DECODE(status, 'A', 1, 0) = 1 ORDER BY id", "SELECT id FROM emp WHERE status = 'A' ORDER BY id"),
    orCond("decode-8-in-order-by", "SELECT id FROM emp ORDER BY DECODE(status, 'A', 1, 'L', 2, 3), id", "SELECT id FROM emp ORDER BY CASE status WHEN 'A' THEN 1 WHEN 'L' THEN 2 ELSE 3 END, id"),
    orCond("decode-9-nested-decode", "SELECT id, DECODE(DECODE(dept_id, 1, 'x', 'y'), 'x', 'first', 'second') FROM emp ORDER BY id", "SELECT id, CASE WHEN dept_id = 1 THEN 'first' ELSE 'second' END FROM emp ORDER BY id"),
    orCond("decode-10-expression-subject", "SELECT id, DECODE(SIGN(salary - 6000), 1, 'high', 0, 'mid', 'low') FROM emp ORDER BY id", "SELECT id, CASE SIGN(salary - 6000) WHEN 1 THEN 'high' WHEN 0 THEN 'mid' ELSE 'low' END FROM emp ORDER BY id"),
    dbCond("decode-11", "SELECT id, DECODE(dept_id, 1, 'eng', 'other') FROM emp ORDER BY id", "SELECT id, CASE dept_id WHEN 1 THEN 'eng' ELSE 'other' END FROM emp ORDER BY id"),
    msCond("iif-1", "SELECT id, IIF(salary > 6500, 'high', 'low') FROM emp ORDER BY id", "SELECT id, CASE WHEN salary > 6500 THEN 'high' ELSE 'low' END FROM emp ORDER BY id"),
    msCond("iif-2", "SELECT id, IIF(bonus IS NULL, 0, bonus) FROM emp ORDER BY id", "SELECT id, COALESCE(bonus, 0) FROM emp ORDER BY id"),
    msCond("iif-3-nested", "SELECT id, IIF(salary > 8000, 'a', IIF(salary > 5000, 'b', 'c')) FROM emp ORDER BY id", "SELECT id, CASE WHEN salary > 8000 THEN 'a' WHEN salary > 5000 THEN 'b' ELSE 'c' END FROM emp ORDER BY id"),
    myCond("if-1", "SELECT id, IF(salary > 6500, 'high', 'low') FROM emp ORDER BY id", "SELECT id, CASE WHEN salary > 6500 THEN 'high' ELSE 'low' END FROM emp ORDER BY id"),
    myCond("if-2-aggregate", "SELECT SUM(IF(region = 'EU', 1, 0)) FROM emp", "SELECT COUNT(*) FILTER (WHERE region = 'EU') FROM emp"),
    myCond("if-3-nested", "SELECT id, IF(dept_id = 1, 'e', IF(dept_id = 2, 's', 'o')) FROM emp ORDER BY id", "SELECT id, CASE WHEN dept_id = 1 THEN 'e' WHEN dept_id = 2 THEN 's' ELSE 'o' END FROM emp ORDER BY id"),
];

const orDate = make("Dates and times", "oracle");
const msDate = make("Dates and times", "mssql");
const myDate = make("Dates and times", "mysql");
const dbDate = make("Dates and times", "db2");

const dates: CorpusCase[] = [
    orDate("sysdate-1", "SELECT CASE WHEN SYSDATE > DATE '2000-01-01' THEN 1 ELSE 0 END FROM DUAL", "SELECT 1"),
    orDate("sysdate-2", "SELECT id FROM emp WHERE hired < SYSDATE ORDER BY id", "SELECT id FROM emp ORDER BY id"),
    orDate("sysdate-3-minus-days", "SELECT CASE WHEN SYSDATE - 1 < SYSDATE THEN 'y' ELSE 'n' END FROM DUAL", "SELECT 'y'"),
    orDate("sysdate-4-plus-fraction", "SELECT CASE WHEN SYSDATE + 1/24 > SYSDATE THEN 'y' ELSE 'n' END FROM DUAL", "SELECT 'y'"),
    orDate("sysdate-5-column-compare", "SELECT id FROM emp WHERE hired > SYSDATE - 36500 ORDER BY id", "SELECT id FROM emp WHERE hired > CURRENT_TIMESTAMP - INTERVAL '36500 day' ORDER BY id"),
    orDate("sysdate-6-systimestamp", "SELECT CASE WHEN SYSTIMESTAMP > DATE '2000-01-01' THEN 1 ELSE 0 END FROM DUAL", "SELECT 1"),
    orDate("add-months-1", "SELECT id, ADD_MONTHS(hired, 2) FROM emp ORDER BY id", "SELECT id, hired + INTERVAL '2 months' FROM emp ORDER BY id", { trap: "add-months-month-end" }),
    orDate("add-months-2", "SELECT ADD_MONTHS(DATE '2020-01-31', 1) FROM DUAL", "SELECT DATE '2020-01-31' + INTERVAL '1 month'", { trap: "add-months-month-end" }),
    orDate("add-months-3-month-end", "SELECT ADD_MONTHS(DATE '2021-02-28', 1) FROM DUAL", "SELECT DATE '2021-02-28' + INTERVAL '1 month'", { trap: "add-months-month-end" }),
    orDate("add-months-4-negative", "SELECT id, ADD_MONTHS(hired, -12) FROM emp ORDER BY id", "SELECT id, hired - INTERVAL '12 months' FROM emp ORDER BY id", { trap: "add-months-month-end" }),
    orDate("last-day-1", "SELECT id, LAST_DAY(hired) FROM emp ORDER BY id", "SELECT id, (date_trunc('month', hired) + INTERVAL '1 month')::date - 1 FROM emp ORDER BY id"),
    orDate("trunc-1-month", "SELECT id, TRUNC(hired, 'MM') FROM emp ORDER BY id", "SELECT id, date_trunc('month', hired)::date FROM emp ORDER BY id"),
    orDate("trunc-2-year", "SELECT id, TRUNC(hired, 'YYYY') FROM emp ORDER BY id", "SELECT id, date_trunc('year', hired)::date FROM emp ORDER BY id"),
    orDate("trunc-3-number", "SELECT TRUNC(123.456, 1) FROM DUAL", "SELECT trunc(123.456, 1)"),
    orDate("trunc-4-to-date", "SELECT TRUNC(TO_DATE('2020-05-17 13:00', 'YYYY-MM-DD HH24:MI')) FROM DUAL", "SELECT DATE '2020-05-17'"),
    orDate("trunc-5-sysdate", "SELECT CASE WHEN TRUNC(SYSDATE) <= SYSDATE THEN 1 ELSE 0 END FROM DUAL", "SELECT 1"),
    orDate("trunc-6-schema-date", "SELECT id, TRUNC(hired) FROM emp ORDER BY id", "SELECT id, hired FROM emp ORDER BY id", { schema: true }),
    orDate("trunc-7-schema-number", "SELECT id, TRUNC(salary) FROM emp ORDER BY id", "SELECT id, trunc(salary) FROM emp ORDER BY id", { schema: true }),
    orDate("trunc-8-unknown-type", "SELECT TRUNC(hired) FROM emp", undefined, { unconverted: true }),
    orDate("to-date-1", "SELECT TO_DATE('2020-01-15', 'YYYY-MM-DD') FROM DUAL", "SELECT to_date('2020-01-15', 'YYYY-MM-DD')"),
    orDate("to-date-2-time", "SELECT TO_DATE('2020-01-15 10:30', 'YYYY-MM-DD HH24:MI') FROM DUAL", "SELECT to_timestamp('2020-01-15 10:30', 'YYYY-MM-DD HH24:MI')::timestamp"),
    orDate("to-date-3-no-format", "SELECT TO_DATE('15-JAN-2020') FROM DUAL", undefined, { unconverted: true }),
    orDate("to-date-4-rr", "SELECT TO_DATE('15-JAN-20', 'DD-MON-RR') FROM DUAL", undefined, { unconverted: true }),
    orDate("to-char-1", "SELECT TO_CHAR(hired, 'YYYY-MM-DD') FROM emp ORDER BY id", "SELECT to_char(hired, 'YYYY-MM-DD') FROM emp ORDER BY id"),
    orDate("to-char-2-number", "SELECT TO_CHAR(salary, '99999.99') FROM emp ORDER BY id", "SELECT to_char(salary, '99999.99') FROM emp ORDER BY id"),
    orDate("to-char-3-time", "SELECT TO_CHAR(hired, 'DD/MM/YYYY HH24:MI:SS') FROM emp ORDER BY id", "SELECT to_char(hired, 'DD/MM/YYYY HH24:MI:SS') FROM emp ORDER BY id"),
    orDate("to-char-4-single-arg", "SELECT TO_CHAR(id) FROM emp ORDER BY id", "SELECT id::text FROM emp ORDER BY id"),
    orDate("to-number-1", "SELECT TO_NUMBER('42') + 1 FROM DUAL", "SELECT 42 + 1"),
    orDate("to-number-2-format", "SELECT TO_NUMBER('1,234.50', '9,999.99') FROM DUAL", "SELECT to_number('1,234.50', '9,999.99')"),
    msDate("getdate-1", "SELECT CASE WHEN GETDATE() > '2000-01-01' THEN 1 ELSE 0 END", "SELECT 1"),
    msDate("getdate-2", "SELECT id FROM emp WHERE hired < GETDATE() ORDER BY id", "SELECT id FROM emp ORDER BY id"),
    msDate("getutcdate", "SELECT CASE WHEN GETUTCDATE() > '2000-01-01' THEN 1 ELSE 0 END", "SELECT 1"),
    msDate("dateadd-1-day", "SELECT id, DATEADD(day, 10, hired) FROM emp ORDER BY id", "SELECT id, hired + INTERVAL '10 day' FROM emp ORDER BY id"),
    msDate("dateadd-2-month-negative", "SELECT id, DATEADD(month, -1, hired) FROM emp ORDER BY id", "SELECT id, hired + INTERVAL '-1 month' FROM emp ORDER BY id"),
    msDate("dateadd-3-quarter", "SELECT id, DATEADD(quarter, 1, hired) FROM emp ORDER BY id", "SELECT id, hired + INTERVAL '3 month' FROM emp ORDER BY id"),
    msDate("dateadd-4-column-amount", "SELECT id, DATEADD(day, id, hired) FROM emp ORDER BY id", "SELECT id, hired + id * INTERVAL '1 day' FROM emp ORDER BY id"),
    msDate("dateadd-5-year", "SELECT id, DATEADD(yy, 1, hired) FROM emp ORDER BY id", "SELECT id, hired + INTERVAL '1 year' FROM emp ORDER BY id"),
    msDate("datediff-1-day", "SELECT id, DATEDIFF(day, hired, CAST('2024-01-01' AS DATE)) FROM emp ORDER BY id", "SELECT id, DATE '2024-01-01' - hired FROM emp ORDER BY id", { trap: "datediff-boundaries" }),
    msDate("datediff-2-month", "SELECT id, DATEDIFF(month, hired, CAST('2024-01-01' AS DATE)) FROM emp ORDER BY id", "SELECT id, (2024 - EXTRACT(YEAR FROM hired)) * 12 + (1 - EXTRACT(MONTH FROM hired)) FROM emp ORDER BY id", { trap: "datediff-boundaries" }),
    msDate("datediff-3-year", "SELECT id, DATEDIFF(year, hired, CAST('2024-06-01' AS DATE)) FROM emp ORDER BY id", "SELECT id, 2024 - EXTRACT(YEAR FROM hired) FROM emp ORDER BY id", { trap: "datediff-boundaries" }),
    msDate("datediff-4-week", "SELECT DATEDIFF(week, CAST('2024-01-01' AS DATE), CAST('2024-01-15' AS DATE))", undefined, { unconverted: true }),
    msDate("datepart-1", "SELECT id, YEAR(hired), MONTH(hired), DAY(hired) FROM emp ORDER BY id", "SELECT id, EXTRACT(YEAR FROM hired), EXTRACT(MONTH FROM hired), EXTRACT(DAY FROM hired) FROM emp ORDER BY id"),
    msDate("datepart-2-quarter", "SELECT id, DATEPART(quarter, hired) FROM emp ORDER BY id", "SELECT id, EXTRACT(QUARTER FROM hired) FROM emp ORDER BY id"),
    msDate("datepart-3-where", "SELECT id FROM emp WHERE YEAR(hired) = 2019 ORDER BY id", "SELECT id FROM emp WHERE EXTRACT(YEAR FROM hired) = 2019 ORDER BY id"),
    msDate("datepart-4-weekday", "SELECT DATEPART(weekday, CAST('2024-01-01' AS DATE))", undefined, { unconverted: true }),
    msDate("convert-1-style-120", "SELECT id, CONVERT(VARCHAR(10), hired, 120) FROM emp ORDER BY id", "SELECT id, to_char(hired, 'YYYY-MM-DD') FROM emp ORDER BY id"),
    msDate("convert-2-style-120-long", "SELECT id, CONVERT(VARCHAR(19), hired, 120) FROM emp ORDER BY id", "SELECT id, to_char(hired, 'YYYY-MM-DD') || ' 00:00:00' FROM emp ORDER BY id"),
    msDate("convert-3-style-112", "SELECT id, CONVERT(VARCHAR(8), hired, 112) FROM emp ORDER BY id", "SELECT id, to_char(hired, 'YYYYMMDD') FROM emp ORDER BY id"),
    msDate("convert-4-style-101", "SELECT id, CONVERT(VARCHAR(10), hired, 101) FROM emp ORDER BY id", "SELECT id, to_char(hired, 'MM/DD/YYYY') FROM emp ORDER BY id"),
    msDate("convert-5-style-103", "SELECT id, CONVERT(VARCHAR(10), hired, 103) FROM emp ORDER BY id", "SELECT id, to_char(hired, 'DD/MM/YYYY') FROM emp ORDER BY id"),
    msDate("convert-6-int", "SELECT CONVERT(INT, '42') + 1", "SELECT 43"),
    msDate("convert-7-decimal", "SELECT CONVERT(DECIMAL(10, 2), '3.5')", "SELECT 3.50"),
    msDate("convert-8-datetime", "SELECT CONVERT(DATETIME, '2020-01-15 10:30:00')", "SELECT TIMESTAMP '2020-01-15 10:30:00'"),
    msDate("convert-9-unknown-style", "SELECT CONVERT(VARCHAR(10), hired, 9999) FROM emp", undefined, { unconverted: true }),
    myDate("date-format-1", "SELECT id, DATE_FORMAT(hired, '%Y-%m-%d') FROM emp ORDER BY id", "SELECT id, to_char(hired, 'YYYY-MM-DD') FROM emp ORDER BY id"),
    myDate("date-format-2", "SELECT id, DATE_FORMAT(hired, '%d/%m/%Y') FROM emp ORDER BY id", "SELECT id, to_char(hired, 'DD/MM/YYYY') FROM emp ORDER BY id"),
    myDate("date-format-3-names", "SELECT id, DATE_FORMAT(hired, '%b %e, %Y') FROM emp ORDER BY id", "SELECT id, to_char(hired, 'Mon FMDD, YYYY') FROM emp ORDER BY id"),
    myDate("date-format-4-time", "SELECT id, DATE_FORMAT(hired, '%H:%i:%s') FROM emp ORDER BY id", "SELECT id, '00:00:00' FROM emp ORDER BY id"),
    myDate("date-format-5-unsupported", "SELECT DATE_FORMAT(hired, '%U') FROM emp", undefined, { unconverted: true }),
    myDate("date-add-1", "SELECT id, DATE_ADD(hired, INTERVAL 1 MONTH) FROM emp ORDER BY id", "SELECT id, hired + INTERVAL '1 month' FROM emp ORDER BY id"),
    myDate("date-add-2-sub", "SELECT id, DATE_SUB(hired, INTERVAL 7 DAY) FROM emp ORDER BY id", "SELECT id, hired - INTERVAL '7 day' FROM emp ORDER BY id"),
    myDate("date-add-3-column", "SELECT id, DATE_ADD(hired, INTERVAL id DAY) FROM emp ORDER BY id", "SELECT id, hired + id * INTERVAL '1 day' FROM emp ORDER BY id"),
    myDate("datediff-1", "SELECT id, DATEDIFF('2024-01-01', hired) FROM emp ORDER BY id", "SELECT id, DATE '2024-01-01' - hired FROM emp ORDER BY id"),
    myDate("last-day-mysql", "SELECT id, LAST_DAY(hired) FROM emp ORDER BY id", "SELECT id, (date_trunc('month', hired) + INTERVAL '1 month')::date - 1 FROM emp ORDER BY id"),
    myDate("unix-timestamp-1", "SELECT UNIX_TIMESTAMP(CAST('1970-01-02 00:00:00' AS DATETIME))", "SELECT 86400"),
    myDate("from-unixtime-1", "SELECT FROM_UNIXTIME(86400)", "SELECT TIMESTAMP '1970-01-02 00:00:00'"),
    myDate("curdate-1", "SELECT CASE WHEN CURDATE() > '2000-01-01' THEN 1 ELSE 0 END", "SELECT 1"),
    myDate("now-1", "SELECT CASE WHEN NOW() > '2000-01-01' THEN 1 ELSE 0 END", "SELECT 1"),
    myDate("year-month-day", "SELECT id, YEAR(hired), MONTH(hired), DAY(hired) FROM emp ORDER BY id", "SELECT id, EXTRACT(YEAR FROM hired), EXTRACT(MONTH FROM hired), EXTRACT(DAY FROM hired) FROM emp ORDER BY id"),
    myDate("date-function", "SELECT id, DATE(hired) FROM emp ORDER BY id", "SELECT id, hired FROM emp ORDER BY id"),
    dbDate("current-date", "SELECT CASE WHEN CURRENT DATE > '2000-01-01' THEN 1 ELSE 0 END FROM SYSIBM.SYSDUMMY1", "SELECT 1"),
    dbDate("current-timestamp", "SELECT CASE WHEN CURRENT TIMESTAMP > '2000-01-01' THEN 1 ELSE 0 END FROM SYSIBM.SYSDUMMY1", "SELECT 1"),
];

const orStr = make("Strings", "oracle");
const msStr = make("Strings", "mssql");
const myStr = make("Strings", "mysql");

const strings: CorpusCase[] = [
    msStr("plus-1", "SELECT name + ' (' + CAST(id AS VARCHAR(10)) + ')' FROM emp ORDER BY id", "SELECT name || ' (' || id || ')' FROM emp ORDER BY id"),
    msStr("plus-2-schema-null", "SELECT name + email FROM emp ORDER BY id", "SELECT name || email FROM emp ORDER BY id", { schema: true }),
    msStr("plus-3-numbers-stay", "SELECT id, salary + bonus FROM emp ORDER BY id", "SELECT id, salary + bonus FROM emp ORDER BY id", { schema: true }),
    msStr("plus-4-literal-prefix", "SELECT 'Dept ' + CAST(dept_id AS VARCHAR(5)) FROM emp WHERE dept_id IS NOT NULL ORDER BY id", "SELECT 'Dept ' || dept_id FROM emp WHERE dept_id IS NOT NULL ORDER BY id"),
    msStr("plus-5-upper", "SELECT UPPER(name) + '!' FROM emp ORDER BY id", "SELECT UPPER(name) || '!' FROM emp ORDER BY id"),
    msStr("len-1", "SELECT LEN(name), LEN('ab  ') FROM emp WHERE id = 1", "SELECT 5, 2"),
    msStr("len-2-where", "SELECT id FROM emp WHERE LEN(name) > 4 ORDER BY id", "SELECT id FROM emp WHERE LENGTH(name) > 4 ORDER BY id"),
    msStr("charindex-1", "SELECT CHARINDEX('i', name) FROM emp ORDER BY id", "SELECT strpos(name, 'i') FROM emp ORDER BY id"),
    msStr("charindex-2-start", "SELECT CHARINDEX('a', name, 2) FROM emp", undefined, { unconverted: true }),
    msStr("replicate", "SELECT REPLICATE('ab', 3)", "SELECT 'ababab'"),
    msStr("space", "SELECT 'x' + SPACE(2) + 'y'", "SELECT 'x  y'"),
    msStr("string-agg-1", "SELECT dept_id, STRING_AGG(name, ',') WITHIN GROUP (ORDER BY name) FROM emp WHERE dept_id IS NOT NULL GROUP BY dept_id ORDER BY dept_id", "SELECT dept_id, string_agg(name, ',' ORDER BY name) FROM emp WHERE dept_id IS NOT NULL GROUP BY dept_id ORDER BY dept_id"),
    msStr("string-agg-2-no-order", "SELECT STRING_AGG(CAST(id AS VARCHAR(5)), '-') FROM emp WHERE dept_id = 1", "SELECT '1-2'"),
    orStr("instr-1", "SELECT INSTR(email, '@') FROM emp ORDER BY id", "SELECT strpos(email, '@') FROM emp ORDER BY id"),
    orStr("instr-2-start", "SELECT INSTR(email, '@', 2) FROM emp", undefined, { unconverted: true }),
    orStr("listagg-1", "SELECT dept_id, LISTAGG(name, ',') WITHIN GROUP (ORDER BY name) FROM emp WHERE dept_id IS NOT NULL GROUP BY dept_id ORDER BY dept_id", "SELECT dept_id, string_agg(name, ',' ORDER BY name) FROM emp WHERE dept_id IS NOT NULL GROUP BY dept_id ORDER BY dept_id"),
    orStr("listagg-2-numbers", "SELECT LISTAGG(id, ',') WITHIN GROUP (ORDER BY id DESC) FROM emp", "SELECT '6,5,4,3,2,1'"),
    orStr("listagg-3-distinct", "SELECT LISTAGG(DISTINCT region, '/') WITHIN GROUP (ORDER BY region) FROM emp", "SELECT 'EU/US'"),
    orStr("listagg-4-no-separator", "SELECT LISTAGG(name) WITHIN GROUP (ORDER BY id) FROM emp WHERE dept_id = 1", "SELECT 'AliceBob'"),
    orStr("regexp-like-1", "SELECT id FROM emp WHERE REGEXP_LIKE(name, '^[A-C]') ORDER BY id", "SELECT id FROM emp WHERE name ~ '^[A-C]' ORDER BY id"),
    orStr("regexp-like-2-flag", "SELECT id FROM emp WHERE REGEXP_LIKE(name, '^[a-c]', 'i') ORDER BY id", "SELECT id FROM emp WHERE name ~* '^[a-c]' ORDER BY id"),
    orStr("regexp-replace-1", "SELECT REGEXP_REPLACE(email, '[aeiou]', '*') FROM emp WHERE id = 1", "SELECT '*l*c*@x.c*m'"),
    orStr("regexp-replace-2-remove", "SELECT REGEXP_REPLACE('a1b2c3', '[0-9]') FROM DUAL", "SELECT 'abc'"),
    orStr("regexp-substr-1", "SELECT REGEXP_SUBSTR(email, '[a-z]+') FROM emp WHERE id = 1", "SELECT 'alice'"),
    orStr("regexp-instr", "SELECT REGEXP_INSTR(email, '@') FROM emp", undefined, { unconverted: true }),
    orStr("substr-1", "SELECT SUBSTR(name, 1, 3) FROM emp ORDER BY id", "SELECT SUBSTR(name, 1, 3) FROM emp ORDER BY id"),
    orStr("substr-2-zero", "SELECT SUBSTR('abcdef', 0, 3) FROM DUAL", "SELECT SUBSTR('abcdef', 0, 3)", { trap: "substr-zero" }),
    orStr("concat-null", "SELECT name || email FROM emp ORDER BY id", "SELECT name || email FROM emp ORDER BY id", { trap: "oracle-concat-null" }),
    orStr("empty-string", "SELECT id FROM emp WHERE email = '' ORDER BY id", "SELECT id FROM emp WHERE email = '' ORDER BY id", { trap: "oracle-empty-string" }),
    orStr("quote-q", "SELECT q'[it's]' FROM DUAL", "SELECT 'it''s'"),
    myStr("concat-1", "SELECT CONCAT(name, '-', id) FROM emp ORDER BY id", "SELECT name || '-' || id FROM emp ORDER BY id"),
    myStr("concat-2-null", "SELECT CONCAT(name, email) FROM emp ORDER BY id", "SELECT name || email FROM emp ORDER BY id"),
    myStr("group-concat-1", "SELECT dept_id, GROUP_CONCAT(name ORDER BY name SEPARATOR ';') FROM emp WHERE dept_id IS NOT NULL GROUP BY dept_id ORDER BY dept_id", "SELECT dept_id, string_agg(name, ';' ORDER BY name) FROM emp WHERE dept_id IS NOT NULL GROUP BY dept_id ORDER BY dept_id"),
    myStr("group-concat-2-default", "SELECT dept_id, GROUP_CONCAT(name ORDER BY name) FROM emp WHERE dept_id IS NOT NULL GROUP BY dept_id ORDER BY dept_id", "SELECT dept_id, string_agg(name, ',' ORDER BY name) FROM emp WHERE dept_id IS NOT NULL GROUP BY dept_id ORDER BY dept_id"),
    myStr("group-concat-3-distinct", "SELECT GROUP_CONCAT(DISTINCT region ORDER BY region SEPARATOR '/') FROM emp", "SELECT 'EU/US'"),
    myStr("group-concat-4-multi", "SELECT GROUP_CONCAT(name, email) FROM emp", undefined, { unconverted: true }),
    myStr("locate-1", "SELECT LOCATE('@', email) FROM emp ORDER BY id", "SELECT strpos(email, '@') FROM emp ORDER BY id"),
    myStr("length-1", "SELECT LENGTH('héllo')", "SELECT 6"),
    myStr("lcase-ucase", "SELECT LCASE(name), UCASE(name) FROM emp WHERE id = 1", "SELECT 'alice', 'ALICE'"),
    myStr("regexp-op", "SELECT id FROM emp WHERE name REGEXP '^[a-c]' ORDER BY id", "SELECT id FROM emp WHERE name ~* '^[a-c]' ORDER BY id"),
    myStr("not-regexp-op", "SELECT id FROM emp WHERE name NOT REGEXP '^[a-c]' ORDER BY id", "SELECT id FROM emp WHERE name !~* '^[a-c]' ORDER BY id"),
    myStr("double-quoted-string", `SELECT "abc"`, "SELECT 'abc'"),
    myStr("backslash-quote", "SELECT 'it\\'s'", "SELECT 'it''s'"),
    myStr("pipes-or", "SELECT id FROM emp WHERE salary > 8000 || salary < 4500 ORDER BY id", undefined, { traps: ["mysql-pipes-or"] }),
    myStr("division", "SELECT 5 / 2", "SELECT 5 / 2", { trap: "integer-division" }),
    msStr("n-prefix", "SELECT N'abc'", "SELECT 'abc'"),
    msStr("case-insensitive", "SELECT id FROM emp WHERE name = 'alice'", "SELECT id FROM emp WHERE name = 'alice'", { trap: "case-insensitive-compare" }),
    myStr("case-insensitive-like", "SELECT id FROM emp WHERE name LIKE 'a%'", "SELECT id FROM emp WHERE name LIKE 'a%'", { trap: "case-insensitive-compare" }),
];

const orFn = make("Functions", "oracle");
const dbFn = make("Functions", "db2");
const msFn = make("Functions", "mssql");
const myFn = make("Functions", "mysql");

const functions: CorpusCase[] = [
    orFn("sequence-1", "SELECT emp_seq.NEXTVAL FROM DUAL", "SELECT nextval('emp_seq')", { setup: ["ALTER SEQUENCE emp_seq RESTART WITH 100"] }),
    orFn("sequence-2-insert", "INSERT INTO dept (id, name) VALUES (emp_seq.NEXTVAL, 'New')", "INSERT INTO dept (id, name) VALUES (nextval('emp_seq'), 'New')", { setup: ["ALTER SEQUENCE emp_seq RESTART WITH 100"], verify: "SELECT id, name FROM dept ORDER BY id" }),
    orFn("sequence-3-twice", "SELECT emp_seq.NEXTVAL, emp_seq.NEXTVAL FROM DUAL", "SELECT nextval('emp_seq'), nextval('emp_seq')", { setup: ["ALTER SEQUENCE emp_seq RESTART WITH 100"], trap: "sequence-per-row" }),
    dbFn("sequence-4", "SELECT NEXT VALUE FOR emp_seq FROM SYSIBM.SYSDUMMY1", "SELECT nextval('emp_seq')", { setup: ["ALTER SEQUENCE emp_seq RESTART WITH 100"] }),
    msFn("newid", "SELECT LENGTH(CAST(NEWID() AS VARCHAR(36)))", "SELECT 36"),
    myFn("rand", "SELECT CASE WHEN RAND() < 1 THEN 1 ELSE 0 END", "SELECT 1"),
    orFn("sys-guid", "SELECT SYS_GUID() FROM DUAL", undefined, { unconverted: true }),
    orFn("oracle-division", "SELECT 5 / 2 FROM DUAL", "SELECT 5 / 2", { trap: "integer-division" }),
    orFn("dbms-random", "SELECT CASE WHEN DBMS_RANDOM.VALUE < 1 THEN 1 ELSE 0 END FROM DUAL", "SELECT 1"),
    orFn("cast-number", "SELECT CAST(salary AS NUMBER(10,1)) FROM emp WHERE id = 1", "SELECT 9000.0"),
    orFn("cast-varchar2", "SELECT CAST(id AS VARCHAR2(10)) FROM emp ORDER BY id", "SELECT id::text FROM emp ORDER BY id"),
    orFn("cast-number-plain", "SELECT CAST('5' AS NUMBER) + 1 FROM DUAL", "SELECT 6"),
    msFn("cast-nvarchar", "SELECT CAST(id AS NVARCHAR(10)) FROM emp ORDER BY id", "SELECT id::text FROM emp ORDER BY id"),
    msFn("cast-datetime", "SELECT CAST('2020-01-15' AS DATETIME)", "SELECT TIMESTAMP '2020-01-15 00:00:00'"),
    msFn("cast-varchar-max", "SELECT CAST(id AS VARCHAR(MAX)) FROM emp WHERE id = 1", "SELECT '1'"),
    orFn("greatest-null", "SELECT GREATEST(1, NULL, 3) FROM DUAL", "SELECT GREATEST(1, NULL, 3)", { trap: "greatest-least-null" }),
    orFn("months-between", "SELECT MONTHS_BETWEEN(DATE '2020-03-01', DATE '2020-01-01') FROM DUAL", undefined, { unconverted: true }),
    orFn("next-day", "SELECT NEXT_DAY(DATE '2020-01-01', 'MONDAY') FROM DUAL", undefined, { unconverted: true }),
    orFn("sys-context", "SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') FROM DUAL", undefined, { unconverted: true }),
    orFn("dbms-output", "SELECT DBMS_UTILITY.GET_TIME FROM DUAL", undefined, { unconverted: true }),
    msFn("stuff", "SELECT STUFF('abcdef', 2, 3, 'X')", undefined, { unconverted: true }),
    msFn("format", "SELECT FORMAT(salary, 'N2') FROM emp", undefined, { unconverted: true }),
    msFn("try-convert", "SELECT TRY_CONVERT(INT, 'x')", undefined, { unconverted: true }),
    msFn("scope-identity", "SELECT SCOPE_IDENTITY()", undefined, { unconverted: true }),
    myFn("substring-index", "SELECT SUBSTRING_INDEX(email, '@', 1) FROM emp", undefined, { unconverted: true }),
    myFn("last-insert-id", "SELECT LAST_INSERT_ID()", undefined, { unconverted: true }),
    orFn("rowid", "SELECT ROWID, name FROM emp", undefined, { unconverted: true }),
    orFn("rownum-in-select", "SELECT ROWNUM, name FROM emp", undefined, { unconverted: true }),
    orFn("connect-by-root", "SELECT CONNECT_BY_ROOT name FROM emp", undefined, { unconverted: true }),
    orFn("pivot", "SELECT * FROM emp PIVOT (COUNT(*) FOR status IN ('A', 'L'))", undefined, { unconverted: true }),
    msFn("variable", "DECLARE @x INT = 5; SELECT * FROM emp WHERE id = @x", undefined, { unconverted: true }),
    orFn("bind-variable", "SELECT * FROM emp WHERE id = :id", undefined, { unconverted: true }),
    orFn("plsql-block", "BEGIN NULL; END;", undefined, { unconverted: true }),
    msFn("exec", "EXEC sp_who", undefined, { unconverted: true }),
    orFn("create-table", "CREATE TABLE x (id NUMBER)", undefined, { unconverted: true }),
];

const msLimit = make("Row limiting", "mssql");
const orLimit = make("Row limiting", "oracle");
const myLimit = make("Row limiting", "mysql");
const dbLimit = make("Row limiting", "db2");

const limits: CorpusCase[] = [
    msLimit("top-1", "SELECT TOP 3 id FROM emp ORDER BY id", "SELECT id FROM emp ORDER BY id LIMIT 3"),
    msLimit("top-2-parens", "SELECT TOP (2) id FROM emp ORDER BY salary DESC", "SELECT id FROM emp ORDER BY salary DESC LIMIT 2"),
    msLimit("top-3-distinct", "SELECT DISTINCT TOP 2 region FROM emp WHERE region IS NOT NULL ORDER BY region", "SELECT DISTINCT region FROM emp WHERE region IS NOT NULL ORDER BY region LIMIT 2"),
    msLimit("top-4-with-ties", "SELECT TOP 2 WITH TIES dept_id FROM emp WHERE dept_id IS NOT NULL ORDER BY dept_id", "SELECT dept_id FROM emp WHERE dept_id IS NOT NULL ORDER BY dept_id FETCH FIRST 2 ROWS WITH TIES"),
    msLimit("top-5-subquery", "SELECT id FROM emp WHERE id IN (SELECT TOP 2 id FROM emp ORDER BY salary DESC) ORDER BY id", "SELECT id FROM emp WHERE id IN (SELECT id FROM emp ORDER BY salary DESC LIMIT 2) ORDER BY id"),
    msLimit("top-6-percent", "SELECT TOP 50 PERCENT id FROM emp ORDER BY id", undefined, { unconverted: true }),
    msLimit("top-7-with-where", "SELECT TOP 2 id FROM emp WHERE dept_id = 1 ORDER BY id DESC", "SELECT id FROM emp WHERE dept_id = 1 ORDER BY id DESC LIMIT 2"),
    msLimit("top-8-no-order", "SELECT TOP 1 id FROM emp", "SELECT id FROM emp LIMIT 1"),
    msLimit("top-9-union-arm", "SELECT TOP 1 name FROM emp UNION ALL SELECT name FROM dept WHERE id = 1", "(SELECT name FROM emp LIMIT 1) UNION ALL SELECT name FROM dept WHERE id = 1"),
    orLimit("rownum-1-order-by", "SELECT id FROM emp WHERE ROWNUM <= 3 ORDER BY id", "SELECT id FROM emp ORDER BY id LIMIT 3", { trap: "rownum-order-by" }),
    orLimit("rownum-2-equals-one", "SELECT id FROM emp WHERE ROWNUM = 1", "SELECT id FROM emp LIMIT 1"),
    orLimit("rownum-3-with-filter", "SELECT id FROM emp WHERE dept_id = 1 AND ROWNUM <= 1", "SELECT id FROM emp WHERE dept_id = 1 LIMIT 1"),
    orLimit("rownum-4-less-than", "SELECT id FROM emp WHERE ROWNUM < 3", "SELECT id FROM emp LIMIT 2"),
    orLimit("rownum-5-bind", "SELECT id FROM emp WHERE ROWNUM <= :n", undefined, { unconverted: true }),
    orLimit("rownum-6-pagination", "SELECT * FROM (SELECT x.*, ROWNUM rn FROM (SELECT id, name FROM emp ORDER BY id) x WHERE ROWNUM <= 4) WHERE rn > 2", "SELECT id, name FROM emp ORDER BY id LIMIT 2 OFFSET 2", { trap: "rownum-pagination-column" }),
    orLimit("rownum-7-pagination-between", "SELECT * FROM (SELECT x.*, ROWNUM rn FROM (SELECT id, name FROM emp ORDER BY id) x) WHERE rn BETWEEN 2 AND 4", "SELECT id, name FROM emp ORDER BY id LIMIT 3 OFFSET 1", { trap: "rownum-pagination-column" }),
    orLimit("rownum-8-subquery", "SELECT id FROM emp WHERE id IN (SELECT id FROM emp WHERE ROWNUM <= 2) ORDER BY id", "SELECT id FROM emp WHERE id IN (SELECT id FROM emp LIMIT 2) ORDER BY id"),
    orLimit("rownum-9-impossible", "SELECT id FROM emp WHERE ROWNUM = 2", undefined, { unconverted: true }),
    orLimit("rownum-10-union", "SELECT id FROM emp WHERE ROWNUM <= 2 UNION ALL SELECT id FROM dept WHERE id = 1", "(SELECT id FROM emp LIMIT 2) UNION ALL SELECT id FROM dept WHERE id = 1"),
    orLimit("fetch-first", "SELECT id FROM emp ORDER BY id FETCH FIRST 2 ROWS ONLY", "SELECT id FROM emp ORDER BY id LIMIT 2"),
    orLimit("dual-1", "SELECT 1 + 1 FROM DUAL", "SELECT 2"),
    orLimit("dual-2-where", "SELECT 'x' FROM DUAL WHERE 1 = 0", "SELECT 'x' WHERE false"),
    orLimit("dual-3-sys-dual", "SELECT 1 FROM SYS.DUAL", "SELECT 1"),
    orLimit("dual-4-subquery", "SELECT (SELECT COUNT(*) FROM emp) FROM DUAL", "SELECT 6"),
    myLimit("dual-5", "SELECT 1 FROM DUAL", "SELECT 1"),
    dbLimit("dual-6-sysdummy", "SELECT 1 FROM SYSIBM.SYSDUMMY1", "SELECT 1"),
    myLimit("limit-offset-1", "SELECT id FROM emp ORDER BY id LIMIT 2, 3", "SELECT id FROM emp ORDER BY id LIMIT 3 OFFSET 2"),
    myLimit("limit-offset-2-plain", "SELECT id FROM emp ORDER BY id LIMIT 2", "SELECT id FROM emp ORDER BY id LIMIT 2"),
    myLimit("limit-offset-3-keyword", "SELECT id FROM emp ORDER BY id LIMIT 2 OFFSET 1", "SELECT id FROM emp ORDER BY id LIMIT 2 OFFSET 1"),
    myLimit("limit-offset-4-subquery", "SELECT id FROM emp WHERE id IN (SELECT id FROM emp ORDER BY id LIMIT 1, 2) ORDER BY id", "SELECT id FROM emp WHERE id IN (SELECT id FROM emp ORDER BY id LIMIT 2 OFFSET 1) ORDER BY id"),
];

const orJoin = make("Joins", "oracle");
const msJoin = make("Joins", "mssql");

const joins: CorpusCase[] = [
    orJoin("outer-1", "SELECT e.name, d.name FROM emp e, dept d WHERE e.dept_id = d.id(+) ORDER BY e.id", "SELECT e.name, d.name FROM emp e LEFT JOIN dept d ON e.dept_id = d.id ORDER BY e.id"),
    orJoin("outer-2-other-side", "SELECT d.name, e.name FROM dept d, emp e WHERE d.id = e.dept_id(+) ORDER BY d.id, e.id", "SELECT d.name, e.name FROM dept d LEFT JOIN emp e ON d.id = e.dept_id ORDER BY d.id, e.id"),
    orJoin("outer-3-filter-on-outer", "SELECT e.name, d.name FROM emp e, dept d WHERE e.dept_id = d.id(+) AND d.name(+) = 'Sales' ORDER BY e.id", "SELECT e.name, d.name FROM emp e LEFT JOIN dept d ON e.dept_id = d.id AND d.name = 'Sales' ORDER BY e.id"),
    orJoin("outer-4-filter-on-inner", "SELECT e.name, d.name FROM emp e, dept d WHERE e.dept_id = d.id(+) AND e.salary > 5000 ORDER BY e.id", "SELECT e.name, d.name FROM emp e LEFT JOIN dept d ON e.dept_id = d.id WHERE e.salary > 5000 ORDER BY e.id"),
    orJoin("outer-5-two-outer-tables", "SELECT e.name, d.name, b.plan FROM emp e, dept d, benefit b WHERE e.dept_id = d.id(+) AND e.id = b.emp_id(+) AND b.coverage_end(+) >= DATE '2025-01-01' ORDER BY e.id", "SELECT e.name, d.name, b.plan FROM emp e LEFT JOIN dept d ON e.dept_id = d.id LEFT JOIN benefit b ON e.id = b.emp_id AND b.coverage_end >= DATE '2025-01-01' ORDER BY e.id"),
    orJoin("outer-6-chain", "SELECT o.id, e.name, d.name FROM ord o, emp e, dept d WHERE o.emp_id = e.id(+) AND e.dept_id = d.id(+) ORDER BY o.id", "SELECT o.id, e.name, d.name FROM ord o LEFT JOIN emp e ON o.emp_id = e.id LEFT JOIN dept d ON e.dept_id = d.id ORDER BY o.id"),
    orJoin("outer-7-inner-and-outer", "SELECT e.name, d.name, o.total FROM emp e, dept d, ord o WHERE e.dept_id = d.id AND e.id = o.emp_id(+) ORDER BY e.id, o.id", "SELECT e.name, d.name, o.total FROM emp e INNER JOIN dept d ON e.dept_id = d.id LEFT JOIN ord o ON e.id = o.emp_id ORDER BY e.id, o.id"),
    orJoin("outer-8-self", "SELECT e.name, m.name FROM emp e, emp m WHERE e.mgr_id = m.id(+) ORDER BY e.id", "SELECT e.name, m.name FROM emp e LEFT JOIN emp m ON e.mgr_id = m.id ORDER BY e.id"),
    orJoin("outer-9-or", "SELECT e.name FROM emp e, dept d WHERE e.dept_id = d.id(+) OR d.id(+) = 1", undefined, { unconverted: true }),
    orJoin("outer-10-unqualified", "SELECT e.name FROM emp e, dept d WHERE e.dept_id = id(+)", undefined, { unconverted: true }),
    orJoin("outer-11-subquery-alias", "SELECT e.name, x.cnt FROM emp e, (SELECT emp_id, COUNT(*) AS cnt FROM ord GROUP BY emp_id) x WHERE e.id = x.emp_id(+) ORDER BY e.id", "SELECT e.name, x.cnt FROM emp e LEFT JOIN (SELECT emp_id, COUNT(*) AS cnt FROM ord GROUP BY emp_id) x ON e.id = x.emp_id ORDER BY e.id"),
    orJoin("outer-12-in-subquery", "SELECT name FROM emp WHERE id IN (SELECT e.id FROM emp e, dept d WHERE e.dept_id = d.id(+) AND d.id IS NULL) ORDER BY id", "SELECT name FROM emp WHERE id IN (SELECT e.id FROM emp e LEFT JOIN dept d ON e.dept_id = d.id WHERE d.id IS NULL) ORDER BY id"),
    orJoin("outer-13-derived-no-alias", "SELECT COUNT(*) FROM (SELECT id FROM emp)", "SELECT 6"),
    orJoin("outer-14-cross-no-link", "SELECT COUNT(*) FROM emp e, dept d", "SELECT 24"),
    orJoin("implicit-inner", "SELECT e.name, d.name FROM emp e, dept d WHERE e.dept_id = d.id ORDER BY e.id", "SELECT e.name, d.name FROM emp e JOIN dept d ON e.dept_id = d.id ORDER BY e.id"),
    msJoin("apply-1-cross", "SELECT d.id, x.cnt FROM dept d CROSS APPLY (SELECT COUNT(*) AS cnt FROM emp e WHERE e.dept_id = d.id) x ORDER BY d.id", "SELECT d.id, (SELECT COUNT(*) FROM emp e WHERE e.dept_id = d.id) FROM dept d ORDER BY d.id"),
    msJoin("apply-2-outer-top", "SELECT d.id, x.name FROM dept d OUTER APPLY (SELECT TOP 1 e.name FROM emp e WHERE e.dept_id = d.id ORDER BY e.salary DESC) x ORDER BY d.id", "SELECT d.id, (SELECT e.name FROM emp e WHERE e.dept_id = d.id ORDER BY e.salary DESC LIMIT 1) FROM dept d ORDER BY d.id"),
    msJoin("apply-3-cross-drops", "SELECT d.id, x.name FROM dept d CROSS APPLY (SELECT TOP 1 e.name FROM emp e WHERE e.dept_id = d.id ORDER BY e.salary DESC) x ORDER BY d.id", "SELECT d.id, (SELECT e.name FROM emp e WHERE e.dept_id = d.id ORDER BY e.salary DESC LIMIT 1) FROM dept d WHERE EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.id) ORDER BY d.id"),
    msJoin("nolock-1", "SELECT id FROM emp WITH (NOLOCK) WHERE dept_id = 1 ORDER BY id", "SELECT id FROM emp WHERE dept_id = 1 ORDER BY id", { trap: "nolock" }),
    msJoin("nolock-2-join", "SELECT e.id FROM emp e WITH (NOLOCK) JOIN dept d WITH (NOLOCK) ON e.dept_id = d.id ORDER BY e.id", "SELECT e.id FROM emp e JOIN dept d ON e.dept_id = d.id ORDER BY e.id", { trap: "nolock" }),
    msJoin("hint-readpast", "SELECT id FROM emp WITH (READPAST, ROWLOCK) ORDER BY id", "SELECT id FROM emp ORDER BY id"),
    msJoin("option-recompile", "SELECT id FROM emp ORDER BY id OPTION (RECOMPILE)", "SELECT id FROM emp ORDER BY id"),
    msJoin("bracket-names", "SELECT [name] FROM [dbo].[emp] WHERE [id] = 1", "SELECT name FROM emp WHERE id = 1"),
    msJoin("bracket-spaces", `SELECT [name] AS [Employee Name] FROM [dbo].[emp] WHERE [id] = 1`, `SELECT name AS "Employee Name" FROM emp WHERE id = 1`),
    make("Joins", "mysql")("backticks", "SELECT `name` FROM `emp` WHERE `id` = 1", "SELECT name FROM emp WHERE id = 1"),
    make("Joins", "mysql")("index-hint", "SELECT id FROM emp USE INDEX (PRIMARY) WHERE id = 1", "SELECT id FROM emp WHERE id = 1"),
    orJoin("oracle-hint", "SELECT /*+ FULL(e) */ id FROM emp e WHERE id = 1", "SELECT id FROM emp e WHERE id = 1"),
    orJoin("upper-case-names", "SELECT EMP.NAME FROM EMP WHERE EMP.ID = 1", "SELECT name FROM emp WHERE id = 1"),
];

const orSet = make("Set operations", "oracle");

const sets: CorpusCase[] = [
    orSet("minus-1", "SELECT id FROM dept MINUS SELECT dept_id FROM emp", "SELECT id FROM dept EXCEPT SELECT dept_id FROM emp"),
    orSet("minus-2-order", "SELECT id FROM dept MINUS SELECT dept_id FROM emp ORDER BY 1", "SELECT id FROM dept EXCEPT SELECT dept_id FROM emp ORDER BY 1"),
    orSet("minus-3-three", "SELECT id FROM dept MINUS SELECT dept_id FROM emp MINUS SELECT 4 FROM DUAL", "SELECT id FROM dept EXCEPT SELECT dept_id FROM emp EXCEPT SELECT 4"),
    orSet("minus-4-subquery", "SELECT name FROM dept WHERE id IN (SELECT id FROM dept MINUS SELECT dept_id FROM emp)", "SELECT name FROM dept WHERE id IN (SELECT id FROM dept EXCEPT SELECT dept_id FROM emp)"),
    orSet("union", "SELECT id FROM dept WHERE id < 3 UNION SELECT id FROM dept WHERE id > 2 ORDER BY 1", "SELECT id FROM dept ORDER BY 1"),
];

const orTree = make("Hierarchies", "oracle");

const hierarchies: CorpusCase[] = [
    orTree("connect-1-siblings", "SELECT LEVEL, id, name FROM emp START WITH mgr_id IS NULL CONNECT BY PRIOR id = mgr_id ORDER SIBLINGS BY name", "SELECT 1, 1, 'Alice' UNION ALL SELECT 2, 2, 'Bob' UNION ALL SELECT 2, 3, 'Carol' UNION ALL SELECT 3, 4, 'Dave' UNION ALL SELECT 2, 5, 'Eve' UNION ALL SELECT 2, 6, 'Frank'", { ordered: true, traps: ["connect-by-cycles"] }),
    orTree("connect-2-order-by", "SELECT LEVEL, id FROM emp START WITH mgr_id IS NULL CONNECT BY PRIOR id = mgr_id ORDER BY id", "SELECT 1, 1 UNION ALL SELECT 2, 2 UNION ALL SELECT 2, 3 UNION ALL SELECT 3, 4 UNION ALL SELECT 2, 5 UNION ALL SELECT 2, 6 ORDER BY 2"),
    orTree("connect-3-generator", "SELECT LEVEL FROM DUAL CONNECT BY LEVEL <= 5", "SELECT generate_series(1, 5)"),
    orTree("connect-4-where", "SELECT id FROM emp WHERE salary > 5000 START WITH id = 1 CONNECT BY PRIOR id = mgr_id ORDER BY id", "SELECT id FROM emp WHERE salary > 5000 ORDER BY id"),
    orTree("connect-5-bottom-up", "SELECT LEVEL, id FROM emp START WITH id = 4 CONNECT BY PRIOR mgr_id = id ORDER BY LEVEL", "SELECT 1, 4 UNION ALL SELECT 2, 3 UNION ALL SELECT 3, 1 ORDER BY 1"),
    orTree("connect-6-subtree", "SELECT id FROM emp START WITH id = 3 CONNECT BY PRIOR id = mgr_id ORDER BY id", "SELECT 3 UNION ALL SELECT 4 ORDER BY 1"),
    orTree("connect-7-extra-condition", "SELECT id FROM emp START WITH id = 1 CONNECT BY PRIOR id = mgr_id AND salary > 5500 ORDER BY id", "SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 5 ORDER BY 1"),
    orTree("connect-8-generator-less-than", "SELECT LEVEL FROM DUAL CONNECT BY LEVEL < 4", "SELECT generate_series(1, 3)"),
    orTree("connect-9-sys-path", "SELECT SYS_CONNECT_BY_PATH(name, '/') FROM emp START WITH mgr_id IS NULL CONNECT BY PRIOR id = mgr_id", undefined, { unconverted: true }),
    orTree("connect-10-nocycle", "SELECT id FROM emp START WITH id = 1 CONNECT BY NOCYCLE PRIOR id = mgr_id", undefined, { unconverted: true }),
    orTree("connect-11-with-join", "SELECT e.id, d.name FROM emp e, dept d WHERE e.dept_id = d.id START WITH e.mgr_id IS NULL CONNECT BY PRIOR e.id = e.mgr_id", undefined, { unconverted: true }),
];

const orDml = make("Data changes", "oracle");
const myDml = make("Data changes", "mysql");
const msDml = make("Data changes", "mssql");

const dml: CorpusCase[] = [
    orDml("delete-from", "DELETE emp WHERE id = 6", "DELETE FROM emp WHERE id = 6", { verify: "SELECT COUNT(*) FROM emp" }),
    orDml("delete-from-plain", "DELETE FROM emp WHERE id = 6", "DELETE FROM emp WHERE id = 6", { verify: "SELECT COUNT(*) FROM emp" }),
    orDml("update-nvl", "UPDATE emp SET bonus = NVL(bonus, 0) + 10 WHERE id = 2", "UPDATE emp SET bonus = COALESCE(bonus, 0) + 10 WHERE id = 2", { verify: "SELECT id, bonus FROM emp ORDER BY id" }),
    orDml("update-decode", "UPDATE emp SET status = DECODE(status, 'A', 'I', status) WHERE dept_id = 1", "UPDATE emp SET status = CASE status WHEN 'A' THEN 'I' ELSE status END WHERE dept_id = 1", { verify: "SELECT id, status FROM emp ORDER BY id" }),
    orDml("insert-select-rownum", "INSERT INTO dept (id, name) SELECT id + 100, name FROM dept WHERE ROWNUM <= 2", "INSERT INTO dept (id, name) SELECT id + 100, name FROM dept LIMIT 2", { verify: "SELECT id, name FROM dept ORDER BY id" }),
    orDml("insert-values-sequence", "INSERT INTO dept (id, name) VALUES (emp_seq.NEXTVAL, 'Seq')", "INSERT INTO dept (id, name) VALUES (nextval('emp_seq'), 'Seq')", { setup: ["ALTER SEQUENCE emp_seq RESTART WITH 500"], verify: "SELECT id, name FROM dept ORDER BY id" }),
    orDml("merge-1", "MERGE INTO dept d USING (SELECT 2 AS id, 'Sales EU' AS name FROM DUAL) s ON (d.id = s.id) WHEN MATCHED THEN UPDATE SET d.name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)", "MERGE INTO dept d USING (SELECT 2 AS id, 'Sales EU' AS name) s ON (d.id = s.id) WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)", { verify: "SELECT id, name FROM dept ORDER BY id", trap: "merge-version" }),
    orDml("merge-2-insert", "MERGE INTO dept d USING (SELECT 9 AS id, 'New' AS name FROM DUAL) s ON (d.id = s.id) WHEN MATCHED THEN UPDATE SET d.name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)", "MERGE INTO dept d USING (SELECT 9 AS id, 'New' AS name) s ON (d.id = s.id) WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)", { verify: "SELECT id, name FROM dept ORDER BY id", trap: "merge-version" }),
    myDml("insert-ignore", "INSERT IGNORE INTO dept (id, name) VALUES (1, 'Dup'), (9, 'New')", "INSERT INTO dept (id, name) VALUES (1, 'Dup'), (9, 'New') ON CONFLICT DO NOTHING", { verify: "SELECT id, name FROM dept ORDER BY id", trap: "insert-ignore-errors" }),
    myDml("on-duplicate-key-1", "INSERT INTO dept (id, name) VALUES (1, 'Eng2') ON DUPLICATE KEY UPDATE name = VALUES(name)", "INSERT INTO dept (id, name) VALUES (1, 'Eng2') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", { schema: true, verify: "SELECT id, name FROM dept ORDER BY id" }),
    myDml("on-duplicate-key-2-insert", "INSERT INTO dept (id, name) VALUES (9, 'New') ON DUPLICATE KEY UPDATE name = VALUES(name)", "INSERT INTO dept (id, name) VALUES (9, 'New') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", { schema: true, verify: "SELECT id, name FROM dept ORDER BY id" }),
    myDml("on-duplicate-key-3-expression", "INSERT INTO dept (id, name) VALUES (1, 'x') ON DUPLICATE KEY UPDATE name = CONCAT(name, '!')", "INSERT INTO dept (id, name) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET name = dept.name || '!'", { schema: true, verify: "SELECT id, name FROM dept ORDER BY id" }),
    myDml("on-duplicate-key-4-no-schema", "INSERT INTO dept (id, name) VALUES (1, 'x') ON DUPLICATE KEY UPDATE name = VALUES(name)", undefined, { unconverted: true }),
    msDml("update-from-join", "UPDATE e SET e.salary = d.id FROM emp e JOIN dept d ON e.dept_id = d.id", undefined, { unconverted: true }),
    myDml("update-limit", "UPDATE emp SET bonus = 0 LIMIT 1", undefined, { unconverted: true }),
    msDml("insert-top-isnull", "INSERT INTO dept (id, name) SELECT TOP 2 id + 200, ISNULL(name, 'x') FROM dept ORDER BY id", "INSERT INTO dept (id, name) SELECT id + 200, COALESCE(name, 'x') FROM dept ORDER BY id LIMIT 2", { verify: "SELECT id, name FROM dept ORDER BY id" }),
];

const plain: CorpusCase[] = [
    make("No change needed", "oracle")("select-count", "SELECT COUNT(*) FROM emp WHERE salary > 5000", "SELECT COUNT(*) FROM emp WHERE salary > 5000"),
    make("No change needed", "oracle")("join-group", "SELECT d.name, COUNT(e.id) FROM dept d LEFT JOIN emp e ON e.dept_id = d.id GROUP BY d.name ORDER BY d.name", "SELECT d.name, COUNT(e.id) FROM dept d LEFT JOIN emp e ON e.dept_id = d.id GROUP BY d.name ORDER BY d.name"),
    make("No change needed", "mssql")("cte", "WITH hi AS (SELECT id FROM emp WHERE salary > 6000) SELECT COUNT(*) FROM hi", "SELECT 3"),
    make("No change needed", "mysql")("case", "SELECT id, CASE WHEN salary > 6000 THEN 'hi' ELSE 'lo' END FROM emp ORDER BY id", "SELECT id, CASE WHEN salary > 6000 THEN 'hi' ELSE 'lo' END FROM emp ORDER BY id"),
    make("No change needed", "db2")("window", "SELECT id, ROW_NUMBER() OVER (ORDER BY salary DESC) FROM emp ORDER BY id", "SELECT id, ROW_NUMBER() OVER (ORDER BY salary DESC) FROM emp ORDER BY id"),
    make("No change needed", "oracle")("exists", "SELECT name FROM dept d WHERE EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.id) ORDER BY id", "SELECT name FROM dept d WHERE EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.id) ORDER BY id"),
    make("No change needed", "oracle")("in-list", "SELECT id FROM emp WHERE status IN ('A', 'L') ORDER BY id", "SELECT id FROM emp WHERE status IN ('A', 'L') ORDER BY id"),
    make("No change needed", "oracle")("between", "SELECT id FROM emp WHERE salary BETWEEN 5000 AND 7000 ORDER BY id", "SELECT id FROM emp WHERE salary BETWEEN 5000 AND 7000 ORDER BY id"),
    make("No change needed", "mssql")("two-statements", "SELECT 1; SELECT 2", "SELECT 2"),
];

import { REALISTIC } from "./realistic";

export const CASES: CorpusCase[] = [...nullHandling, ...conditionals, ...dates, ...strings, ...functions, ...limits, ...joins, ...sets, ...hierarchies, ...dml, ...plain, ...REALISTIC];
