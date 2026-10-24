import { useCallback, useState } from "react";
import Modal, { ModalProps } from "@/components/modal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircleIcon } from "lucide-react";
import useToast from "@/hooks/use-toast";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { LiveDatabaseOption, useLiveDatabase } from "../components/live-database-option";
import { liveDatabaseCreatedText } from "../live-database";

/** Builds the open diagram as a real PostgreSQL database on a saved server, and saves a connection to it. */
const CreateLiveDatabaseModal: React.FC<Omit<ModalProps, "title" | "children">> = ({ isOpen, onOpenChange }) => {
    const raise = useToast();
    const { database } = useDatabase();
    const { data_types } = useDatabaseOperations();
    const live = useLiveDatabase(database?.name, database?.dialect, { required: true });
    const [error, setError] = useState<string | undefined>(undefined);

    const hasTables = (database?.tables.length ?? 0) > 0;

    const onCreate = useCallback(async () => {
        if (!database) return;
        setError(undefined);
        try {
            const created = await live.create(database, data_types);
            onOpenChange?.(false);
            raise("Database created", liveDatabaseCreatedText(created.connection), "SUCCESS");
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [database, data_types, live, onOpenChange, raise]);

    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="Create a live database"
            description="Creates a new PostgreSQL database on a server you have saved, builds this diagram's tables in it, and saves a connection to it. Nothing is changed in the diagram."
            actionName="Create database"
            actionHandler={onCreate}
            isDisabled={!hasTables || !live.supported || !live.canCreate || Boolean(live.problem)}
            className="md:min-w-[520px] w-full"
        >
            <div className="flex flex-col gap-3">
                {!hasTables && <p className="text-sm text-muted-foreground">This diagram has no tables yet. Paste or import a schema first.</p>}
                {hasTables && <LiveDatabaseOption live={live} required className="space-y-2 text-xs" />}
                {error && (
                    <Alert variant="destructive">
                        <AlertCircleIcon />
                        <AlertTitle>Could not create the database</AlertTitle>
                        <AlertDescription>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs">{error}</pre>
                        </AlertDescription>
                    </Alert>
                )}
            </div>
        </Modal>
    );
};

export default CreateLiveDatabaseModal;
