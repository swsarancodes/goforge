import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { compareOutput, type OutputComparison } from "@/features/query-modernizer/compare-output";
import { checkPostgresSyntax } from "@/features/query-modernizer/engine/checks";
import { applyMapping, type MappingRow } from "@/features/query-modernizer/engine/mapping-apply";
import { modernize } from "@/features/query-modernizer/modernize";
import { AiStatus, fetchAiStatus, requestQueryModernization } from "@/lib/ai-api";
import { SavedConnection, listSavedConnections } from "@/lib/live-connection-api";
import { previewQueryOnConnection, validateSqlOnConnection } from "@/lib/modernizer-api";
import { runSql } from "@/lib/sql-editor-api";
import { differingRows } from "./differences";
import { loadCheckContext } from "./context";

export interface Rows {
    columns: { name: string; dataType: string }[];
    rows: (string | null)[][];
    truncated: boolean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const hasOrderBy = (sql: string): boolean => /\border\s+by\b/i.test(sql);

/** State and actions behind the query check: the two databases, the two queries, what each returned, and how the two compare. */
export function useQueryCheck() {
    const [params, setParams] = useSearchParams();
    const [oracleDatabases, setOracleDatabases] = useState<SavedConnection[]>([]);
    const [postgresDatabases, setPostgresDatabases] = useState<SavedConnection[]>([]);
    const [loading, setLoading] = useState(true);
    const oracleId = params.get("oracle") ?? undefined;
    const postgresId = params.get("postgres") ?? undefined;

    const [mapping, setMapping] = useState<MappingRow[]>([]);
    const [oracleSql, setOracleSql] = useState("");
    const [pgSql, setPgSql] = useState("");
    const [oracleRows, setOracleRows] = useState<Rows | undefined>(undefined);
    const [pgRows, setPgRows] = useState<Rows | undefined>(undefined);
    const [comparison, setComparison] = useState<OutputComparison | undefined>(undefined);
    const [notes, setNotes] = useState<string[]>([]);
    const [ignoreOrder, setIgnoreOrder] = useState(true);
    const [busy, setBusy] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [ai, setAi] = useState<AiStatus | undefined>(undefined);
    const aiReady = Boolean(ai?.configured && ai.allowed !== false);

    const select = useCallback(
        (next: { oracle?: string; postgres?: string }) => {
            const merged = new URLSearchParams(params);
            for (const [name, value] of Object.entries(next)) if (value) merged.set(name, value);
            setParams(merged, { replace: true });
        },
        [params, setParams],
    );

    useEffect(() => {
        let current = true;
        Promise.all([listSavedConnections("oracle"), listSavedConnections()])
            .then(([oracle, postgres]) => {
                if (!current) return;
                setOracleDatabases(oracle);
                setPostgresDatabases(postgres);
            })
            .catch((caught) => current && setError(messageOf(caught)))
            .finally(() => current && setLoading(false));
        fetchAiStatus().then((status) => current && setAi(status)).catch(() => undefined);
        return () => {
            current = false;
        };
    }, []);

    // with one database of each kind there is nothing to choose
    useEffect(() => {
        if (loading) return;
        const next: { oracle?: string; postgres?: string } = {};
        if (!oracleId && oracleDatabases.length === 1) next.oracle = oracleDatabases[0].id;
        if (!postgresId && postgresDatabases.length === 1) next.postgres = postgresDatabases[0].id;
        if (next.oracle || next.postgres) select(next);
    }, [loading, oracleId, postgresId, oracleDatabases, postgresDatabases, select]);

    // a migration leaves the names it changed and a query to start from
    useEffect(() => {
        const context = postgresId ? loadCheckContext(postgresId) : undefined;
        setMapping(context?.mapping ?? []);
        if (context && !oracleSql) {
            setOracleSql(context.query);
            setIgnoreOrder(!hasOrderBy(context.query));
        }
        // only when the database changes: what the person has typed since is theirs
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [postgresId]);

    const compare = (oracle: Rows, postgres: Rows, ignore: boolean) =>
        compareOutput({ columns: oracle.columns.map((column) => column.name), rows: oracle.rows.map((row) => row.map((cell) => cell ?? "")) }, { columns: postgres.columns.map((column) => column.name), rows: postgres.rows, truncated: postgres.truncated }, { ignoreOrder: ignore });

    const runOnPostgres = async (sql: string, oracle: Rows) => {
        if (!postgresId) return;
        setBusy("Running it on PostgreSQL");
        const response = await previewQueryOnConnection(postgresId, sql);
        if (!response.ok) {
            setPgRows(undefined);
            setComparison(undefined);
            // 42P01: the table is not there, which after a migration with new names usually means the query still uses an old one
            const hint = response.error.code === "42P01" ? " If you renamed tables in the migration, write their new names in the PostgreSQL query and run it again." : "";
            setError(`PostgreSQL: ${response.error.message}.${hint}`.replace(/\.\.$/, "."));
            return;
        }
        const rows: Rows = { columns: response.result.columns, rows: response.result.rows, truncated: response.result.truncated };
        setPgRows(rows);
        setComparison(compare(oracle, rows, ignoreOrder));
    };

    const runOnOracle = async (): Promise<Rows | undefined> => {
        if (!oracleId) return undefined;
        setBusy("Running it on Oracle");
        const response = await runSql(oracleId, { sessionId: `query-check-${Date.now()}`, sql: oracleSql, transactional: false, expectOpenTransaction: false });
        if (!response.ok) {
            setError(`Oracle: ${response.error.message}`);
            return undefined;
        }
        const returned = response.results.find((candidate) => candidate.columns.length > 0);
        if (!returned) {
            setError("The query ran on Oracle but returned no rows, so there is nothing to compare.");
            return undefined;
        }
        const rows: Rows = { columns: returned.columns, rows: returned.rows, truncated: returned.truncated };
        setOracleRows(rows);
        return rows;
    };

    /** Runs the Oracle query, converts it, runs the conversion on PostgreSQL, and compares. */
    const runBoth = async () => {
        if (!oracleSql.trim() || !oracleId || !postgresId || busy) return;
        setError(undefined);
        setComparison(undefined);
        setOracleRows(undefined);
        setPgRows(undefined);
        setNotes([]);
        try {
            const oracle = await runOnOracle();
            if (!oracle) return;
            const withNames = (text: string) => (mapping.length > 0 ? applyMapping(text, mapping, "oracle").sql : text);
            const outcome = await modernize(
                { sql: oracleSql, dialect: "oracle" },
                { syntax: checkPostgresSyntax, validate: (text) => validateSqlOnConnection(postgresId, withNames(text)), ask: aiReady ? (request) => requestQueryModernization(request) : undefined, onStage: setBusy },
            );
            const mapped = mapping.length > 0 ? applyMapping(outcome.sql, mapping, "oracle") : { sql: outcome.sql, issues: [] as string[] };
            setNotes([
                outcome.source === "ai" ? `Converted by the model (${outcome.ai?.model ?? "model"}), after the rules could not finish it.` : "Converted by the rules.",
                ...outcome.engine.unconverted.map((item) => `Not converted: ${item.construct} (${item.reason})`),
                ...(outcome.aiNotice ? [outcome.aiNotice] : []),
                ...mapped.issues,
                ...(mapping.length > 0 && mapped.issues.length === 0 ? ["The tables and columns you renamed are written with their new names."] : []),
            ]);
            setPgSql(mapped.sql);
            await runOnPostgres(mapped.sql, oracle);
        } catch (caught) {
            setError(messageOf(caught));
        } finally {
            setBusy(undefined);
        }
    };

    /** Runs the PostgreSQL query as it stands (the person may have changed it) against the Oracle result already read. */
    const runPostgresOnly = async () => {
        if (!pgSql.trim() || !oracleRows || busy) return;
        setError(undefined);
        try {
            await runOnPostgres(pgSql, oracleRows);
        } catch (caught) {
            setError(messageOf(caught));
        } finally {
            setBusy(undefined);
        }
    };

    // changing the order switch compares again, with what was already read
    useEffect(() => {
        if (oracleRows && pgRows) setComparison(compare(oracleRows, pgRows, ignoreOrder));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ignoreOrder]);

    const marked = useMemo(() => (oracleRows && pgRows ? differingRows(oracleRows.rows, pgRows.rows, ignoreOrder) : undefined), [oracleRows, pgRows, ignoreOrder]);

    return {
        loading, oracleDatabases, postgresDatabases, oracleId, postgresId, select,
        oracleSql, setOracleSql, pgSql, setPgSql, oracleRows, pgRows, comparison, notes, marked,
        ignoreOrder, setIgnoreOrder, busy, error, aiReady, ai, runBoth, runPostgresOnly, mapping,
    };
}

export type QueryCheck = ReturnType<typeof useQueryCheck>;
