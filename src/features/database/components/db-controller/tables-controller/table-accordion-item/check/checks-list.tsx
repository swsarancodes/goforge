import { CheckConstraintType, nextCheckName } from "@/lib/schemas/check-constraint-schema";
import { useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { IconPlus } from "@tabler/icons-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { v4 } from "uuid";
import CheckItem from "./check-item";

interface ChecksListProps {
    checks: CheckConstraintType[];
    tableId: string;
    tableName: string;
}

const ChecksList: React.FC<ChecksListProps> = ({ checks, tableId, tableName }) => {
    const { t } = useTranslation();
    const { createCheck, editCheck, deleteCheck } = useDatabaseOperations();
    // A new check only exists in the UI until it has a valid expression, because an
    // empty one can never be stored (it would produce invalid DDL).
    const [draft, setDraft] = useState<{ id: string; name: string } | undefined>(undefined);

    const siblings = useMemo(() => checks.map((check) => ({ id: check.id, name: check.name })), [checks]);

    const startDraft = useCallback(() => {
        setDraft({ id: v4(), name: nextCheckName(tableName, checks) });
    }, [tableName, checks]);

    return (
        <div className="flex w-full flex-col gap-2">
            {checks.map((check) => (
                <CheckItem
                    key={check.id}
                    check={check}
                    siblings={siblings}
                    onSave={async ({ name, expression }) => { await editCheck({ id: check.id, tableId, name, expression } as CheckConstraintType); }}
                    onDelete={() => { void deleteCheck(check.id); }}
                />
            ))}
            {draft && (
                <CheckItem
                    key={draft.id}
                    isDraft
                    check={{ id: draft.id, name: draft.name, expression: "" }}
                    siblings={siblings}
                    onSave={async ({ name, expression }) => {
                        await createCheck({ id: draft.id, tableId, name, expression });
                        setDraft(undefined);
                    }}
                    onDelete={() => setDraft(undefined)}
                />
            )}
            {!draft && (
                <p className="py-1 text-muted-foreground">
                    {checks.length === 0 && <>{t("db_controller.no_checks", { defaultValue: "No check constraints" })}{" "}</>}
                    <span className="cursor-pointer text-foreground hover:underline" onClick={startDraft} role="button" data-testid="add-check">
                        {t("db_controller.add_check", { defaultValue: "add check" })} <IconPlus className="inline size-3.5 shrink-0" />
                    </span>
                </p>
            )}
        </div>
    );
};

export default React.memo(ChecksList);
