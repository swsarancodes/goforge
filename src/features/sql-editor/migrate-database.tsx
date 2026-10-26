import { ArrowRightLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { rememberMigrationSource } from "@/features/migration/use-migration";
import type { SqlEditor } from "./use-sql-editor";

/**
 * Migrating the open Oracle database into PostgreSQL happens on its own page: the plan as a checklist, an assistant to change it, and the
 * proof afterwards. This button opens that page on the database that is open here.
 */
export const MigrateDatabase: React.FC<{ editor: SqlEditor }> = ({ editor }) => {
    const navigate = useNavigate();
    const connection = editor.connection;
    if (!connection || connection.engine !== "oracle") return null;

    return (
        <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => {
                rememberMigrationSource(connection.id);
                navigate("/database/migrate");
            }}
            disabled={editor.isRunning}
            aria-label={`Migrate the database ${connection.name} to PostgreSQL`}
        >
            <ArrowRightLeft className="size-3.5" /> Migrate to PostgreSQL
        </Button>
    );
};
