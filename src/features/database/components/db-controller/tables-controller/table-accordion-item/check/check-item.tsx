import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CheckConstraintType, validateCheck } from "@/lib/schemas/check-constraint-schema";
import { cn } from "@/lib/utils";
import { IconCheck, IconTrash, IconX } from "@tabler/icons-react";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface CheckItemProps {
    /** A stored check (edits autosave on blur) or a draft that is saved explicitly. */
    check: Pick<CheckConstraintType, "id" | "name" | "expression">;
    siblings: { id: string; name: string }[];
    isDraft?: boolean;
    onSave: (values: { name: string; expression: string }) => Promise<void>;
    onDelete: () => void;
}

const CheckItem: React.FC<CheckItemProps> = ({ check, siblings, isDraft = false, onSave, onDelete }) => {
    const { t } = useTranslation();
    const [name, setName] = useState(check.name);
    const [expression, setExpression] = useState(check.expression);
    const [error, setError] = useState<string | undefined>(undefined);

    // Pick up changes made elsewhere (undo/redo, SQL edits) unless the user is mid-edit.
    useEffect(() => { setName(check.name); }, [check.name]);
    useEffect(() => { setExpression(check.expression); }, [check.expression]);

    const commit = useCallback(async () => {
        const problem = validateCheck({ id: check.id, name, expression }, siblings);
        if (problem) {
            // An untouched draft is not an error yet - the user may still be typing.
            if (!(isDraft && !expression.trim())) setError(problem);
            return;
        }
        if (!isDraft && name.trim() === check.name && expression.trim() === check.expression) {
            setError(undefined);
            return;
        }
        try {
            await onSave({ name: name.trim(), expression: expression.trim() });
            setError(undefined);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [check.id, check.name, check.expression, name, expression, siblings, isDraft, onSave]);

    const revert = () => {
        setName(check.name);
        setExpression(check.expression);
        setError(undefined);
    };

    return (
        <div className="flex flex-col gap-1.5 rounded-md border bg-secondary/40 p-2 dark:bg-card" data-testid="check-item">
            <div className="flex items-center gap-1.5">
                <Input
                    aria-label={t("db_controller.check_name", { defaultValue: "Check name" })}
                    placeholder={t("db_controller.check_name", { defaultValue: "Check name" })}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onBlur={isDraft ? undefined : commit}
                    className="h-8 flex-1 font-mono text-xs"
                />
                {isDraft && (
                    <Button size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-foreground" onClick={commit} aria-label={t("db_controller.save_check", { defaultValue: "Save check" })}>
                        <IconCheck className="size-4" />
                    </Button>
                )}
                <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    onClick={onDelete}
                    aria-label={isDraft ? t("db_controller.cancel", { defaultValue: "Cancel" }) : t("db_controller.delete_check", { defaultValue: "Delete check" })}
                >
                    {isDraft ? <IconX className="size-4" /> : <IconTrash className="size-4" />}
                </Button>
            </div>
            <Textarea
                aria-label={t("db_controller.check_expression", { defaultValue: "Check expression" })}
                placeholder={t("db_controller.check_expression_placeholder", { defaultValue: "e.g. price > 0 AND status IN ('open','closed')" })}
                value={expression}
                rows={2}
                spellCheck={false}
                onChange={(event) => setExpression(event.target.value)}
                onBlur={isDraft ? undefined : commit}
                onKeyDown={(event) => {
                    if (event.key === "Escape") revert();
                    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void commit(); }
                }}
                className={cn("min-h-[56px] resize-none bg-background font-mono text-xs focus-visible:ring-0", error && "border-destructive")}
            />
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </div>
    );
};

export default React.memo(CheckItem);
