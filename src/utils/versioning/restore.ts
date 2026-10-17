import { compare } from "fast-json-patch";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import { DBDiffOperation, mapDiffToDBDiffOperation, normalizeDatabase } from "../database";

/**
 * The operations that turn the open project into `target`, exactly: ids, positions and notes
 * included. This is the diff the app executes (unlike the one used for rendering SQL, which
 * deliberately ignores layout and notes), so a restore brings back the diagram as it was.
 */
export const restoreOperations = (current: DatabaseType, target: DatabaseType): DBDiffOperation[] =>
    mapDiffToDBDiffOperation(compare(normalizeDatabase(current), normalizeDatabase(target)));
