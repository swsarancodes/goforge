import { runReadOnly, type Queryable } from "../services/pg-read.js";
import { wanted } from "./facts.js";

/**
 * What to look at on the live database before a runbook starts, from the catalog and the activity views, read-only: other sessions that
 * hold or are about to hold locks on the tables, transactions that have been open a long time, a replica that is behind, replication
 * slots holding WAL, the timeouts the role runs with. Each check is a fact with the numbers it rests on, and says when the connection
 * is not allowed to see something instead of passing quietly.
 *
 * The disk space a step needs is not here on purpose: PostgreSQL can't tell a client how much room is left on the server's disk.
 */

export type PreflightStatus = "ok" | "warn" | "block" | "unknown";

export interface PreflightCheck {
    id: "primary" | "sessions" | "locks" | "prepared" | "replication" | "slots" | "vacuum" | "timeouts";
    title: string;
    status: PreflightStatus;
    detail: string;
    /** The sessions, slots or settings behind the status, one line each (at most 10). */
    items: string[];
}

export interface PreflightReport {
    generatedAt: string;
    serverVersion: string;
    tables: string[];
    checks: PreflightCheck[];
}

export const PREFLIGHT_LIMITS = {
    /** A transaction open this long on one of the tables will hold a schema change up. */
    longTransactionSeconds: 30,
    /** A replica further behind than this makes a rewrite or a big backfill worse. */
    replicaLagBytes: 16 * 1024 * 1024,
    replicaLagSeconds: 5,
    /** A slot that holds back this much WAL fills the disk while a step writes. */
    slotRetainedBytes: 256 * 1024 * 1024,
};

interface Row {
    [key: string]: unknown;
}

const number = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const clip = (items: string[]): string[] => (items.length > 10 ? [...items.slice(0, 10), `… and ${items.length - 10} more`] : items);
const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
const age = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
};

// Starts from pg_locks, which every role can read in full, and adds what pg_stat_activity will say about each session: a role that is
// not allowed to read other roles' sessions (no pg_read_all_stats) still finds out who holds or waits for the tables, just not what they run.
const SESSIONS_SQL = (cte: string) => `${cte}
    SELECT l.pid, a.usename AS role, a.state, extract(epoch FROM now() - a.xact_start) AS xact_seconds,
           left(regexp_replace(COALESCE(a.query, ''), '\\s+', ' ', 'g'), 120) AS query,
           (a.pid IS NULL OR a.backend_type IS NULL) AS hidden,
           COALESCE(json_agg(DISTINCT t.schema || '.' || t.name) FILTER (WHERE l.granted), '[]'::json) AS holds,
           COALESCE(json_agg(DISTINCT t.schema || '.' || t.name) FILTER (WHERE NOT l.granted), '[]'::json) AS waits
    FROM pg_locks l JOIN t ON t.oid = l.relation LEFT JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.pid IS NOT NULL AND l.pid <> pg_backend_pid() AND l.locktype = 'relation'
    GROUP BY l.pid, a.pid, a.usename, a.state, a.xact_start, a.query, a.backend_type`;

const LOCKS_SQL = (cte: string) => `${cte}
    SELECT l.pid, l.mode, l.granted, t.schema || '.' || t.name AS "table"
    FROM pg_locks l JOIN t ON t.oid = l.relation
    WHERE l.pid <> pg_backend_pid() AND l.locktype = 'relation' AND l.mode IN ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')`;

const PREPARED_SQL = (cte: string) => `${cte}
    SELECT x.gid, extract(epoch FROM now() - x.prepared) AS seconds,
           COALESCE((SELECT json_agg(DISTINCT t.schema || '.' || t.name) FROM pg_locks l JOIN t ON t.oid = l.relation WHERE l.pid IS NULL AND l.virtualtransaction = '-1/' || x.transaction::text), '[]'::json) AS tables
    FROM pg_prepared_xacts x WHERE x.database = current_database()`;

const VACUUM_SQL = (cte: string) => `${cte}
    SELECT t.schema || '.' || t.name AS "table", p.phase, p.pid
    FROM pg_stat_progress_vacuum p JOIN t ON t.oid = p.relid WHERE p.datname = current_database()`;

// reset_val is what the session started with (the server, database and role settings); current_setting would report the 15s limit this read itself sets.
const SETTING = (name: string) => `(SELECT CASE WHEN reset_val = '0' THEN '0' ELSE reset_val || COALESCE(unit, '') END FROM pg_settings WHERE name = '${name}')`;

const SETTINGS_SQL = `SELECT current_setting('server_version') AS version, pg_is_in_recovery() AS recovery,
    ${SETTING("statement_timeout")} AS statement_timeout, ${SETTING("lock_timeout")} AS lock_timeout,
    ${SETTING("idle_in_transaction_session_timeout")} AS idle_timeout,
    (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type IS NULL)::int AS hidden_sessions`;

const REPLICATION_SQL = `SELECT application_name, client_addr::text AS address, state, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::int8::text AS replay_bytes,
    extract(epoch FROM replay_lag) AS replay_seconds FROM pg_stat_replication`;

const SLOTS_SQL = `SELECT slot_name, slot_type, active, pg_wal_lsn_diff(pg_current_wal_lsn(), COALESCE(restart_lsn, pg_current_wal_lsn()))::int8::text AS retained_bytes FROM pg_replication_slots`;

export async function preflight(client: Queryable, tables: string[]): Promise<PreflightReport> {
    const unique = [...new Set(tables)];
    const cte = unique.length > 0 ? wanted(unique) : `WITH t AS (SELECT NULL::oid AS oid, NULL::text AS schema, NULL::text AS name WHERE false)`;

    const [settings] = await runReadOnly(client, [SETTINGS_SQL]);
    const base = (settings.rows as Row[])[0];
    const recovery = base.recovery === true;

    const [sessions, locks, prepared, vacuum] = await runReadOnly(client, [SESSIONS_SQL(cte), LOCKS_SQL(cte), PREPARED_SQL(cte), VACUUM_SQL(cte)]);
    // On a replica pg_current_wal_lsn() raises, so the replication views are only read on a primary.
    let replicas: Row[] = [];
    let slots: Row[] = [];
    let replicationNote: string | undefined;
    if (!recovery) {
        try {
            const [r, s] = await runReadOnly(client, [REPLICATION_SQL, SLOTS_SQL]);
            replicas = r.rows as Row[];
            slots = s.rows as Row[];
        } catch (error) {
            replicationNote = error instanceof Error ? error.message : String(error);
        }
    }

    return evaluate({ tables: unique, base, sessions: sessions.rows as Row[], locks: locks.rows as Row[], prepared: prepared.rows as Row[], vacuum: vacuum.rows as Row[], replicas, slots, replicationNote });
}

export interface PreflightInput {
    tables: string[];
    base: Row;
    sessions: Row[];
    locks: Row[];
    prepared: Row[];
    vacuum: Row[];
    replicas: Row[];
    slots: Row[];
    replicationNote?: string;
}

/** The checks, from what the views returned. Separate from the queries so each rule can be tested on its own. */
export function evaluate(input: PreflightInput): PreflightReport {
    const { base, sessions, locks, prepared, vacuum, replicas, slots } = input;
    const recovery = base.recovery === true;
    const scope = new Set(input.tables.map((name) => (name.includes(".") ? name : `public.${name}`)));
    const checks: PreflightCheck[] = [];

    checks.push(
        recovery
            ? { id: "primary", title: "Connected to a primary", status: "block", detail: "This connection is to a read replica (the server is in recovery). Schema changes fail there; connect to the primary.", items: [] }
            : { id: "primary", title: "Connected to a primary", status: "ok", detail: "Not in recovery: this is the server that takes writes.", items: [] },
    );

    const names = (row: Row, key: "holds" | "waits") => row[key] as string[];
    const inScope = (row: Row) => [...new Set([...names(row, "holds"), ...names(row, "waits")])].filter((name) => scope.has(name));
    const touching = sessions.filter((row) => inScope(row).length > 0);
    const long = touching.filter((row) => row.xact_seconds !== null && Number(row.xact_seconds) >= PREFLIGHT_LIMITS.longTransactionSeconds);
    const hidden = number(base.hidden_sessions) ?? 0;
    const line = (row: Row) =>
        row.hidden === true
            ? `pid ${row.pid} (another role: its transaction and query are not visible to this connection) on ${inScope(row).join(", ")}`
            : `pid ${row.pid} (${row.role ?? "?"}, ${row.state ?? "state hidden"}${row.xact_seconds !== null ? `, transaction open ${age(Number(row.xact_seconds))}` : ""}) on ${inScope(row).join(", ")}: ${row.query || "(no query)"}`;
    if (long.length > 0) {
        checks.push({ id: "sessions", title: "Open transactions on these tables", status: "warn", detail: `${long.length} transaction${long.length === 1 ? " has" : "s have"} been open ${PREFLIGHT_LIMITS.longTransactionSeconds}s or more on the tables this change touches. A step that needs a strong lock waits for ${long.length === 1 ? "it" : "them"}, and everything else queues behind the step.`, items: clip(long.map(line)) });
    } else if (touching.length > 0) {
        checks.push({ id: "sessions", title: "Open transactions on these tables", status: "warn", detail: `${touching.length} session${touching.length === 1 ? " is" : "s are"} using these tables right now${touching.some((row) => row.hidden === true) ? " (for how long is not visible for some of them)" : " (none for long)"}. Strong-lock steps retry while they finish.`, items: clip(touching.map(line)) });
    } else {
        checks.push({ id: "sessions", title: "Open transactions on these tables", status: "ok", detail: `No other session holds or waits for a lock on these tables.${hidden > 0 ? ` (${hidden} other session${hidden === 1 ? " belongs" : "s belong"} to roles this connection cannot inspect, but none of them holds a lock on these tables.)` : ""}`, items: [] });
    }

    checks.push(
        locks.length > 0
            ? { id: "locks", title: "Strong locks held right now", status: "warn", detail: "Another session holds, or is waiting for, a lock that conflicts with ordinary reads or writes. Wait for it, or the steps will queue behind it.", items: clip(locks.map((row) => `pid ${row.pid}: ${row.mode} on ${row.table}${row.granted ? "" : " (waiting)"}`)) }
            : { id: "locks", title: "Strong locks held right now", status: "ok", detail: "No other session holds a strong lock on these tables.", items: [] },
    );

    const preparedHere = prepared.filter((row) => (row.tables as string[]).some((name) => scope.has(name)));
    checks.push(
        preparedHere.length > 0
            ? { id: "prepared", title: "Prepared transactions", status: "warn", detail: "A prepared (two-phase) transaction holds locks on these tables and no session owns it, so retries will not help until it is committed or rolled back.", items: clip(preparedHere.map((row) => `${row.gid}, prepared ${age(Number(row.seconds))} ago`)) }
            : { id: "prepared", title: "Prepared transactions", status: "ok", detail: prepared.length > 0 ? `${prepared.length} prepared transaction${prepared.length === 1 ? "" : "s"} exist, none on these tables.` : "None.", items: [] },
    );

    if (recovery) {
        checks.push({ id: "replication", title: "Replicas", status: "unknown", detail: "Not read: this server is itself a replica.", items: [] });
        checks.push({ id: "slots", title: "Replication slots", status: "unknown", detail: "Not read: this server is itself a replica.", items: [] });
    } else if (input.replicationNote) {
        checks.push({ id: "replication", title: "Replicas", status: "unknown", detail: `Could not read the replication views: ${input.replicationNote}`, items: [] });
        checks.push({ id: "slots", title: "Replication slots", status: "unknown", detail: "Could not be read.", items: [] });
    } else {
        const behind = replicas.filter((row) => (number(row.replay_bytes) ?? 0) >= PREFLIGHT_LIMITS.replicaLagBytes || (number(row.replay_seconds) ?? 0) >= PREFLIGHT_LIMITS.replicaLagSeconds);
        checks.push(
            replicas.length === 0
                ? { id: "replication", title: "Replicas", status: "ok", detail: "No streaming replicas are attached (or this role cannot see them).", items: [] }
                : behind.length > 0
                  ? { id: "replication", title: "Replicas", status: "warn", detail: "A replica is behind. A rewrite or a large backfill writes a lot of WAL and widens the gap.", items: clip(behind.map((row) => `${row.application_name || row.address}: ${row.state}, ${mib(number(row.replay_bytes) ?? 0)} behind${row.replay_seconds !== null && row.replay_seconds !== undefined ? `, ${age(Number(row.replay_seconds))} replay lag` : ""}`)) }
                  : { id: "replication", title: "Replicas", status: "ok", detail: `${replicas.length} replica${replicas.length === 1 ? " is" : "s are"} attached and caught up.`, items: [] },
        );
        const held = slots.filter((row) => row.active === false || (number(row.retained_bytes) ?? 0) >= PREFLIGHT_LIMITS.slotRetainedBytes);
        checks.push(
            held.length > 0
                ? { id: "slots", title: "Replication slots", status: "warn", detail: "A slot that nothing is reading keeps all the WAL a step writes on the server's disk.", items: clip(held.map((row) => `${row.slot_name} (${row.slot_type}, ${row.active ? "active" : "inactive"}) holds ${mib(number(row.retained_bytes) ?? 0)} of WAL`)) }
                : { id: "slots", title: "Replication slots", status: "ok", detail: slots.length > 0 ? `${slots.length} slot${slots.length === 1 ? "" : "s"}, all active and not holding much WAL.` : "None.", items: [] },
        );
    }

    checks.push(
        vacuum.length > 0
            ? { id: "vacuum", title: "Vacuum running on these tables", status: "warn", detail: "A vacuum holds SHARE UPDATE EXCLUSIVE on its table, which makes some steps (index builds, constraint validation) wait for it.", items: clip(vacuum.map((row) => `${row.table}: pid ${row.pid}, ${row.phase}`)) }
            : { id: "vacuum", title: "Vacuum running on these tables", status: "ok", detail: "None.", items: [] },
    );

    const timeouts: string[] = [];
    const statementTimeout = String(base.statement_timeout);
    const idleTimeout = String(base.idle_timeout);
    if (statementTimeout !== "0") timeouts.push(`statement_timeout = ${statementTimeout}: a step that runs longer (an index build, a backfill batch, a validation) is cancelled. The runbook sets it to 0 for those steps, but your application's own role may differ.`);
    if (idleTimeout !== "0") timeouts.push(`idle_in_transaction_session_timeout = ${idleTimeout}: a session left open between steps is ended.`);
    checks.push(
        timeouts.length > 0
            ? { id: "timeouts", title: "Timeouts this role runs with", status: "warn", detail: "The role used for this connection has timeouts set. Steps adjust the ones they need, but know they exist.", items: timeouts }
            : { id: "timeouts", title: "Timeouts this role runs with", status: "ok", detail: `statement_timeout 0, lock_timeout ${base.lock_timeout}, idle_in_transaction_session_timeout 0.`, items: [] },
    );

    return { generatedAt: new Date().toISOString(), serverVersion: String(base.version), tables: [...scope], checks };
}
