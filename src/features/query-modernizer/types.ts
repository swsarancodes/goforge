export type LegacyDialect = "oracle" | "mssql" | "mysql" | "db2" | "sqlite";
export type TargetDialect = "postgresql" | "mysql" | "sqlite" | "oracle" | "mssql";

export type AgentStepId = "mapper" | "transpiler" | "validator" | "optimizer" | "judge" | "ai";
export type AgentStatus = "idle" | "running" | "success" | "warning" | "error" | "retrying";

export interface AgentTrace {
    agentId: AgentStepId;
    name: string;
    role: string;
    status: AgentStatus;
    title: string;
    details: string[];
    durationMs?: number;
    timestamp: number;
    metadata?: Record<string, unknown>;
}

export interface IndexRecommendation {
    id: string;
    tableName: string;
    columns: string[];
    unique: boolean;
    name: string;
    reason: string;
    estimatedImpact: string;
    ddl: string;
}

export interface SchemaContextTable {
    name: string;
    columns: Array<{
        name: string;
        type: string;
        isPrimary?: boolean;
        isUnique?: boolean;
    }>;
}

export interface SchemaContext {
    databaseName?: string;
    dialect?: string;
    tables: SchemaContextTable[];
}

export interface ModernizeRequest {
    legacySql: string;
    sourceDialect: LegacyDialect;
    targetDialect: TargetDialect;
    schemaContext?: SchemaContext;
    options?: {
        optimize?: boolean;
        generateIndexes?: boolean;
        aggressiveRefactor?: boolean;
    };
}

export interface ValidationReport {
    isValid: boolean;
    astErrors: string[];
    schemaWarnings: string[];
    antiPatternsDetected: string[];
    retryCount: number;
}

export interface ModernizeResponse {
    originalSql: string;
    translatedSql: string;
    optimizedSql: string;
    diff: {
        additions: number;
        deletions: number;
        patch?: string;
    };
    confidenceScore: number;
    riskLevel: "low" | "medium" | "high";
    agentTraces: AgentTrace[];
    indexRecommendations: IndexRecommendation[];
    transformationsSummary: string[];
    validationReport: ValidationReport;
    verificationSql?: string;
    /** Who produced `optimizedSql`: the built-in rules, or the language model (always checked by the rules afterwards). */
    source?: "rules" | "ai";
    aiModel?: string;
    aiSummary?: string;
    aiRisks?: string[];
    aiUnsupported?: string[];
    /** Why the AI result isn't what is shown (not configured, failed, or failed validation). */
    aiNotice?: string;
}

/** What the language model returns for one query (already validated by the server). */
export interface AiConversion {
    sql: string;
    summary: string;
    changes: string[];
    risks: string[];
    unsupported: string[];
    indexSuggestions: { tableName: string; columns: string[]; unique?: boolean; reason: string }[];
}

export interface EnterpriseSampleQuery {
    id: string;
    title: string;
    description: string;
    sourceDialect: LegacyDialect;
    targetDialect: TargetDialect;
    legacySql: string;
    highlightedChallenges: string[];
}
