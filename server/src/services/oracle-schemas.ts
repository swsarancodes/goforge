import { createHash, randomBytes, randomUUID } from "node:crypto";
import { encryptSecret } from "../crypto/vault.js";
import type { ConnectionRow } from "../db/stores.js";
import { withOracle } from "./oracle-client.js";
import { splitOracleScript } from "./oracle-script.js";
import type { ConnectionConfig } from "./pg-client.js";

/**
 * Oracle "databases" the app creates for people on its own Oracle server. Oracle keeps many users' objects in one database, so what a
 * person gets is a schema: a new user with its own password, a quota and no rights outside itself. The physical name carries the account's
 * id, the connection saved for it signs in as that user, and the server's own credentials never leave the API.
 */

/** The Oracle server this app creates schemas on, and how many one account may have. */
export interface OracleServer {
    admin: ConnectionConfig;
    maxSchemasPerUser: number;
}

/** `ORACLE_ADMIN_URL=oracle://user:password@host:1521/SERVICE` (the service is the pluggable database, for example FREEPDB1). */
export function oracleServerFromEnv(env: NodeJS.ProcessEnv = process.env): OracleServer | undefined {
    const url = env.ORACLE_ADMIN_URL?.trim();
    if (!url) return undefined;
    const parsed = new URL(url);
    const service = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (!parsed.hostname || !service) throw new Error("ORACLE_ADMIN_URL must look like oracle://user:password@host:1521/SERVICE.");
    return {
        admin: { host: parsed.hostname, port: parsed.port ? Number(parsed.port) : 1521, user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database: service, sslMode: "disable" },
        maxSchemasPerUser: Number(env.MAX_ORACLE_DATABASES_PER_USER) || 5,
    };
}

let installed: OracleServer | undefined | null = null;

/** The configured Oracle server, or undefined when ORACLE_ADMIN_URL is not set. Read once; tests install their own. */
export function getOracleServer(): OracleServer | undefined {
    if (installed === null) installed = oracleServerFromEnv();
    return installed;
}
export function installOracleServer(server: OracleServer | undefined | null): void {
    installed = server;
}

/** Eight hex digits that name the owner: an account id's first eight (readable in a schema list), or, for anything else (the single local owner), a hash of it. */
const ownerToken = (ownerId: string): string => (/^[0-9a-f]{8}-/i.test(ownerId) ? ownerId.replace(/-/g, "").slice(0, 8) : createHash("sha256").update(ownerId).digest("hex").slice(0, 8)).toUpperCase();

/** Oracle identifiers here are at most 30 characters, so every Oracle version accepts them. `GF_` + 8 hex + `_` leaves 18 for the name. */
export function oracleSchemaName(ownerId: string, wanted: string): string {
    const owner = ownerToken(ownerId);
    const slug =
        wanted
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "")
            .toUpperCase()
            .replace(/[^A-Z0-9_]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 18)
            .replace(/_+$/g, "") || "DATABASE";
    return `GF_${owner}_${slug}`;
}

const SCHEMA_NAME = /^GF_[0-9A-F]{8}_[A-Z0-9_]{1,18}$/;

/** Only a schema this app created is ever dropped or has SQL interpolated into a statement, whatever name a stored row claims. */
export const isOracleSchemaName = (name: string): boolean => SCHEMA_NAME.test(name);

export const PROFILE = "GOFORGE_SANDBOX";
export const QUOTA = "200M";
const GRANTS = ["CREATE SESSION", "CREATE TABLE", "CREATE VIEW", "CREATE SEQUENCE", "CREATE PROCEDURE", "CREATE TRIGGER", "CREATE TYPE", "CREATE SYNONYM"];

export class OracleSchemaError extends Error {
    constructor(
        message: string,
        public kind: "exists" | "permission" | "schema" | "server",
    ) {
        super(message);
        this.name = "OracleSchemaError";
    }
}

const oraCode = (error: unknown): number | undefined => (typeof (error as { errorNum?: unknown })?.errorNum === "number" ? (error as { errorNum: number }).errorNum : undefined);
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0];

/** Limits that apply to every schema this app creates: a few sessions, bounded work per call, idle sessions closed. Created once, on first use. */
async function ensureProfile(admin: ConnectionConfig): Promise<void> {
    await withOracle(admin, async (connection) => {
        try {
            await connection.execute(
                `CREATE PROFILE ${PROFILE} LIMIT SESSIONS_PER_USER 5 CPU_PER_CALL 6000 LOGICAL_READS_PER_CALL 5000000 IDLE_TIME 15 CONNECT_TIME 120 FAILED_LOGIN_ATTEMPTS UNLIMITED`,
            );
        } catch (error) {
            if (oraCode(error) !== 2379) throw error; // ORA-02379: profile already exists
        }
    });
}

/** A password Oracle accepts without quoting rules to think about: letters and digits only, starting with a letter. */
export const newSchemaPassword = (): string => `Gf${randomBytes(18).toString("hex")}`;

/**
 * Creates the schema's user, builds the script in it (signed in as that user, so everything it creates belongs to the schema), and returns
 * how many statements ran. If the script fails the user is dropped again, objects and all: a half-built schema is never left behind.
 */
export async function createOracleSchema(admin: ConnectionConfig, schema: string, password: string, script: string): Promise<{ statementsRun: number }> {
    if (!isOracleSchemaName(schema)) throw new OracleSchemaError(`"${schema}" is not a name this app creates.`, "schema");
    const statements = splitOracleScript(script);
    if (statements.length === 0) throw new OracleSchemaError("There is nothing to run: the schema script is empty.", "schema");

    try {
        await ensureProfile(admin);
        await withOracle(admin, async (connection) => {
            await connection.execute(`CREATE USER "${schema}" IDENTIFIED BY "${password}" DEFAULT TABLESPACE USERS QUOTA ${QUOTA} ON USERS PROFILE ${PROFILE}`);
            await connection.execute(`GRANT ${GRANTS.join(", ")} TO "${schema}"`);
        });
    } catch (error) {
        if (oraCode(error) === 1920) throw new OracleSchemaError(`A schema called ${schema} already exists.`, "exists"); // ORA-01920: user name conflicts
        if (oraCode(error) === 1031 || oraCode(error) === 1994) throw new OracleSchemaError(`The Oracle server's admin login may not create schemas: ${firstLine(error)}`, "permission");
        throw new OracleSchemaError(`Could not create the schema on the Oracle server: ${firstLine(error)}`, "server");
    }

    try {
        let run = 0;
        await withOracle({ ...admin, user: schema, password }, async (connection) => {
            for (const statement of statements) {
                try {
                    await connection.execute(statement.text, [], { autoCommit: true });
                } catch (error) {
                    throw new OracleSchemaError(`Statement ${run + 1} failed: ${firstLine(error)}\n${statement.text.slice(0, 200)}`, "schema");
                }
                run++;
            }
        });
        return { statementsRun: run };
    } catch (error) {
        await dropOracleSchema(admin, schema).catch(() => undefined);
        if (error instanceof OracleSchemaError) throw error;
        throw new OracleSchemaError(`Could not build the schema: ${firstLine(error)}`, "server");
    }
}

/** Drops a schema created by this app, with everything in it, after ending its sessions. Refuses any other name. */
export async function dropOracleSchema(admin: ConnectionConfig, schema: string): Promise<void> {
    if (!isOracleSchemaName(schema)) throw new Error(`Refusing to drop "${schema}": it is not a schema this app created.`);
    await withOracle(admin, async (connection) => {
        // A killed session lingers for a moment (ORA-01940 "currently connected"), so kill what is there and try again until the user can go.
        for (let attempt = 1; attempt <= 20; attempt++) {
            const sessions = await connection.execute<[number, number]>("SELECT sid, serial# FROM v$session WHERE username = :name", { name: schema });
            for (const [sid, serial] of sessions.rows ?? []) {
                await connection.execute(`ALTER SYSTEM KILL SESSION '${Number(sid)},${Number(serial)}' IMMEDIATE`).catch(() => undefined);
            }
            try {
                await connection.execute(`DROP USER "${schema}" CASCADE`);
                return;
            } catch (error) {
                if (oraCode(error) === 1918) return; // ORA-01918: user does not exist
                if (oraCode(error) !== 1940 || attempt === 20) throw error;
                await new Promise((done) => setTimeout(done, 500));
            }
        }
    });
}

/**
 * Ends one session of a schema this app created. The driver's call timeout interrupts a query but not everything (a PL/SQL sleep keeps
 * going until it ends), so when a run overstays, the server's admin login ends the session itself. Matched by session id AND schema, so
 * it can only ever end that schema's own session.
 */
export async function killOracleSession(admin: ConnectionConfig, schema: string, sid: number): Promise<boolean> {
    if (!isOracleSchemaName(schema)) return false;
    return withOracle(admin, async (connection) => {
        const found = await connection.execute<[number]>("SELECT serial# FROM v$session WHERE sid = :sid AND username = :name", { sid, name: schema });
        const serial = found.rows?.[0]?.[0];
        if (serial === undefined) return false;
        await connection.execute(`ALTER SYSTEM KILL SESSION '${Number(sid)},${Number(serial)}' IMMEDIATE`).catch(() => undefined);
        return true;
    });
}

/** The saved connection to a schema: the app's Oracle server, signing in as the schema's own user. The password is encrypted for the row. */
export function oracleConnectionRow(admin: ConnectionConfig, schema: string, name: string, password: string): ConnectionRow {
    const { ciphertext, iv, authTag } = encryptSecret(password);
    const now = new Date().toISOString();
    return {
        id: randomUUID(),
        name,
        host: admin.host,
        port: admin.port,
        username: schema,
        database_name: admin.database,
        ssl_mode: "disable",
        password_ciphertext: ciphertext,
        password_iv: iv,
        password_auth_tag: authTag,
        kind: "cloud",
        engine: "oracle",
        created_at: now,
        updated_at: now,
    };
}
