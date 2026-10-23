import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { setSqlHandoff } from "./handoff";

/** Returns a function that opens the SQL editor with `sql` in it ("source" says where it came from; `options.transactional: false` asks for the no-transaction mode). */
export function useOpenInSqlEditor() {
    const navigate = useNavigate();
    return useCallback(
        (sql: string, source: string, options: { transactional?: boolean } = {}) => {
            setSqlHandoff({ sql, source, ...(options.transactional === undefined ? {} : { transactional: options.transactional }) });
            navigate("/database/sql");
        },
        [navigate],
    );
}
