import { maskSql, splitSqlStatements } from "../services/sql-tokens.js";
import type { RunbookStep } from "./runbook.js";

/**
 * Checks a runbook the way a reviewer would, from the SQL text and the size class of each table, without looking at how the
 * compiler produced it. A runbook that passes uses none of the usual ways of taking a large table offline by accident.
 */

export interface LintViolation {
    rule: string;
    step: number;
    message: string;
    statement: string;
}

export interface LintResult {
    violations: LintViolation[];
    statements: number;
}

const BIG = new Set(["medium", "large"]);

interface Context {
    /** `table|column` pairs for which a `CHECK (column IS NOT NULL)` has been added and then validated earlier in the runbook. */
    validatedNotNull: Set<string>;
    /** `table|constraint` -> column, for such checks that are added but not validated yet. */
    pendingNotNull: Map<string, string>;
}

const firstLine = (text: string): string => text.replace(/\s+/g, " ").slice(0, 120);

const TABLE = String.raw`((?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)(?:\.(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*))?)`;

export function lintSteps(steps: RunbookStep[]): LintResult {
    const violations: LintViolation[] = [];
    const context: Context = { validatedNotNull: new Set(), pendingNotNull: new Map() };
    let statements = 0;

    for (const step of steps) {
        if (step.optional) continue;
        const big = BIG.has(step.sizeClass);
        const lockTimeoutSet = /SET\s+lock_timeout\s*=\s*'[1-9]/i.test(step.sql);
        const flag = (rule: string, message: string, statement: string) => violations.push({ rule, step: step.id, message, statement: firstLine(statement) });

        for (const statement of splitSqlStatements(step.sql)) {
            statements++;
            const code = maskSql(statement.text).replace(/\s+/g, " ").trim();
            const upper = code.toUpperCase();
            const isDo = /^DO\b/.test(upper);

            if (/^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END|ABORT|SAVEPOINT)\b/.test(upper)) {
                flag("transaction-control", "The SQL Editor runs each statement on its own and refuses BEGIN/COMMIT; atomic steps belong in a DO block.", statement.text);
            }
            if (/\bDROP\b/.test(upper) && /\bCASCADE\b/.test(upper)) flag("cascade", "DROP ... CASCADE removes whatever depends on the object without listing it.", statement.text);
            if (isDo && /\bCONCURRENTLY\b/i.test(statement.text)) flag("concurrently-in-do", "CONCURRENTLY can't run inside a DO block (it is one transaction).", statement.text);

            if (/^CREATE (UNIQUE )?INDEX\b/.test(upper) && !/\bCONCURRENTLY\b/.test(upper) && big && !/\bON ONLY\b/.test(upper)) {
                flag("index-not-concurrent", `CREATE INDEX without CONCURRENTLY blocks writes to ${step.table} for the whole build.`, statement.text);
            }
            if (/^DROP INDEX\b/.test(upper) && !/\bCONCURRENTLY\b/.test(upper) && big) {
                flag("drop-index-not-concurrent", `DROP INDEX without CONCURRENTLY takes ACCESS EXCLUSIVE on ${step.table}.`, statement.text);
            }
            if (/\bADD\b.*\bFOREIGN KEY\b/.test(upper) && !/\bNOT VALID\b/.test(upper) && big) {
                flag("foreign-key-validated-inline", `Adding a foreign key without NOT VALID scans ${step.table} while blocking writes to it and to the table it points at.`, statement.text);
            }
            if (/\bADD\b(?: CONSTRAINT\b.*?)?\bCHECK\b/.test(upper) && !/\bNOT VALID\b/.test(upper) && big) {
                flag("check-validated-inline", `Adding a CHECK without NOT VALID scans ${step.table} under ACCESS EXCLUSIVE.`, statement.text);
            }

            // Names are read from the statement as written (masking blanks quoted identifiers).
            const plain = statement.text.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
            const addCheck = new RegExp(String.raw`^ALTER TABLE ${TABLE} ADD CONSTRAINT (\S+) CHECK \(\s*(\S+) IS NOT NULL\s*\) NOT VALID`, "i").exec(plain);
            if (addCheck) context.pendingNotNull.set(`${addCheck[1]}|${addCheck[2]}`.toLowerCase(), addCheck[3].toLowerCase());
            const validate = new RegExp(String.raw`^ALTER TABLE ${TABLE} VALIDATE CONSTRAINT (\S+?);?$`, "i").exec(plain);
            if (validate) {
                const column = context.pendingNotNull.get(`${validate[1]}|${validate[2]}`.toLowerCase());
                if (column) context.validatedNotNull.add(`${validate[1]}|${column}`.toLowerCase());
            }

            const setNotNull = new RegExp(String.raw`^ALTER TABLE ${TABLE} ALTER COLUMN (\S+) SET NOT NULL`, "i").exec(plain);
            if (setNotNull && big && !context.validatedNotNull.has(`${setNotNull[1]}|${setNotNull[2]}`.toLowerCase())) {
                flag("set-not-null-direct", `SET NOT NULL scans ${step.table} under ACCESS EXCLUSIVE unless a validated CHECK (column IS NOT NULL) already proves it.`, statement.text);
            }

            if (/\bALTER COLUMN\b.*\bTYPE\b/.test(upper) && big && step.work === "rewrite") {
                flag("type-change-rewrites", `Changing a column type rewrites ${step.table} and its indexes under ACCESS EXCLUSIVE.`, statement.text);
            }
            if (/^(UPDATE|DELETE FROM)\b/.test(upper) && big) {
                flag("unbatched-write", `A single ${upper.split(" ")[0]} over ${step.table} holds its row locks for the whole statement and produces one huge transaction; use committed batches.`, statement.text);
            }

            const needsLockTimeout = /^(ALTER TABLE|DROP TABLE|CREATE TRIGGER|DROP TRIGGER|ALTER INDEX)\b/.test(upper) && step.sizeClass !== "new";
            const insideDo = isDo && /SET LOCAL lock_timeout\s*=\s*'[1-9]/i.test(statement.text);
            if (needsLockTimeout && !lockTimeoutSet && !insideDo) {
                flag("no-lock-timeout", `This statement waits for a lock on ${step.table} without a limit, and everything else queues behind it while it waits.`, statement.text);
            }
        }
    }
    return { violations, statements };
}
