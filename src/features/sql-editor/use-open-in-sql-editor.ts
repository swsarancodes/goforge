import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { setSqlHandoff } from "./handoff";

/** Returns a function that opens the SQL editor with `sql` in it ("source" says where it came from). */
export function useOpenInSqlEditor() {
    const navigate = useNavigate();
    return useCallback(
        (sql: string, source: string) => {
            setSqlHandoff({ sql, source });
            navigate("/database/sql");
        },
        [navigate],
    );
}
