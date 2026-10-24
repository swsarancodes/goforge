import type { LegacyDialect } from "../types";

/**
 * Every conversion the engine can make, in plain words. The UI lists the ones that fired; the corpus reports its pass
 * rate per family. A rule only exists here if it has fixture tests.
 */
export type RuleFamily = "Null handling" | "Conditionals" | "Dates and times" | "Strings" | "Functions" | "Row limiting" | "Joins" | "Set operations" | "Hierarchies" | "Names and quoting" | "Hints and options" | "Data changes" | "Types";

export interface RuleMeta {
    family: RuleFamily;
    title: string;
    /** One sentence a data engineer can read: what the old construct meant and what PostgreSQL does instead. */
    why: string;
    dialects: LegacyDialect[];
}

const ALL: LegacyDialect[] = ["oracle", "mssql", "mysql", "db2"];

export const RULES = {
    nvl: { family: "Null handling", title: "NVL / ISNULL / IFNULL / VALUE → COALESCE", why: "COALESCE is the standard way to replace NULL and works the same for two arguments.", dialects: ALL },
    nvl2: { family: "Null handling", title: "NVL2 → CASE", why: "NVL2(a, b, c) returns b when a is not NULL, otherwise c, which is a CASE expression in PostgreSQL.", dialects: ["oracle"] },
    "null-safe-equals": { family: "Null handling", title: "<=> → IS NOT DISTINCT FROM", why: "MySQL's null-safe equals treats two NULLs as equal; IS NOT DISTINCT FROM does the same.", dialects: ["mysql"] },
    decode: { family: "Conditionals", title: "DECODE → CASE", why: "DECODE compares with = but treats NULL as equal to NULL; the CASE keeps both behaviours.", dialects: ["oracle", "db2"] },
    iif: { family: "Conditionals", title: "IIF / IF → CASE", why: "PostgreSQL has no IIF or IF function; CASE WHEN is the equivalent.", dialects: ["mssql", "mysql"] },
    sysdate: { family: "Dates and times", title: "SYSDATE / GETDATE / CURDATE → CURRENT_TIMESTAMP / CURRENT_DATE", why: "These return the current date and time; PostgreSQL's names are CURRENT_TIMESTAMP and CURRENT_DATE.", dialects: ALL },
    "date-arithmetic": { family: "Dates and times", title: "SYSDATE ± n → interval arithmetic", why: "Oracle adds days as plain numbers. PostgreSQL needs an interval for a timestamp.", dialects: ["oracle"] },
    "add-months": { family: "Dates and times", title: "ADD_MONTHS → date + interval", why: "Adding months is interval arithmetic in PostgreSQL.", dialects: ["oracle"] },
    "last-day": { family: "Dates and times", title: "LAST_DAY → date_trunc + interval", why: "The last day of a month is the first day of the next month minus a day.", dialects: ["oracle", "mysql"] },
    trunc: { family: "Dates and times", title: "TRUNC(date) → date_trunc", why: "Oracle's TRUNC cuts a date to a unit; PostgreSQL's date_trunc does the same. TRUNC(number) stays as trunc().", dialects: ["oracle"] },
    "to-char": { family: "Dates and times", title: "TO_CHAR / TO_NUMBER with one argument → CAST", why: "PostgreSQL's to_char and to_number need a format; a bare conversion is a CAST.", dialects: ["oracle"] },
    dateadd: { family: "Dates and times", title: "DATEADD → date + interval", why: "PostgreSQL adds an interval to a timestamp.", dialects: ["mssql"] },
    datediff: { family: "Dates and times", title: "DATEDIFF / TIMESTAMPDIFF → subtraction / EXTRACT", why: "These count how many whole days, months or boundaries lie between two dates; the replacement counts them the same way.", dialects: ["mssql", "mysql"] },
    datepart: { family: "Dates and times", title: "DATEPART / YEAR / MONTH / DAY → EXTRACT", why: "EXTRACT reads one part of a date in PostgreSQL.", dialects: ["mssql", "mysql"] },
    "date-format": { family: "Dates and times", title: "DATE_FORMAT / STR_TO_DATE → to_char / to_timestamp", why: "MySQL format codes (%Y-%m-%d) map to PostgreSQL's (YYYY-MM-DD) templates.", dialects: ["mysql"] },
    "date-interval": { family: "Dates and times", title: "DATE_ADD / TIMESTAMPADD / n DAYS → interval literal", why: "PostgreSQL writes intervals as INTERVAL '1 day'.", dialects: ["mysql", "db2"] },
    "unix-time": { family: "Dates and times", title: "UNIX_TIMESTAMP / FROM_UNIXTIME → EXTRACT(EPOCH) / to_timestamp", why: "PostgreSQL reads and builds epoch seconds with EXTRACT(EPOCH FROM …) and to_timestamp().", dialects: ["mysql"] },
    convert: { family: "Dates and times", title: "CONVERT(type, x, style) → CAST / to_char", why: "CONVERT's style number picks a date format; to_char with the matching template reproduces it.", dialects: ["mssql"] },
    "concat-plus": { family: "Strings", title: "+ between strings → ||", why: "T-SQL joins strings with +; in PostgreSQL + only adds numbers.", dialects: ["mssql"] },
    "concat-function": { family: "Strings", title: "CONCAT(a, b) → a || b", why: "MySQL's CONCAT returns NULL if any argument is NULL, which || does too (PostgreSQL's concat() would skip NULLs).", dialects: ["mysql"] },
    length: { family: "Strings", title: "LEN / LENGTH → length variants", why: "T-SQL LEN ignores trailing spaces, MySQL LENGTH counts bytes; PostgreSQL's length counts characters.", dialects: ["mssql", "mysql"] },
    position: { family: "Strings", title: "CHARINDEX / INSTR / LOCATE → strpos", why: "These find a substring's position; PostgreSQL's strpos does too, with the arguments the other way round.", dialects: ["mssql", "oracle", "mysql"] },
    listagg: { family: "Strings", title: "LISTAGG / GROUP_CONCAT / STRING_AGG → string_agg", why: "string_agg joins values from a group with a separator.", dialects: ["oracle", "mysql", "mssql"] },
    regexp: { family: "Strings", title: "REGEXP_LIKE / REGEXP_REPLACE → ~ / regexp_replace", why: "PostgreSQL matches patterns with ~ and replaces every match only with the 'g' flag.", dialects: ["oracle", "mysql"] },
    "string-functions": { family: "Strings", title: "Renamed string functions", why: "The same operation has a different name in PostgreSQL (REPLICATE → repeat, LCASE → lower, …).", dialects: ["mssql", "mysql", "oracle"] },
    sequence: { family: "Functions", title: "seq.NEXTVAL → nextval('seq')", why: "PostgreSQL reads sequences through nextval() and currval().", dialects: ["oracle", "db2"] },
    "uuid-random": { family: "Functions", title: "NEWID / UUID / RAND / DBMS_RANDOM.VALUE → gen_random_uuid / random", why: "PostgreSQL's names for a random UUID and a random number.", dialects: ["mssql", "mysql"] },
    "to-date": { family: "Functions", title: "TO_DATE / TO_TIMESTAMP kept, one-argument form flagged", why: "to_date needs a format in PostgreSQL.", dialects: ["oracle"] },
    top: { family: "Row limiting", title: "TOP n → LIMIT n", why: "PostgreSQL limits rows at the end of the query.", dialects: ["mssql"] },
    "rownum-limit": { family: "Row limiting", title: "WHERE ROWNUM <= n → LIMIT n", why: "ROWNUM numbers rows as they come out; LIMIT is the PostgreSQL equivalent.", dialects: ["oracle"] },
    "rownum-pagination": { family: "Row limiting", title: "ROWNUM pagination subqueries → LIMIT / OFFSET", why: "The three-level ROWNUM page query is what LIMIT … OFFSET … does directly.", dialects: ["oracle"] },
    "limit-offset": { family: "Row limiting", title: "LIMIT a, b → LIMIT b OFFSET a", why: "MySQL's two-number LIMIT is offset first; PostgreSQL spells the offset out.", dialects: ["mysql"] },
    "outer-join": { family: "Joins", title: "(+) → LEFT / RIGHT JOIN", why: "The (+) marker made a table optional; the ANSI join says the same and moves the condition into ON.", dialects: ["oracle"] },
    "derived-alias": { family: "Joins", title: "Subquery in FROM gets an alias", why: "PostgreSQL before version 16 requires every subquery in FROM to have a name; Oracle and SQL Server do not.", dialects: ALL },
    apply: { family: "Joins", title: "CROSS / OUTER APPLY → LATERAL", why: "APPLY runs a subquery per row; PostgreSQL calls this a LATERAL join.", dialects: ["mssql"] },
    minus: { family: "Set operations", title: "MINUS → EXCEPT", why: "EXCEPT is the standard name for MINUS.", dialects: ["oracle"] },
    dual: { family: "Row limiting", title: "FROM DUAL removed", why: "PostgreSQL lets SELECT run without a FROM clause.", dialects: ["oracle", "mysql", "db2"] },
    "connect-by": { family: "Hierarchies", title: "CONNECT BY → WITH RECURSIVE", why: "A hierarchical query walks parent to child; a recursive CTE does the same walk.", dialects: ["oracle"] },
    "quoted-names": { family: "Names and quoting", title: "[x], `x` and \"X\" → PostgreSQL names", why: "PostgreSQL quotes names with double quotes and folds bare names to lower case. Oracle and DB2 store bare names in upper case, so \"NAME\" and name are the same column there.", dialects: ["mssql", "mysql", "oracle", "db2"] },
    "schema-prefix": { family: "Names and quoting", title: "dbo. prefix removed", why: "PostgreSQL has no dbo schema; the name resolves through the search_path.", dialects: ["mssql"] },
    "string-quotes": { family: "Names and quoting", title: "\"text\" and N'text' → 'text'", why: "Text literals use single quotes in PostgreSQL.", dialects: ["mysql", "mssql", "oracle"] },
    hints: { family: "Hints and options", title: "Optimizer hints removed", why: "PostgreSQL ignores Oracle hints and SQL Server table hints; the planner decides.", dialects: ["oracle", "mssql", "db2"] },
    merge: { family: "Data changes", title: "MERGE adapted to PostgreSQL 15+", why: "PostgreSQL's MERGE is close to Oracle's; column names in SET can't be qualified.", dialects: ["oracle", "mssql"] },
    "insert-ignore": { family: "Data changes", title: "INSERT IGNORE → ON CONFLICT DO NOTHING", why: "PostgreSQL skips duplicate rows with ON CONFLICT DO NOTHING.", dialects: ["mysql"] },
    "on-duplicate-key": { family: "Data changes", title: "ON DUPLICATE KEY UPDATE → ON CONFLICT DO UPDATE", why: "PostgreSQL needs the unique columns named; the new row is EXCLUDED.", dialects: ["mysql"] },
    "delete-from": { family: "Data changes", title: "DELETE t → DELETE FROM t", why: "PostgreSQL requires the FROM keyword.", dialects: ["oracle", "mssql"] },
    "implicit-cast": { family: "Types", title: "Number or date passed to a text function is cast to text", why: "Oracle and SQL Server convert it for you; PostgreSQL stops with a type error.", dialects: ["oracle", "mssql", "mysql", "db2"] },
    "cast-types": { family: "Types", title: "Data type names in CAST", why: "VARCHAR2, NUMBER, NVARCHAR … are spelled varchar, numeric, … in PostgreSQL.", dialects: ["oracle", "mssql", "mysql"] },
} as const satisfies Record<string, RuleMeta>;

export type RuleId = keyof typeof RULES;

export interface AppliedRule {
    id: RuleId;
    family: RuleFamily;
    title: string;
    why: string;
    count: number;
    /** A few before/after fragments from this query. */
    examples: { before: string; after: string }[];
}

export interface UnconvertedItem {
    /** The construct as it appears in the query. */
    construct: string;
    reason: string;
    /** What to do instead. */
    hint?: string;
}

export type TrapSeverity = "changes-results" | "check";

export interface Trap {
    id: string;
    severity: TrapSeverity;
    title: string;
    explanation: string;
}
