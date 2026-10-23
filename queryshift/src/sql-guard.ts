/**
 * The check generated SQL passes before it is ever run. Candidate SQL comes from a model or from a person's edit, so it is treated as
 * untrusted: one read-only statement, nothing that writes, locks, changes settings, reads files, calls out of the database, or sleeps.
 * It is a first line, not the only one: the statement then runs inside a READ ONLY transaction that is always rolled back.
 * It is deliberately strict. A query it refuses is reported as refused, with the reason, never run and never "fixed".
 */

export interface GuardResult {
    ok: boolean;
    reason?: string;
}

export const MAX_SQL_LENGTH = 20_000;

const FORBIDDEN_WORDS = [
    "insert", "update", "delete", "merge", "into", "truncate", "drop", "alter", "create", "grant", "revoke", "copy", "call", "do", "execute",
    "set", "reset", "lock", "vacuum", "reindex", "cluster", "refresh", "notify", "listen", "begin", "commit", "rollback",
];

/** Function names (a prefix when it ends in `*`) that read files, reach other servers, run strings as SQL, change settings or state, or sleep. */
const FORBIDDEN_FUNCTIONS = [
    "pg_read_*", "pg_ls_*", "pg_stat_file", "pg_file_*", "lo_*", "dblink*", "pg_sleep*", "set_config", "pg_terminate_backend", "pg_cancel_backend",
    "pg_reload_conf", "pg_rotate_logfile", "nextval", "setval", "pg_advisory_*", "pg_try_advisory_*", "pg_notify", "query_to_xml*", "cursor_to_xml*",
    "table_to_xml*", "schema_to_xml*", "database_to_xml*", "pg_logical_*", "pg_create_*", "pg_drop_*", "pg_switch_*", "pg_backup_*", "pg_promote",
    "pg_replication_*", "pg_export_snapshot", "pg_import_system_collations", "txid_*", "pg_copy_*", "pg_relation_filepath", "pg_current_logfile",
];

/**
 * Comments removed, string contents and dollar-quoted bodies blanked, quoted identifiers kept as bare words (so `"pg_read_file"(...)` is
 * still seen), everything lower case. Returns null when a comment or a literal is never closed.
 */
export function skeleton(sql: string): string | null {
    let out = "";
    let index = 0;
    const length = sql.length;
    while (index < length) {
        const character = sql[index];
        const next = sql[index + 1];
        if (character === "-" && next === "-") {
            while (index < length && sql[index] !== "\n") index++;
            out += " ";
        } else if (character === "/" && next === "*") {
            let depth = 1;
            index += 2;
            while (index < length && depth > 0) {
                if (sql[index] === "/" && sql[index + 1] === "*") (depth++, (index += 2));
                else if (sql[index] === "*" && sql[index + 1] === "/") (depth--, (index += 2));
                else index++;
            }
            if (depth > 0) return null;
            out += " ";
        } else if (character === "'") {
            const escaped = /[eE]$/.test(out) && !/[\w$][eE]$/.test(out);
            index++;
            let closed = false;
            while (index < length) {
                if (escaped && sql[index] === "\\") index += 2;
                else if (sql[index] === "'" && sql[index + 1] === "'") index += 2;
                else if (sql[index] === "'") {
                    closed = true;
                    index++;
                    break;
                } else index++;
            }
            if (!closed) return null;
            out += "''";
        } else if (character === '"') {
            index++;
            let name = "";
            let closed = false;
            while (index < length) {
                if (sql[index] === '"' && sql[index + 1] === '"') (name += '"', (index += 2));
                else if (sql[index] === '"') {
                    closed = true;
                    index++;
                    break;
                } else name += sql[index++];
            }
            if (!closed) return null;
            out += ` ${name.toLowerCase()} `;
        } else if (character === "$") {
            const tag = sql.slice(index).match(/^\$[A-Za-z_]?\w*\$/);
            if (tag) {
                const end = sql.indexOf(tag[0], index + tag[0].length);
                if (end < 0) return null;
                index = end + tag[0].length;
                out += "''";
            } else out += sql[index++];
        } else out += sql[index++];
    }
    return out.toLowerCase();
}

const matches = (name: string, pattern: string) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);

export function guardSelect(sql: string): GuardResult {
    if (sql.trim() === "") return { ok: false, reason: "The query is empty." };
    if (sql.length > MAX_SQL_LENGTH) return { ok: false, reason: `The query is longer than ${MAX_SQL_LENGTH} characters.` };
    const flat = skeleton(sql);
    if (flat === null) return { ok: false, reason: "A comment, string or quoted name is never closed." };

    const body = flat.replace(/[\s;]+$/, "");
    if (body.includes(";")) return { ok: false, reason: "Only one statement may be run at a time." };
    if (!/^\s*(select|with|values|table|\()/.test(body)) return { ok: false, reason: "Only a SELECT (or WITH ... SELECT) statement may be run." };

    const words = body.match(/[a-z_][a-z0-9_$]*/g) ?? [];
    const word = words.find((candidate) => FORBIDDEN_WORDS.includes(candidate));
    if (word) return { ok: false, reason: `The keyword ${word.toUpperCase()} is not allowed: only reading is.` };
    if (/\bfor\s+(no\s+key\s+)?(update|share|key\s+share)\b/.test(body)) return { ok: false, reason: "Row locking (FOR UPDATE / FOR SHARE) is not allowed." };

    for (const call of body.matchAll(/([a-z_][a-z0-9_$]*)\s*\(/g)) {
        const name = call[1];
        const pattern = FORBIDDEN_FUNCTIONS.find((candidate) => matches(name, candidate));
        if (pattern) return { ok: false, reason: `The function ${name}() is not allowed: it reads files, changes state, runs text as SQL or sleeps.` };
    }
    return { ok: true };
}
