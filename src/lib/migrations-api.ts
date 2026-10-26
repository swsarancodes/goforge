import type { SavedConnection } from "./live-connection-api";

/** How a column's values fare: `exact` (same values, same meaning), `changed` (same values, behaves differently in queries), `risk` (information can be lost or rounded). */
export type ConversionStatus = "exact" | "changed" | "risk";

/** A query run on the Oracle data before anything is migrated, and what it counted. `count` is null when the query itself failed. */
export interface DataCheck {
    description: string;
    sql: string;
    count: number | null;
    error?: string;
}

export interface MigrationPlanColumn {
    oracleName: string;
    pgName: string;
    oracleType: string;
    pgType: string;
    nullable: boolean;
    pgDefault: string | null;
    note: { status: ConversionStatus; text: string };
    /** What the person changed on this column. */
    edited: ("name" | "type" | "default")[];
    oracleDefault: string | null;
    /** What the query on the Oracle data counted for this column's type. Absent when nothing can be lost. */
    check?: DataCheck;
}

/** What the person changed, keyed by Oracle names: `TABLE`, or `TABLE.COLUMN`. */
export interface MigrationEdits {
    tables: Record<string, { pgName?: string }>;
    columns: Record<string, { pgName?: string; pgType?: string; dropDefault?: boolean }>;
    /** Indexes and CHECK constraints to carry over, keyed `index:NAME` or `check:NAME` by their Oracle names. */
    objects: Record<string, { carry: boolean }>;
}

export const NO_EDITS: MigrationEdits = { tables: {}, columns: {}, objects: {} };

export const countEdits = (edits: MigrationEdits): number => Object.keys(edits.tables).length + Object.keys(edits.columns).length + Object.keys(edits.objects ?? {}).length;

/** What migrating an Oracle database to PostgreSQL would do, and what the server says about it. */
export interface MigrationPlanTable {
    oracleName: string;
    pgName: string;
    renamed: boolean;
    rows: number;
    oraclePrimaryKey: string[];
    columns: MigrationPlanColumn[];
}

/** An object of the Oracle schema that the migration does not create in PostgreSQL. */
export interface NotCarried {
    kind: string;
    name: string;
    detail?: string;
    /** For an index or CHECK constraint: whether the migration could carry it over if asked. Absent for the rest. */
    canCarry?: boolean;
    /** Why it cannot be carried over, when it cannot. */
    reason?: string;
}

/** An index or CHECK constraint of the schema: whether it can be carried over into PostgreSQL with the same meaning, and whether the plan does. */
export interface PlanObject {
    kind: "index" | "check";
    oracleName: string;
    pgName: string;
    table: string;
    pgTable: string;
    detail: string;
    carriable: boolean;
    reason?: string;
    carried: boolean;
    sql?: string;
}

export interface MigrationPlanPreview {
    tables: MigrationPlanTable[];
    /** What stops the migration, one line each. */
    problems: string[];
    /** Changes that were asked for and could not be made, with the reason. */
    editProblems: string[];
    notCarried: NotCarried[];
    /** Every index and CHECK constraint, carried or not. */
    objects: PlanObject[];
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

/** The approval a migration ran under: when, and the fingerprint of the report that was read. */
export interface MigrationApproval {
    reportHash: string;
    approvedAt: string;
}

export interface MigrationOutcome {
    connection: SavedConnection;
    /** Null when the migration was started without a report (not from the page). */
    approval?: MigrationApproval | null;
    tables: { name: string; rows: number }[];
    verification: TableVerification[];
    statementsRun: number;
    /** The indexes and CHECK constraints that were created, each found in PostgreSQL's catalog afterwards. */
    carried: { kind: "index" | "check"; name: string; table: string; detail: string }[];
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

export const planOracleMigration = (sourceConnectionId: string, edits: MigrationEdits = NO_EDITS): Promise<MigrationPlanPreview> => post("/oracle-to-postgres/plan", { sourceConnectionId, edits });

/** Creates the PostgreSQL database, copies the rows, checks every table against Oracle, and saves a connection. Nothing is kept if any of it fails. */
export const migrateOracleToPostgres = (input: { sourceConnectionId: string; name: string; target: MigrationTarget; edits?: MigrationEdits; acceptLoss?: boolean; approval?: { reportHash: string } }): Promise<MigrationOutcome> => post("/oracle-to-postgres", input);

/** The checks again, by queries on both databases, for an Oracle database and the PostgreSQL database it was migrated into. */
export const verifyMigration = (input: { sourceConnectionId: string; targetConnectionId: string; edits?: MigrationEdits }): Promise<{ verification: TableVerification[] }> => post("/oracle-to-postgres/verify", input);

export interface AgentAnswer {
    reply: string;
    /** What was changed, in words. */
    applied: string[];
    /** What was asked for and refused, with the reason. */
    rejected: { operation: string; reason: string }[];
    /** The edits as they stand after this answer. */
    edits: MigrationEdits;
    plan: MigrationPlanPreview;
    model: string;
}

/** Asks the assistant for the changes a message calls for. The server checks and applies them; the plan comes back built again. */
export const askMigrationAgent = (input: { sourceConnectionId: string; message: string; messages: { role: "user" | "assistant"; text: string }[]; edits: MigrationEdits }): Promise<AgentAnswer> => post("/oracle-to-postgres/agent", input);

// ---- the report a person reads before approving -------------------------------------------------------------------------------------

export type DataChangeEffect = "kept" | "reformatted" | "converted" | "dropped";

export interface DataChange {
    summary: string;
    read: string;
    load: string;
    effect: DataChangeEffect;
    status: ConversionStatus;
    notes: string[];
}

export interface ColumnFacts {
    nulls: number;
    values: number;
    affected: { label: string; count: number; sql: string }[];
}

export interface ReportSample {
    columns: string[];
    oracle: (string | null)[][];
    postgres: (string | null)[][];
    ordered: boolean;
    sql: string;
}

export interface ReportColumn {
    oracleName: string;
    pgName: string;
    oracleType: string;
    pgType: string;
    nullable: boolean;
    status: ConversionStatus;
    note: string;
    edited: ("name" | "type" | "default")[];
    oracleDefault: string | null;
    pgDefault: string | null;
    dataChange: DataChange;
    facts?: ColumnFacts;
    check?: DataCheck;
}

export interface ReportTable {
    oracleName: string;
    pgName: string;
    renamed: boolean;
    rows: number;
    primaryKey: string[];
    columns: ReportColumn[];
    sample?: ReportSample;
}

export interface ReportRename {
    kind: "table" | "column";
    table: string;
    from: string;
    to: string;
    by: "case" | "you";
}

export interface ReportDefault {
    table: string;
    column: string;
    oracleDefault: string;
    detail: string;
}

export interface ReportObject {
    kind: "index" | "check";
    name: string;
    pgName: string;
    table: string;
    pgTable: string;
    detail: string;
    sql: string;
}

export type ReportVerdict = "ready" | "needs-acceptance" | "blocked";

export interface MigrationReport {
    generatedAt: string;
    source: string;
    verdict: ReportVerdict;
    summary: {
        tables: number;
        columns: number;
        rows: number;
        exact: number;
        changed: number;
        risk: number;
        values: Record<DataChangeEffect, number>;
        changesByYou: number;
        notCarried: number;
        /** Of those left behind, how many could be carried over if asked. */
        canBeCarried: number;
        /** Indexes and CHECK constraints the plan creates. */
        carried: number;
        problems: number;
    };
    renames: ReportRename[];
    droppedDefaults: ReportDefault[];
    rewrittenDefaults: ReportDefault[];
    tables: ReportTable[];
    notCarried: NotCarried[];
    /** Indexes and CHECK constraints the person chose to carry over. */
    carried: ReportObject[];
    behaviour: string[];
    problems: string[];
    editProblems: string[];
    mustAccept: { table: string; column: string; description: string; count: number | null; sql: string; error?: string }[];
    dataRead: boolean;
    hash: string;
}

/** The report for this Oracle database and these changes: built from the plan and from reading the data (read only). No model writes any of it. */
export const fetchMigrationReport = (sourceConnectionId: string, edits: MigrationEdits = NO_EDITS): Promise<{ report: MigrationReport }> => post("/oracle-to-postgres/report", { sourceConnectionId, edits });

/** The opening paragraph of the report, written by the model from the report's figures. To be shown labelled as AI commentary. */
export const fetchReportSummary = (sourceConnectionId: string, edits: MigrationEdits = NO_EDITS): Promise<{ summary: string; model: string; reportHash: string }> => post("/oracle-to-postgres/report/summary", { sourceConnectionId, edits });

export interface ReviewFinding {
    severity: "concern" | "warning" | "note";
    /** The Oracle table and column the finding is about; null for the plan as a whole. */
    table: string | null;
    column: string | null;
    title: string;
    detail: string;
    suggestion: string | null;
}

/** What the plan reviewer said, with how many of its findings were dropped for naming something that is not in the plan. */
export interface PlanReview {
    overview: string;
    findings: ReviewFinding[];
    dropped: number;
}

/** A second opinion on the plan from a reviewer that is not the assistant. To be shown labelled as AI commentary; never part of the approval. */
export const fetchPlanReview = (sourceConnectionId: string, edits: MigrationEdits = NO_EDITS, focus?: string): Promise<{ review: PlanReview; model: string; reportHash: string }> => post("/oracle-to-postgres/review", { sourceConnectionId, edits, ...(focus ? { focus } : {}) });
