import { literal } from "./sql-render.js";

/**
 * A step that needs a strong lock on a busy table can't just wait: everything that arrives after it queues behind it. So each attempt
 * waits only a short, fixed time (`lock_timeout`), and when it gives up the step backs off and tries again, a few times. If the table
 * never goes quiet the step stops and says who was holding it, so the person running it knows what to wait for or ask someone to end.
 *
 * It is plain SQL in one DO block, so it runs anywhere the runbook runs (the SQL Editor included) and changes nothing when it gives up:
 * the statements are one transaction, and a failed attempt rolls back to the start of its own block.
 */

export interface LockRetryOptions {
    /** How long one attempt may wait for its lock. */
    lockTimeoutSeconds: number;
    /** Attempts before giving up (the first one included). */
    attempts: number;
    /** Tables to look at, schema qualified and quoted where needed, when it gives up: the table the step locks and any others it locks too. */
    tables: string[];
}

const BEGIN_MARK = "-- goforge:retry-begin";
const END_MARK = "-- goforge:retry-end";

/** Statements that can't run inside a DO block, or that manage their own transactions or waits. */
const NOT_IN_A_BLOCK = /\b(CONCURRENTLY|COMMIT|ROLLBACK|VACUUM|CALL|CREATE\s+DATABASE|DROP\s+DATABASE|ALTER\s+SYSTEM)\b|^\s*DO\b/im;

/** Whether the step's SQL can be wrapped. `sql` is the step's statements without the session settings. */
export function canRetry(sql: string): boolean {
    return !NOT_IN_A_BLOCK.test(sql) && !sql.includes("$retry$");
}

export function withLockRetry(sql: string, options: LockRetryOptions): string {
    const tables = options.tables.map((name) => `to_regclass(${literal(name)})::oid`).join(", ");
    const timeout = `${options.lockTimeoutSeconds}s`;
    return [
        "DO $retry$",
        "DECLARE",
        "  attempt int := 0;",
        "  holders text;",
        "BEGIN",
        "  LOOP",
        "    attempt := attempt + 1;",
        "    BEGIN",
        `      SET LOCAL lock_timeout = '${timeout}';`,
        `      ${BEGIN_MARK}`,
        ...sql.replace(/\s+$/, "").split("\n").map((line) => `      ${line}`),
        `      ${END_MARK}`,
        "      EXIT;",
        "    EXCEPTION WHEN lock_not_available THEN",
        `      IF attempt >= ${options.attempts} THEN`,
        "        SELECT string_agg(format('pid %s (%s%s) running: %s', a.pid, a.state, CASE WHEN a.xact_start IS NULL THEN '' ELSE ', transaction open ' || to_char(now() - a.xact_start, 'HH24:MI:SS') END, left(regexp_replace(a.query, '\\s+', ' ', 'g'), 120)), '; ')",
        "          INTO holders",
        "          FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid",
        `         WHERE l.locktype = 'relation' AND l.granted AND l.pid <> pg_backend_pid() AND l.relation = ANY (ARRAY[${tables}]);`,
        `        RAISE EXCEPTION 'Gave up after % attempts of ${timeout} each: the lock is still held. Nothing was changed. Held by: %', attempt, COALESCE(holders, 'nothing that can be seen from this session (another role, or a prepared transaction)')`,
        "          USING ERRCODE = 'lock_not_available', HINT = 'Wait for those transactions to finish, or ask their owners to end them, then run this step again.';",
        "      END IF;",
        "      PERFORM pg_sleep(least(attempt, 5));",
        "    END;",
        "  END LOOP;",
        "END",
        "$retry$;",
    ].join("\n");
}

/** The statements inside a wrapped step, for anything that reads the SQL (the lint); the text itself when the step is not wrapped. */
export function unwrapLockRetry(sql: string): { sql: string; wrapped: boolean } {
    const start = sql.indexOf(BEGIN_MARK);
    const end = sql.indexOf(END_MARK);
    if (start === -1 || end === -1 || end < start) return { sql, wrapped: false };
    const prefix = sql.slice(0, sql.indexOf("DO $retry$"));
    const inner = sql.slice(start + BEGIN_MARK.length, end).split("\n").map((line) => line.replace(/^ {6}/, "")).join("\n").trim();
    return { sql: `${prefix}${inner}`, wrapped: true };
}
