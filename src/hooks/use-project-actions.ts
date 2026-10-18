import useToast from "@/hooks/use-toast";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { toDbml } from "@/utils/dbml/to-dbml";
import { toDrawio } from "@/utils/drawio/to-drawio";
import { downloadTextFile, toSafeFileName } from "@/utils/file";
import { parseProjectFile, projectToBundle, serializeProject } from "@/utils/project-file";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { v4 } from "uuid";

/** Whole-project actions that do not need a dialog: download a backup, or copy the project. */
const useProjectActions = () => {
    const { t } = useTranslation();
    const raise = useToast();
    const { database } = useDatabase();
    const { importProject, switchDatabase } = useDatabaseOperations();

    const exportProject = useCallback(() => {
        if (!database) return;
        const file = serializeProject(database);
        downloadTextFile(JSON.stringify(file, null, 2), `${toSafeFileName(database.name)}.goforge.json`, "application/json");
    }, [database]);

    const exportDbml = useCallback(() => {
        if (!database) return;
        const { dbml, warnings } = toDbml(database);
        downloadTextFile(dbml, `${toSafeFileName(database.name)}.dbml`, "text/plain");
        if (warnings.length > 0) {
            const shown = warnings.slice(0, 3).map((warning) => warning.message).join(" ");
            raise(
                t("export.dbml_warnings", { count: warnings.length, defaultValue: "DBML exported, {{count}} things left out" }),
                warnings.length > 3 ? `${shown} …and ${warnings.length - 3} more.` : shown,
                "INFO",
            );
        }
    }, [database, raise, t]);

    const exportDrawio = useCallback(() => {
        if (!database) return;
        const { xml, warnings } = toDrawio(database);
        downloadTextFile(xml, `${toSafeFileName(database.name)}.drawio`, "application/xml");
        if (warnings.length > 0) {
            const shown = warnings.slice(0, 3).map((warning) => warning.message).join(" ");
            raise(
                t("export.drawio_warnings", { count: warnings.length, defaultValue: "Draw.io exported, {{count}} warnings" }),
                warnings.length > 3 ? `${shown} …and ${warnings.length - 3} more.` : shown,
                "INFO",
            );
        } else {
            raise(
                t("export.drawio_success", { defaultValue: "Draw.io diagram exported" }),
                `${database.name}.drawio`,
                "SUCCESS",
            );
        }
    }, [database, raise, t]);

    const duplicateProject = useCallback(async () => {
        if (!database) return;
        try {
            // Round-tripping through the file format means a copy and an import share one code path.
            const file = parseProjectFile(JSON.stringify(serializeProject(database)));
            const copyName = t("project.copy_name", { name: database.name, defaultValue: "{{name}} (copy)" });
            const newId = await importProject(projectToBundle(file, v4, copyName));
            switchDatabase(newId);
            raise(
                t("project.duplicated", { defaultValue: "Project duplicated" }),
                copyName,
                "SUCCESS",
            );
        } catch (error) {
            raise(
                t("project.duplicate_failed", { defaultValue: "Could not duplicate the project" }),
                error instanceof Error ? error.message : String(error),
                "ERROR",
            );
        }
    }, [database, importProject, switchDatabase, raise, t]);

    return { exportProject, exportDbml, exportDrawio, duplicateProject };
};

export default useProjectActions;

