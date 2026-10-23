import type { SavedConnection } from "./live-connection-api";

/** What migrating an Oracle database to PostgreSQL would do, and what the server says about it. */
export interface MigrationPlanTable {
    oracleName: string;
    pgName: string;
    rows: number;
    columns: { oracleName: string; pgName: string; oracleType: string; pgType: string }[];
}

export interface MigrationPlanPreview {
    tables: MigrationPlanTable[];
    /** What stops the migration, one line each. */
    problems: string[];
    statements: number;
}

export interface TableVerification {
    table: string;
    oracleRows: number;
    postgresRows: number;
    checks: number;
    mismatches: string[];
}

export interface MigrationOutcome {
    connection: SavedConnection;
    tables: { name: string; rows: number }[];
    verification: TableVerification[];
    statementsRun: number;
}

class MigrationsApiError extends Error {
    constructor(message: string, public status: number) {
        super(message);
        this.name = "MigrationsApiError";
    }
}

export type MigrationTarget = { kind: "cloud" } | { kind: "server"; connectionId: string; database?: string };

async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`/api/migrations${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) {
        let message = response.statusText || `HTTP ${response.status}`;
        try {
            const json = await response.json();
            if (typeof json?.error === "string") message = json.error;
        } catch {
            // not JSON
        }
        throw new MigrationsApiError(message, response.status);
    }
    return response.json() as Promise<T>;
}

export const planOracleMigration = (sourceConnectionId: string): Promise<MigrationPlanPreview> => post("/oracle-to-postgres/plan", { sourceConnectionId });

/** Creates the PostgreSQL database, copies the rows, checks every table against Oracle, and saves a connection. Nothing is kept if any of it fails. */
export const migrateOracleToPostgres = (input: { sourceConnectionId: string; name: string; target: MigrationTarget }): Promise<MigrationOutcome> => post("/oracle-to-postgres", input);
