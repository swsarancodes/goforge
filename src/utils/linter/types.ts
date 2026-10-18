import { DatabaseType } from "@/lib/schemas/database-schema";

export type LintSeverity = "error" | "warning" | "info";

export type LintCategory = "integrity" | "performance" | "naming" | "documentation";

export type LintTargetType = "database" | "table" | "field" | "relationship" | "index" | "check" | "view" | "sequence";

export interface LintIssue {
    id: string;
    ruleId: string;
    ruleName: string;
    category: LintCategory;
    severity: LintSeverity;
    targetType: LintTargetType;
    targetId: string;
    tableName?: string;
    fieldName?: string;
    message: string;
    suggestion: string;
    fixable: boolean;
    fixDescription?: string;
    fix?: (database: DatabaseType) => DatabaseType;
}

export interface LintRuleConfig {
    enabled: boolean;
    severity?: LintSeverity;
}

export interface LinterOptions {
    namingConvention?: "snake_case" | "camelCase" | "kebab-case" | "PascalCase" | "any";
    checkDocumentation?: boolean;
    disabledRules?: string[];
    severityOverrides?: Record<string, LintSeverity>;
}

export interface LintSummary {
    total: number;
    errors: number;
    warnings: number;
    info: number;
    fixableCount: number;
    passed: boolean;
}

export interface LintResult {
    issues: LintIssue[];
    summary: LintSummary;
    timestamp: string;
}
