import React from "react";
import Modal, { ModalProps } from "@/components/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useSchemaLinter } from "@/hooks/use-schema-linter";
import { LintSeverity } from "@/utils/linter/types";
import {
    AlertCircle,
    AlertTriangle,
    Info,
    CheckCircle2,
    Wand2,
    Search,
    SlidersHorizontal,
    Sparkles,
    Loader2,
} from "lucide-react";

export const SchemaLinterModal: React.FC<ModalProps> = ({ isOpen, onOpenChange }) => {
    const {
        issues,
        summary,
        severityFilter,
        setSeverityFilter,
        categoryFilter,
        setCategoryFilter,
        searchQuery,
        setSearchQuery,
        fixIssue,
        fixAllFixable,
        isFixing,
    } = useSchemaLinter();

    const getSeverityIcon = (severity: LintSeverity) => {
        switch (severity) {
            case "error":
                return <AlertCircle className="h-4 w-4 text-destructive shrink-0" />;
            case "warning":
                return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
            case "info":
                return <Info className="h-4 w-4 text-sky-500 shrink-0" />;
        }
    };

    const getSeverityBadgeClass = (severity: LintSeverity) => {
        switch (severity) {
            case "error":
                return "bg-destructive/15 text-destructive border-destructive/30";
            case "warning":
                return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30";
            case "info":
                return "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30";
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            size="4xl"
            title="Schema Quality & Lint Studio"
            description="Autonomous structural verification, index optimization checks, and naming conventions."
        >
            <div className="flex flex-col gap-4 max-h-[75vh]">
                {/* Summary Scorecard */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 p-3 rounded-lg border bg-muted/30">
                    <div className="flex flex-col gap-0.5">
                        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Status</span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            {summary.passed ? (
                                <>
                                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                    <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">Passing</span>
                                </>
                            ) : (
                                <>
                                    <AlertCircle className="h-4 w-4 text-destructive" />
                                    <span className="text-sm font-semibold text-destructive">{summary.errors} Error(s)</span>
                                </>
                            )}
                        </div>
                    </div>

                    <button
                        onClick={() => setSeverityFilter(severityFilter === "error" ? "all" : "error")}
                        className={`flex flex-col gap-0.5 p-1.5 rounded transition-all text-left ${
                            severityFilter === "error" ? "bg-destructive/15 ring-1 ring-destructive/40" : "hover:bg-muted"
                        }`}
                    >
                        <span className="text-[11px] font-medium text-muted-foreground">Errors</span>
                        <span className="text-base font-bold text-destructive">{summary.errors}</span>
                    </button>

                    <button
                        onClick={() => setSeverityFilter(severityFilter === "warning" ? "all" : "warning")}
                        className={`flex flex-col gap-0.5 p-1.5 rounded transition-all text-left ${
                            severityFilter === "warning" ? "bg-amber-500/15 ring-1 ring-amber-500/40" : "hover:bg-muted"
                        }`}
                    >
                        <span className="text-[11px] font-medium text-muted-foreground">Warnings</span>
                        <span className="text-base font-bold text-amber-500">{summary.warnings}</span>
                    </button>

                    <button
                        onClick={() => setSeverityFilter(severityFilter === "info" ? "all" : "info")}
                        className={`flex flex-col gap-0.5 p-1.5 rounded transition-all text-left ${
                            severityFilter === "info" ? "bg-sky-500/15 ring-1 ring-sky-500/40" : "hover:bg-muted"
                        }`}
                    >
                        <span className="text-[11px] font-medium text-muted-foreground">Info</span>
                        <span className="text-base font-bold text-sky-500">{summary.info}</span>
                    </button>

                    <div className="flex flex-col gap-0.5">
                        <span className="text-[11px] font-medium text-muted-foreground">Auto-Fixable</span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <Sparkles className="h-4 w-4 text-emerald-500" />
                            <span className="text-base font-bold text-emerald-600 dark:text-emerald-400">
                                {summary.fixableCount}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Filters and Search Bar */}
                <div className="flex flex-col sm:flex-row gap-2 items-center justify-between">
                    <div className="relative w-full sm:w-72">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Filter by table, column, rule..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-8 h-9 text-xs"
                        />
                    </div>

                    <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
                        <span className="text-xs text-muted-foreground mr-1 hidden sm:inline">Category:</span>
                        {["all", "integrity", "performance", "naming", "documentation"].map((cat) => (
                            <Button
                                key={cat}
                                variant={categoryFilter === cat ? "secondary" : "ghost"}
                                size="sm"
                                onClick={() => setCategoryFilter(cat)}
                                className="h-7 text-xs capitalize px-2.5"
                            >
                                {cat}
                            </Button>
                        ))}
                    </div>
                </div>

                {/* Issues List */}
                <div className="overflow-y-auto space-y-2.5 pr-1 max-h-[46vh]">
                    {issues.length === 0 ? (
                        <div className="flex flex-col items-center justify-center p-8 border rounded-lg bg-muted/20 text-center">
                            <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-2" />
                            <h3 className="text-sm font-semibold">No Schema Issues Found</h3>
                            <p className="text-xs text-muted-foreground max-w-sm mt-1">
                                {summary.total === 0
                                    ? "Your schema passes all architectural integrity, index performance, and naming convention rules."
                                    : "No issues match your active search or severity filters."}
                            </p>
                        </div>
                    ) : (
                        issues.map((issue) => (
                            <div
                                key={issue.id}
                                className="p-3.5 rounded-lg border bg-card/60 hover:bg-card transition-all flex flex-col sm:flex-row gap-3 items-start justify-between"
                            >
                                <div className="flex gap-2.5 items-start">
                                    <div className="mt-0.5">{getSeverityIcon(issue.severity)}</div>
                                    <div className="space-y-1">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <span className="text-xs font-bold">{issue.ruleName}</span>
                                            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 uppercase ${getSeverityBadgeClass(issue.severity)}`}>
                                                {issue.severity}
                                            </Badge>
                                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                                {issue.category}
                                            </Badge>
                                            {issue.tableName && (
                                                <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                                                    {issue.tableName}
                                                    {issue.fieldName ? `.${issue.fieldName}` : ""}
                                                </Badge>
                                            )}
                                        </div>

                                        <p className="text-xs text-foreground/90 leading-relaxed">{issue.message}</p>
                                        <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                                            <span className="font-semibold text-foreground/70">Recommendation:</span>
                                            {issue.suggestion}
                                        </p>
                                    </div>
                                </div>

                                {issue.fixable && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => fixIssue(issue.id)}
                                        disabled={isFixing}
                                        className="h-7 text-xs font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10 shrink-0 self-end sm:self-center"
                                        title={issue.fixDescription}
                                    >
                                        {isFixing ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                                        ) : (
                                            <Wand2 className="h-3.5 w-3.5 mr-1 text-emerald-500" />
                                        )}
                                        Quick Fix
                                    </Button>
                                )}
                            </div>
                        ))
                    )}
                </div>

                {/* Footer Controls */}
                <div className="flex items-center justify-between border-t pt-3 mt-1">
                    <span className="text-xs text-muted-foreground">
                        Showing {issues.length} of {summary.total} issue(s)
                    </span>

                    <div className="flex items-center gap-2">
                        {summary.fixableCount > 0 && (
                            <Button
                                variant="default"
                                size="sm"
                                onClick={fixAllFixable}
                                disabled={isFixing}
                                className="h-8 gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
                            >
                                {isFixing ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Sparkles className="h-3.5 w-3.5" />
                                )}
                                Fix All Fixable ({summary.fixableCount})
                            </Button>
                        )}
                        <Button variant="outline" size="sm" onClick={() => onOpenChange?.(false)} className="h-8 text-xs">
                            Done
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
};

export default SchemaLinterModal;
