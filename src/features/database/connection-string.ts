import type { CreateConnectionInput } from "@/lib/live-connection-api";

/**
 * Reads what people paste when they are asked for "the connection": a postgres:// URL, a JDBC URL, a
 * libpq key=value string, or a whole shell line such as `psql "postgres://…"` or `DATABASE_URL=postgres://…`.
 * Nothing is guessed that the text does not say, except two defaults that libpq also has (port 5432, and
 * the user name as the database name); everything inferred is reported in `notes`.
 */

export interface ParsedConnection {
    input: CreateConnectionInput;
    /** What was not in the text and was filled in, so it can be shown next to a failure. */
    notes: string[];
    /** Query parameters or keys that were read but have no effect on how GoForge connects. */
    ignored: string[];
}

export type ConnectionStringResult = { ok: true; value: ParsedConnection } | { ok: false; reason: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const POSTGRES_SCHEMES = new Set(["postgres", "postgresql"]);

// The key=value form is only recognised with one of these keys, so ordinary prose is never read as a connection.
const DSN_KEYS = new Set(["host", "hostaddr", "port", "dbname", "database", "user", "username", "password", "sslmode", "ssl"]);

/** True when the text is clearly meant as a connection string, so a paste can be acted on at once. */
export function looksLikeConnectionString(text: string): boolean {
    const value = unwrap(text);
    return /^(jdbc:)?[a-z][a-z0-9+.-]*:\/\//i.test(value) || /(^|\s)(host|dbname|user|password)\s*=/i.test(value);
}

/** Strips a shell wrapper: `psql 'url'`, `export DATABASE_URL="url"`, quotes and a trailing semicolon. */
function unwrap(text: string): string {
    let value = text.trim();
    value = value.replace(/^(?:export\s+)?[A-Z][A-Z0-9_]*=(?=["']?(?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/)/, "");
    value = value.replace(/^psql\s+/i, "");
    value = value.replace(/;+$/, "").trim();
    if (value.length > 1 && /^(["']).*\1$/s.test(value)) value = value.slice(1, -1).trim();
    return value;
}

function decode(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        // A password such as "50%off" is not valid percent-encoding; keep it as it was written.
        return part;
    }
}

const isPort = (value: string): boolean => /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;

/** `host`, `host:port`, `[::1]:port`; a list of hosts takes the first one. */
function splitHost(hostPart: string): { host: string; port?: string } {
    const first = hostPart.split(",")[0]!.trim();
    const bracketed = first.match(/^\[([^\]]+)\](?::(.*))?$/);
    if (bracketed) return { host: bracketed[1]!, port: bracketed[2] || undefined };
    const colon = first.lastIndexOf(":");
    // More than one colon outside brackets is an unbracketed IPv6 address, which has no port.
    if (colon !== -1 && first.indexOf(":") === colon) return { host: first.slice(0, colon), port: first.slice(colon + 1) || undefined };
    return { host: first };
}

type Fields = Partial<Record<"host" | "port" | "database" | "username" | "password" | "sslmode", string>>;

/** Turns the pieces into a connection, applying the defaults libpq has and recording what was inferred. */
function build(fields: Fields, ignored: string[]): ConnectionStringResult {
    const notes: string[] = [];
    let host = (fields.host ?? "").trim();
    if (host.startsWith("/")) return { ok: false, reason: "That host is a Unix socket path. GoForge connects over the network, so give a host name or address." };
    if (!host) {
        host = "localhost";
        notes.push("No host was given, so localhost is used.");
    }

    let port = 5432;
    if (fields.port !== undefined && fields.port !== "") {
        if (!isPort(fields.port)) return { ok: false, reason: `"${fields.port}" is not a valid port. Use a number from 1 to 65535.` };
        port = Number(fields.port);
    }

    const username = fields.username ?? "";
    if (!username) return { ok: false, reason: "The connection string has no user name. Use postgres://user:password@host:5432/database." };

    let database = fields.database ?? "";
    if (!database) {
        database = username;
        notes.push("No database was given, so the user name is used as the database name, as psql does.");
    }

    const mode = fields.sslmode?.toLowerCase();
    let sslMode: CreateConnectionInput["sslMode"];
    if (mode === "disable") sslMode = "disable";
    else if (mode === "verify-ca" || mode === "verify-full") sslMode = "verify-full";
    else if (mode === "require") sslMode = "allow";
    else if (mode === undefined || mode === "prefer" || mode === "allow") {
        // libpq tries TLS and falls back to plain text; a saved connection cannot, so decide by where the host is.
        const local = LOCAL_HOSTS.has(host.toLowerCase());
        sslMode = local ? "disable" : "allow";
        notes.push(local ? "No sslmode was given and the host is local, so the connection is not encrypted." : "No sslmode was given and the host is remote, so the connection is encrypted without checking the certificate. Add ?sslmode=disable if the server has no TLS, or ?sslmode=verify-full to check the certificate.");
    } else {
        return { ok: false, reason: `sslmode "${fields.sslmode}" is not one of disable, allow, prefer, require, verify-ca, verify-full.` };
    }

    return {
        ok: true,
        value: {
            input: { name: database, host, port, username, password: fields.password ?? "", database, sslMode },
            notes,
            ignored,
        },
    };
}

/** `host=… port=… dbname=… user=… password='a b'`: values may be single-quoted, with \' and \\ as escapes. */
function parseKeyValue(text: string): ConnectionStringResult {
    const fields: Fields = {};
    const ignored: string[] = [];
    const pattern = /\s*([A-Za-z_]+)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|(\S*))/gy;
    let consumed = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        consumed = pattern.lastIndex;
        const key = match[1]!.toLowerCase();
        const value = (match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : match[3]) ?? "";
        if (!DSN_KEYS.has(key)) {
            ignored.push(key);
            continue;
        }
        if (key === "host" || key === "hostaddr") fields.host = fields.host || splitHost(value).host;
        else if (key === "dbname" || key === "database") fields.database = value;
        else if (key === "user" || key === "username") fields.username = value;
        else if (key === "ssl") fields.sslmode = /^(1|true|yes|on)$/i.test(value) ? "require" : "disable";
        else fields[key as keyof Fields] = value;
    }
    if (text.slice(consumed).trim()) return { ok: false, reason: "Could not read that as host=… port=… dbname=… user=… password=…." };
    return build(fields, ignored);
}

/** URL parameters that libpq lets stand in for parts of the URL. */
const QUERY_FIELDS: Record<string, keyof Fields> = {
    host: "host",
    hostaddr: "host",
    port: "port",
    dbname: "database",
    user: "username",
    password: "password",
    sslmode: "sslmode",
};

function parseUrl(text: string): ConnectionStringResult {
    const match = text.match(/^(?:jdbc:)?([a-z][a-z0-9+.-]*):\/\/(.*)$/is);
    if (!match) return { ok: false, reason: "That is not a connection string." };
    const scheme = match[1]!.toLowerCase();
    if (!POSTGRES_SCHEMES.has(scheme)) {
        return { ok: false, reason: `This is a ${scheme} connection string. Only PostgreSQL is supported here; start with postgres:// or postgresql://.` };
    }

    // Everything up to the last "@" is the user and password, so an unescaped "/" or "?" in a password still works.
    let rest = match[2]!.replace(/#.*$/s, "");
    const at = rest.lastIndexOf("@");
    const userinfo = at === -1 ? "" : rest.slice(0, at);
    rest = at === -1 ? rest : rest.slice(at + 1);

    const queryStart = rest.indexOf("?");
    const query = queryStart === -1 ? "" : rest.slice(queryStart + 1);
    const beforeQuery = queryStart === -1 ? rest : rest.slice(0, queryStart);
    const slash = beforeQuery.indexOf("/");
    const hostPart = slash === -1 ? beforeQuery : beforeQuery.slice(0, slash);
    const path = slash === -1 ? "" : beforeQuery.slice(slash + 1);

    const hostAndPort = splitHost(hostPart);

    const fields: Fields = { host: hostAndPort.host, port: hostAndPort.port, database: decode(path.split("/")[0] ?? "") };
    if (userinfo) {
        const colon = userinfo.indexOf(":");
        fields.username = decode(colon === -1 ? userinfo : userinfo.slice(0, colon));
        if (colon !== -1) fields.password = decode(userinfo.slice(colon + 1));
    }

    const ignored: string[] = [];
    for (const pair of query.split("&")) {
        if (!pair) continue;
        const equals = pair.indexOf("=");
        const key = decode(equals === -1 ? pair : pair.slice(0, equals)).toLowerCase();
        const value = equals === -1 ? "" : decode(pair.slice(equals + 1));
        if (key === "ssl") fields.sslmode = /^(1|true|yes|on)$/i.test(value) ? "require" : "disable";
        else if (key in QUERY_FIELDS) {
            const target = QUERY_FIELDS[key]!;
            // The URL's own parts win over the same thing in the query, as in libpq.
            if (!fields[target]) fields[target] = key === "host" || key === "hostaddr" ? splitHost(value).host : value;
        } else ignored.push(key);
    }
    return build(fields, ignored);
}

export function parseConnectionString(text: string): ConnectionStringResult {
    const value = unwrap(text);
    if (!value) return { ok: false, reason: "Paste a connection string such as postgres://user:password@host:5432/database." };
    if (/^(jdbc:)?[a-z][a-z0-9+.-]*:\/\//i.test(value)) return parseUrl(value);
    if (/(^|\s)(host|dbname|user|password)\s*=/i.test(value)) return parseKeyValue(value);
    return { ok: false, reason: "That does not look like a connection string. Use postgres://user:password@host:5432/database." };
}
