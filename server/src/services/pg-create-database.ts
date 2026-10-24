import type { Client } from "pg";
import { withPgClient, type ConnectionConfig } from "./pg-client.js";
import { splitStatements } from "./sql-utils.js";

/** A PostgreSQL database name this API will create: letters, digits and underscores, not starting with a digit. */
export const DATABASE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** The server already has a database with this name. Nothing was changed. */
export class DatabaseExistsError extends Error {
    constructor(readonly database: string) {
        super(`A database named "${database}" already exists on this server. Choose another name.`);
        this.name = "DatabaseExistsError";
    }
}

/** Creating the database failed: the server refused (`permission`), the schema did not run (`schema`) or something else went wrong (`server`). */
export class CreateDatabaseError extends Error {
    constructor(
        message: string,
        readonly kind: "permission" | "schema" | "server",
    ) {
        super(message);
        this.name = "CreateDatabaseError";
    }
}

export interface CreateDatabaseDeps {
    withClient: <T>(config: ConnectionConfig, fn: (client: Client) => Promise<T>) => Promise<T>;
}

/**
 * A role that owns the new database and is the only one allowed into it. Used for databases made for people on the application's own
 * server, so that what they run in the SQL editor cannot touch anyone else's database (or the application's), unlike the server's
 * own admin role they would otherwise be connected as.
 */
export interface DatabaseOwner {
    role: string;
    /** Letters, digits, `_` and `-` only: it is written into CREATE ROLE as a literal. */
    password: string;
    connectionLimit?: number;
}

const quoteIdent = (name: string) => `"${name}"`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown) => (error as { code?: string } | undefined)?.code;

/**
 * Creates `database` on the server `config` points at, runs `sql` (a schema script) in it as one transaction, and returns how many
 * statements ran. With an `owner`, a login role with no other rights is created first and made the database's owner, and the schema is
 * built as that role. If anything fails, the transaction is rolled back and the database and role this call created are dropped again,
 * so a failed attempt leaves nothing behind. A database that already existed is never touched.
 */
export async function createDatabaseFromSql(
    config: ConnectionConfig,
    database: string,
    sql: string,
    deps: CreateDatabaseDeps = { withClient: withPgClient },
    owner?: DatabaseOwner,
): Promise<{ statementsRun: number }> {
    if (!DATABASE_NAME_PATTERN.test(database)) throw new CreateDatabaseError("A database name uses letters, digits and underscores, starts with a letter or underscore, and is at most 63 characters.", "server");
    if (owner && (!DATABASE_NAME_PATTERN.test(owner.role) || !/^[A-Za-z0-9_-]{16,}$/.test(owner.password))) throw new CreateDatabaseError("The database owner role or password is not acceptable.", "server");
    // Pieces that are only comments would run as empty statements, and a script's own BEGIN/COMMIT (the app's renderer adds them) would
    // fight the transaction opened here, which has to be the one that decides whether the schema goes in. Statements run as written.
    const TRANSACTION_CONTROL = /^(begin|start\s+transaction|commit|end)(\s+transaction|\s+work)?\s*;?$/i;
    const withoutComments = (piece: string) => piece.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "").trim();
    const statements = splitStatements(sql).filter((piece) => {
        const code = withoutComments(piece);
        return code.length > 0 && !TRANSACTION_CONTROL.test(code);
    });
    if (statements.length === 0) throw new CreateDatabaseError("There is nothing to create: the schema has no statements.", "schema");

    let createdRole = false;
    let createdDatabase = false;

    /** Removes what this call made. Reports (rather than hides) a failure to, since the leftover then needs a person. */
    const cleanUp = async (failure: CreateDatabaseError): Promise<never> => {
        const leftovers: string[] = [];
        if (createdDatabase) {
            try {
                await deps.withClient(config, (client) => client.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`));
            } catch (error) {
                leftovers.push(`the database "${database}" (${message(error)})`);
            }
        }
        if (createdRole && owner && leftovers.length === 0) {
            try {
                await deps.withClient(config, (client) => client.query(`DROP ROLE IF EXISTS ${quoteIdent(owner.role)}`));
            } catch (error) {
                leftovers.push(`the role "${owner.role}" (${message(error)})`);
            }
        }
        if (leftovers.length > 0) throw new CreateDatabaseError(`${failure.message}\nWhat was created could not be removed again: ${leftovers.join(" and ")}. Drop it by hand before retrying.`, failure.kind);
        throw failure;
    };

    try {
        await deps.withClient(config, async (client) => {
            const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
            if (exists.rowCount && exists.rowCount > 0) throw new DatabaseExistsError(database);
            if (owner) {
                const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [owner.role]);
                if (role.rowCount && role.rowCount > 0) throw new DatabaseExistsError(database);
                await client.query(
                    `CREATE ROLE ${quoteIdent(owner.role)} LOGIN PASSWORD '${owner.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT ${Math.max(1, Math.floor(owner.connectionLimit ?? 10))}`,
                );
                createdRole = true;
                // Creating a database for another role, and building the schema as it, needs this session to be allowed to become it.
                // PostgreSQL 16 spells that out; older servers grant it with a plain GRANT.
                try {
                    await client.query(`GRANT ${quoteIdent(owner.role)} TO CURRENT_USER WITH SET TRUE`);
                } catch (error) {
                    if (codeOf(error) !== "42601") throw error;
                    await client.query(`GRANT ${quoteIdent(owner.role)} TO CURRENT_USER`);
                }
            }
            await client.query(`CREATE DATABASE ${quoteIdent(database)}${owner ? ` OWNER ${quoteIdent(owner.role)}` : ""}`);
            createdDatabase = true;
            // Nobody else may connect to it, whatever their rights elsewhere.
            if (owner) await client.query(`REVOKE ALL ON DATABASE ${quoteIdent(database)} FROM PUBLIC`);
        });
    } catch (error) {
        // Thrown by the checks above, before anything was created.
        if (error instanceof DatabaseExistsError) throw error;
        if (codeOf(error) === "42P04" || codeOf(error) === "42710") {
            // Taken between the check and the create: whatever this call made (at most the role) still has to go.
            await cleanUp(new CreateDatabaseError("name taken", "server")).catch(() => undefined);
            throw new DatabaseExistsError(database);
        }
        return cleanUp(
            codeOf(error) === "42501"
                ? new CreateDatabaseError(`The role "${config.user}" is not allowed to create ${owner ? "roles and " : ""}databases on ${config.host}. Use a server whose role has ${owner ? "CREATEROLE and " : ""}CREATEDB, or pick another server.`, "permission")
                : new CreateDatabaseError(`Could not create the database on ${config.host}: ${message(error)}`, "server"),
        );
    }

    try {
        await deps.withClient({ ...config, database }, async (client) => {
            await client.query("BEGIN");
            let position = 0;
            try {
                if (owner) await client.query(`SET LOCAL ROLE ${quoteIdent(owner.role)}`);
                for (const piece of statements) {
                    position++;
                    await client.query(piece);
                }
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK").catch(() => undefined);
                throw new CreateDatabaseError(`Statement ${position} of ${statements.length} failed: ${message(error)}\n${statement(statements[position - 1])}`, "schema");
            }
        });
        return { statementsRun: statements.length };
    } catch (error) {
        return cleanUp(error instanceof CreateDatabaseError ? error : new CreateDatabaseError(`Could not build the schema in the new database: ${message(error)}`, "server"));
    }
}

/** The start of a statement, on one line, for an error message. */
const statement = (text: string | undefined): string => {
    const flat = (text ?? "").replace(/\s+/g, " ").trim();
    return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
};
