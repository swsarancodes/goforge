import { DatabaseType } from "@/lib/schemas/database-schema"; 
import { createContext } from "react";
import { DBDiffOperation } from "@/utils/database";

 

export interface DatabaseHistoryContextType {
    
    undo: () => void;
    redo: () => void;

    canUndo : boolean ; 
    canRedo : boolean ; 
    isProcessing : boolean ; 

    present : DatabaseType  ; 
    applyUndoableOperations: (operations: DBDiffOperation[], targetDatabase: DatabaseType) => Promise<void>;

}



export default createContext<DatabaseHistoryContextType>({} as DatabaseHistoryContextType);
