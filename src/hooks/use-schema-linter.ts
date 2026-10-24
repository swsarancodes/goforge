import { useCallback, useMemo, useState } from "react";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { useVersionHistoryActions } from "@/hooks/use-version-history";
import { SchemaLinter } from "@/utils/linter/linter";
import { LintIssue, LintResult, LintSeverity, LinterOptions } from "@/utils/linter/types";
import { getRenderer } from "@/utils/render/render-uttils";
import useToast from "@/hooks/use-toast";

export const useSchemaLinter = (initialOptions?: LinterOptions) => {
    const { database } = useDatabase();
    const { data_types } = useDatabaseOperations();
    const { applyRecorded } = useVersionHistoryActions();
    const raise = useToast();

    const [options, setOptions] = useState<LinterOptions>(initialOptions ?? {
        namingConvention: "snake_case",
        checkDocumentation: true,
        disabledRules: [],
        severityOverrides: {},
    });

    const [severityFilter, setSeverityFilter] = useState<LintSeverity | "all">("all");
    const [categoryFilter, setCategoryFilter] = useState<string | "all">("all");
    const [searchQuery, setSearchQuery] = useState<string>("");
    const [isFixing, setIsFixing] = useState<boolean>(false);

    const linter = useMemo(() => new SchemaLinter(options), [options]);

    const result: LintResult = useMemo(() => {
        if (!database) {
            return {
                issues: [],
                summary: { total: 0, errors: 0, warnings: 0, info: 0, fixableCount: 0, passed: true },
                timestamp: new Date().toISOString(),
            };
        }
        return linter.lint(database);
    }, [database, linter]);

    const filteredIssues = useMemo(() => {
        return result.issues.filter((issue) => {
            if (severityFilter !== "all" && issue.severity !== severityFilter) return false;
            if (categoryFilter !== "all" && issue.category !== categoryFilter) return false;
            if (searchQuery.trim()) {
                const query = searchQuery.toLowerCase();
                const matchesMessage = issue.message.toLowerCase().includes(query);
                const matchesTable = issue.tableName?.toLowerCase().includes(query);
                const matchesField = issue.fieldName?.toLowerCase().includes(query);
                const matchesRule = issue.ruleName.toLowerCase().includes(query);
                if (!matchesMessage && !matchesTable && !matchesField && !matchesRule) return false;
            }
            return true;
        });
    }, [result.issues, severityFilter, categoryFilter, searchQuery]);

    const fixIssue = useCallback(async (issueId: string) => {
        if (!database) return;
        setIsFixing(true);
        try {
            const targetIssue = result.issues.find(i => i.id === issueId);
            if (!targetIssue || !targetIssue.fix) {
                raise("Cannot fix", "This issue cannot be automatically fixed.", "ERROR");
                return;
            }

            const updatedDatabase = targetIssue.fix(database);
            const renderer = getRenderer(database.dialect, data_types);
            if (!renderer) throw new Error("Could not initialize SQL renderer.");

            const ops = renderer.prepareDiff(updatedDatabase, database);
            if (ops.length === 0) {
                raise("No changes", "No schema diff was generated.", "INFO");
                return;
            }

            await applyRecorded(ops, {
                name: `Linter Fix: ${targetIssue.ruleName} (${targetIssue.tableName ?? targetIssue.targetId})`,
                origin: "manual",
            });

            raise("Issue Fixed", targetIssue.fixDescription ?? targetIssue.ruleName, "SUCCESS");
        } catch (error) {
            raise("Auto-fix Failed", error instanceof Error ? error.message : String(error), "ERROR");
        } finally {
            setIsFixing(false);
        }
    }, [database, data_types, result.issues, applyRecorded, raise]);

    const fixAllFixable = useCallback(async () => {
        if (!database) return;
        setIsFixing(true);
        try {
            const { database: fixedDb, appliedCount } = linter.applyAllFixes(database);
            if (appliedCount === 0) {
                raise("Nothing to fix", "No automated fixes are currently available.", "INFO");
                return;
            }

            const renderer = getRenderer(database.dialect, data_types);
            if (!renderer) throw new Error("Could not initialize SQL renderer.");

            const ops = renderer.prepareDiff(fixedDb, database);
            if (ops.length === 0) {
                raise("No changes", "No schema diff was generated.", "INFO");
                return;
            }

            await applyRecorded(ops, {
                name: `Linter: Bulk Fixed ${appliedCount} Issue(s)`,
                origin: "manual",
            });

            raise("Bulk Fix Complete", `Successfully resolved ${appliedCount} issue(s) across the schema.`, "SUCCESS");
        } catch (error) {
            raise("Bulk Fix Failed", error instanceof Error ? error.message : String(error), "ERROR");
        } finally {
            setIsFixing(false);
        }
    }, [database, data_types, linter, applyRecorded, raise]);

    return {
        result,
        issues: filteredIssues,
        summary: result.summary,
        options,
        setOptions,
        severityFilter,
        setSeverityFilter,
        categoryFilter,
        setCategoryFilter,
        searchQuery,
        setSearchQuery,
        fixIssue,
        fixAllFixable,
        isFixing,
    };
};
