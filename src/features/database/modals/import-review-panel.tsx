import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ObjectChangeCounts, SchemaChangeSummary } from "@/utils/import/summarize-schema-change";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

interface ImportReviewPanelProps {
    summary: SchemaChangeSummary;
    /** Operations that delete something; only a replace has any. */
    destructiveCount: number;
    accepted: boolean;
    onAcceptedChange: (accepted: boolean) => void;
}

const countsText = (label: string, counts: ObjectChangeCounts) => {
    const parts: string[] = [];
    if (counts.added) parts.push(`${counts.added} added`);
    if (counts.removed) parts.push(`${counts.removed} removed`);
    if (counts.changed) parts.push(`${counts.changed} changed`);
    return parts.length > 0 ? `${label}: ${parts.join(", ")}` : undefined;
};

/** What an import into the open project would do, shown before anything is changed. */
const ImportReviewPanel: React.FC<ImportReviewPanelProps> = ({ summary, destructiveCount, accepted, onAcceptedChange }) => {
    const { t } = useTranslation();

    if (summary.isEmpty) {
        return (
            <Alert data-testid="import-review-empty">
                <CheckCircle2 />
                <AlertTitle>{t("modals.import_project.review_empty", { defaultValue: "Nothing to change" })}</AlertTitle>
                <AlertDescription>{t("modals.import_project.review_empty_hint", { defaultValue: "The open project already matches this file." })}</AlertDescription>
            </Alert>
        );
    }

    const others = [
        countsText("Relationships", summary.relationships),
        countsText("Views", summary.views),
        countsText("Sequences", summary.sequences),
    ].filter((line): line is string => Boolean(line));

    return (
        <div className="space-y-3" data-testid="import-review">
            <div className="max-h-48 space-y-2 overflow-auto rounded-md border p-3 text-sm">
                {summary.tablesAdded.length > 0 && (
                    <p><span className="font-medium text-chart-2">Added tables</span> · {summary.tablesAdded.join(", ")}</p>
                )}
                {summary.tablesRemoved.length > 0 && (
                    <p><span className="font-medium text-destructive">Removed tables</span> · {summary.tablesRemoved.join(", ")}</p>
                )}
                {summary.tablesChanged.map((table) => (
                    <p key={table.name}><span className="font-medium">{table.name}</span> · {table.details.join(", ")}</p>
                ))}
                {others.map((line) => <p key={line}>{line}</p>)}
            </div>

            {destructiveCount > 0 && (
                <Alert variant="destructive" data-testid="import-review-destructive">
                    <AlertTriangle />
                    <AlertTitle>
                        {t("modals.import_project.review_destructive", { count: destructiveCount, defaultValue: "{{count}} deletions" })}
                    </AlertTitle>
                    <AlertDescription>
                        <p>{t("modals.import_project.review_destructive_hint", { defaultValue: "Anything the file does not mention is removed from the open project. You can undo this afterwards." })}</p>
                        <div className="mt-2 flex items-center gap-2">
                            <Switch id="import-accept-deletions" checked={accepted} onCheckedChange={onAcceptedChange} />
                            <Label htmlFor="import-accept-deletions">{t("modals.import_project.review_accept", { defaultValue: "Delete them" })}</Label>
                        </div>
                    </AlertDescription>
                </Alert>
            )}
        </div>
    );
};

export default React.memo(ImportReviewPanel);
