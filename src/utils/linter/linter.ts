import { DatabaseType } from "@/lib/schemas/database-schema";
import { LintIssue, LintResult, LintSummary, LinterOptions } from "./types";
import {
    checkMissingPrimaryKey,
    checkUnindexedForeignKeys,
    checkReservedKeywordCollisions,
    checkNamingConventions,
    checkRedundantIndexes,
    checkMissingDocumentation,
} from "./rules";

export class SchemaLinter {
    private options: LinterOptions;

    constructor(options: LinterOptions = {}) {
        this.options = {
            namingConvention: "snake_case",
            checkDocumentation: true,
            disabledRules: [],
            severityOverrides: {},
            ...options,
        };
    }

    public lint(database: DatabaseType): LintResult {
        const issues: LintIssue[] = [];
        const disabled = new Set(this.options.disabledRules ?? []);

        if (!disabled.has("require-primary-key")) {
            issues.push(...checkMissingPrimaryKey(database, this.options));
        }

        if (!disabled.has("unindexed-foreign-key")) {
            issues.push(...checkUnindexedForeignKeys(database, this.options));
        }

        if (!disabled.has("reserved-keyword-collision")) {
            issues.push(...checkReservedKeywordCollisions(database, this.options));
        }

        if (!disabled.has("table-naming-convention") || !disabled.has("column-naming-convention")) {
            const namingIssues = checkNamingConventions(database, this.options);
            issues.push(...namingIssues.filter(i => !disabled.has(i.ruleId)));
        }

        if (!disabled.has("redundant-index")) {
            issues.push(...checkRedundantIndexes(database, this.options));
        }

        if (!disabled.has("missing-documentation")) {
            issues.push(...checkMissingDocumentation(database, this.options));
        }

        const summary: LintSummary = {
            total: issues.length,
            errors: issues.filter(i => i.severity === "error").length,
            warnings: issues.filter(i => i.severity === "warning").length,
            info: issues.filter(i => i.severity === "info").length,
            fixableCount: issues.filter(i => i.fixable).length,
            passed: issues.filter(i => i.severity === "error").length === 0,
        };

        return {
            issues,
            summary,
            timestamp: new Date().toISOString(),
        };
    }

    /** Applies an automated fix for a specific issue and returns the updated DatabaseType */
    public applyFix(database: DatabaseType, issueId: string): DatabaseType {
        const result = this.lint(database);
        const issue = result.issues.find(i => i.id === issueId);
        if (!issue || !issue.fixable || !issue.fix) {
            throw new Error(`Issue ${issueId} is not fixable or does not exist.`);
        }
        return issue.fix(database);
    }

    /** Applies all automated fixes sequentially and returns the updated DatabaseType */
    public applyAllFixes(database: DatabaseType): { database: DatabaseType; appliedCount: number } {
        let current = database;
        let appliedCount = 0;
        let iterations = 0;
        const maxIterations = 5;

        while (iterations < maxIterations) {
            iterations++;
            const result = this.lint(current);
            const fixableIssues = result.issues.filter(i => i.fixable && i.fix);
            if (fixableIssues.length === 0) break;

            for (const issue of fixableIssues) {
                if (issue.fix) {
                    current = issue.fix(current);
                    appliedCount++;
                }
            }
        }

        return { database: current, appliedCount };
    }
}

/** Standalone convenience helper */
export function lintSchema(database: DatabaseType, options?: LinterOptions): LintResult {
    const linter = new SchemaLinter(options);
    return linter.lint(database);
}
