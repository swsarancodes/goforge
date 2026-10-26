import type { SavedConnection } from "./live-connection-api";

/** How a column's values fare: `exact` (same values, same meaning), `changed` (same values, behaves differently in queries), `risk` (information can be lost or rounded). */
export type ConversionStatus = "exact" | "changed" | "risk";

export interface MigrationPlanColumn {
    oracleName: string;
    pgName: string;
    oracleType: string;
    pgType: string;
    nullable: boolean;
    pgDefault: string | null;
    note: { status: ConversionStatus; text: string };
}

/** What migrating an Oracle database to PostgreSQL would do, and what the server says about it. */
export interface MigrationPlanTable {
    oracleName: string;
    pgName: string;
    rows: number;
    oraclePrimaryKey: string[];
    columns: MigrationPlanColumn[];
}

/** An object of the Oracle schema that the migration does not create in PostgreSQL. */
export interface NotCarried {
    kind: string;
    name: string;
    detail?: string;
}

export interface MigrationPlanPreview {
    tables: MigrationPlanTable[];
    /** What stops the migration, one line each. */
    problems: string[];
    notCarried: NotCarried[];
    /** What behaves differently in queries on the PostgreSQL side, for this schema. */
    behaviour: string[];
    statements: number;
}

/** One comparison: the expression run on each side and what each returned. */
export interface ProofCheck {
    label: string;
    oracleExpression: string;
    postgresExpression: string;
    oracle: string | null;
    postgres: string | null;
    match: boolean;
}

export interface ProofSample {
    columns: string[];
    oracleSql: string;
    postgresSql: string;
    oracleRows: (string | null)[][];
    postgresRows: (string | null)[][];
    match: boolean;
}

export interface TableProof {
    oracleSql: string;
    postgresSql: string;
    checks: ProofCheck[];
    sample?: ProofSample;
}

export interface TableVerification {
    table: string;
    oracleRows: number;
    postgresRows: number;
    checks: number;
    mismatches: string[];
    proof: TableProof;
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

/** The checks again, by queries on both databases, for an Oracle database and the PostgreSQL database it was migrated into. */
export const verifyMigration = (input: { sourceConnectionId: string; targetConnectionId: string }): Promise<{ verification: TableVerification[] }> => post("/oracle-to-postgres/verify", input);
