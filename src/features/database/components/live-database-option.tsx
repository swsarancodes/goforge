import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatabaseDialect } from "@/lib/database";
import type { DataType } from "@/lib/schemas/data-type-schema";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import { SavedConnection, connectionAddress, connectionLabel, createCloudDatabase, createLiveDatabase, createOracleDatabase, getOracleStatus, listSavedConnections } from "@/lib/live-connection-api";
import { useAuth } from "@/providers/auth-provider/auth-provider";
import { rememberDataConnection } from "@/features/data-browser/use-data-browser";
import { canCreateLiveDatabase, isValidDatabaseName, liveSchemaSql, oracleSchemaSql, readLivePreference, rememberConnectionOnPages, rememberSqlConnection, suggestDatabaseName, writeLivePreference } from "../live-database";

/** The choice in the server picker that means "on the GoForge server, for my account" rather than one of the saved servers. */
export const CLOUD_SERVER = "cloud";

/** What the live database is created in: PostgreSQL (the default, on a saved server or GoForge cloud) or Oracle (on GoForge's Oracle server). */
export type LiveEngine = "postgres" | "oracle";

const ENGINE_KEY = "goforge.liveDatabase.engine";
const readEngine = (): LiveEngine | undefined => {
    try {
        const value = localStorage.getItem(ENGINE_KEY);
        return value === "oracle" || value === "postgres" ? value : undefined;
    } catch {
        return undefined;
    }
};

export interface LiveDatabaseState {
    /** What it will be created in. An Oracle diagram can go to either; any other diagram only to PostgreSQL. */
    engine: LiveEngine;
    setEngine: (value: LiveEngine) => void;
    /** This server can create Oracle databases (ORACLE_ADMIN_URL is set) and the diagram is Oracle. */
    oracleAvailable: boolean;
    /** There is somewhere to create it: a server or the cloud for PostgreSQL, the Oracle server for Oracle. */
    canCreate: boolean;
    /** The saved servers a database can be created on (not the databases GoForge made itself). */
    connections: SavedConnection[];
    /** The account may create databases on the GoForge server. */
    cloudAvailable: boolean;
    loaded: boolean;
    /** PostgreSQL schemas, and Oracle schemas (converted to PostgreSQL), can be created as a live database. */
    supported: boolean;
    /** The diagram is Oracle: the live database is its PostgreSQL conversion. */
    converts: boolean;
    enabled: boolean;
    setEnabled: (value: boolean) => void;
    connectionId: string;
    setConnectionId: (value: string) => void;
    database: string;
    setDatabase: (value: string) => void;
    /** What stops it from being created, in words; undefined when it can go ahead (or is switched off). */
    problem: string | undefined;
    /** On, supported, and complete: applying should also create the database. */
    active: boolean;
    /** Builds `target` in a new database on the chosen server, saves the connection, and points the other pages at it. */
    create: (target: DatabaseType, dataTypes: DataType[]) => Promise<{ connection: SavedConnection; statementsRun: number }>;
}

/**
 * The choice "also create this as a live database": which server, what name, and whether at all. The switch and the server are
 * remembered between visits; the name follows the diagram's name until it is edited.
 */
export function useLiveDatabase(diagramName: string | undefined, dialect: DatabaseDialect | undefined, options: { required?: boolean } = {}): LiveDatabaseState {
    const required = options.required === true;
    const auth = useAuth();
    const cloudQuota = auth.status === "signed-in" ? auth.cloudDatabases : undefined;
    const cloudAvailable = cloudQuota !== undefined;
    const [connections, setConnections] = useState<SavedConnection[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [oracle, setOracle] = useState<{ configured: boolean; limit?: number; used?: number }>({ configured: false });
    const [engineChoice, setEngineChoice] = useState<LiveEngine | undefined>(() => readEngine());
    const [enabledChoice, setEnabledState] = useState(false);
    const [connectionId, setConnectionIdState] = useState("");
    const [database, setDatabaseState] = useState(() => suggestDatabaseName(diagramName));
    const editedName = useRef(false);

    useEffect(() => {
        let current = true;
        listSavedConnections()
            .then((all) => {
                if (!current) return;
                const preference = readLivePreference();
                // A database GoForge made is not a server to make more databases on: that would sidestep the account's limit.
                const list = all.filter((connection) => connection.kind !== "cloud");
                setConnections(list);
                const wantsCloud = preference?.connectionId === CLOUD_SERVER || (!preference?.connectionId && cloudAvailable);
                setConnectionIdState(wantsCloud && cloudAvailable ? CLOUD_SERVER : (list.find((connection) => connection.id === preference?.connectionId)?.id ?? list[0]?.id ?? (cloudAvailable ? CLOUD_SERVER : "")));
                setEnabledState((list.length > 0 || cloudAvailable) && preference?.enabled !== false);
            })
            .catch(() => current && setConnections([]))
            .finally(() => current && setLoaded(true));
        return () => {
            current = false;
        };
        // The quota arrives with the session; the list is read once.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cloudAvailable]);

    useEffect(() => {
        if (!editedName.current) setDatabaseState(suggestDatabaseName(diagramName));
    }, [diagramName]);

    // Only an Oracle diagram can go to Oracle, so only then is the Oracle server asked about.
    useEffect(() => {
        if (dialect !== DatabaseDialect.ORACLE) return;
        let current = true;
        getOracleStatus()
            .then((status) => {
                if (!current) return;
                setOracle(status);
                // Pasting Oracle SQL is what this is for: with an Oracle server available the switch starts on, unless it was turned off before.
                if (status.configured && readLivePreference()?.enabled !== false) setEnabledState(true);
            })
            .catch(() => undefined);
        return () => {
            current = false;
        };
    }, [dialect]);

    const oracleAvailable = dialect === DatabaseDialect.ORACLE && oracle.configured;
    // An Oracle diagram goes to Oracle by default when the server has one: that is what pasting Oracle SQL is for.
    const engine: LiveEngine = oracleAvailable ? (engineChoice ?? "oracle") : "postgres";
    const setEngine = useCallback((value: LiveEngine) => {
        setEngineChoice(value);
        try {
            localStorage.setItem(ENGINE_KEY, value);
        } catch {
            // not remembered
        }
    }, []);

    // Asked for outright (a menu entry whose whole point is creating one), the switch is on and its remembered state is left alone.
    const enabled = required || enabledChoice;
    const setEnabled = useCallback((value: boolean) => {
        if (required) return;
        setEnabledState(value);
        writeLivePreference({ enabled: value, connectionId: connectionId || undefined });
    }, [connectionId, required]);
    const setConnectionId = useCallback((value: string) => {
        setConnectionIdState(value);
        writeLivePreference({ enabled: enabledChoice, connectionId: value });
    }, [enabledChoice]);
    const setDatabase = useCallback((value: string) => {
        editedName.current = true;
        setDatabaseState(value.trim());
    }, []);

    const supported = canCreateLiveDatabase(dialect);
    const converts = dialect === DatabaseDialect.ORACLE && engine === "postgres";
    const oracleFull = oracle.limit !== undefined && (oracle.used ?? 0) >= oracle.limit;
    const canCreate = engine === "oracle" ? oracleAvailable : connections.length > 0 || cloudAvailable;
    const problem = useMemo(() => {
        if (!enabled || !supported) return undefined;
        if (engine === "oracle") {
            if (oracleFull) return `You already have ${oracle.used} Oracle databases, the limit on this server. Delete one from the SQL page, or create it in PostgreSQL.`;
            if (database.trim().length === 0 || database.length > 60) return "Give the database a name of up to 60 characters.";
            return undefined;
        }
        if (!connectionId) return "Pick the server to create it on.";
        if (connectionId === CLOUD_SERVER && cloudQuota && cloudQuota.used >= cloudQuota.limit) return `You already have ${cloudQuota.used} cloud databases, the limit on this server. Delete one, or pick another server.`;
        if (!isValidDatabaseName(database)) return "A database name uses letters, digits and underscores, starts with a letter or underscore, and is at most 63 characters.";
        return undefined;
    }, [enabled, supported, engine, oracleFull, oracle.used, connectionId, database, cloudQuota]);
    const active = enabled && supported && !problem && canCreate;

    const create = useCallback(async (target: DatabaseType, dataTypes: DataType[]) => {
        if (engine === "oracle") {
            // The diagram's own Oracle DDL, run in a new schema on GoForge's Oracle server. Only the SQL page reads Oracle.
            const created = await createOracleDatabase({ name: database, sql: await oracleSchemaSql(target, dataTypes) });
            rememberSqlConnection(created.connection.id);
            setOracle((status) => ({ ...status, used: (status.used ?? 0) + 1 }));
            return created;
        }
        const sql = await liveSchemaSql(target, dataTypes);
        const onCloud = connectionId === CLOUD_SERVER;
        const created = onCloud ? await createCloudDatabase({ name: database, sql }) : await createLiveDatabase(connectionId, { database, name: database, sql });
        writeLivePreference({ enabled: enabledChoice || required, connectionId });
        rememberConnectionOnPages(created.connection.id);
        rememberDataConnection(created.connection.id);
        if (onCloud) await auth.refresh();
        else setConnections((list) => [created.connection, ...list]);
        return created;
    }, [engine, connectionId, database, enabledChoice, required, auth]);

    return { engine, setEngine, oracleAvailable, canCreate, connections, cloudAvailable, loaded, supported, converts, enabled, setEnabled, connectionId, setConnectionId, database, setDatabase, problem, active, create };
}

/** The switch, the server and the name for `useLiveDatabase`. Says why it is unavailable instead of hiding. */
export const LiveDatabaseOption: React.FC<{ live: LiveDatabaseState; className?: string; required?: boolean }> = ({ live, className, required = false }) => {
    if (!live.loaded) return null;

    if (!live.supported) {
        return <p className={className ?? "text-xs text-muted-foreground"}>A live database can only be created from a PostgreSQL or an Oracle diagram.</p>;
    }
    if (!live.canCreate) {
        return (
            <p className={className ?? "text-xs text-muted-foreground"}>
                {live.engine === "oracle" ? "This server has no Oracle database to create it on." : "To also create this as a live database, save a PostgreSQL server first (File → Connect to a database)."}
            </p>
        );
    }

    return (
        <div className={className ?? "space-y-2 rounded-md border bg-background/70 p-2 text-xs"} data-testid="live-database-option">
            {!required && (
                <label htmlFor="live-database-switch" className="flex cursor-pointer items-start gap-2">
                    <Switch id="live-database-switch" checked={live.enabled} onCheckedChange={live.setEnabled} aria-label="Also create a live database" className="mt-0.5" />
                    <span>
                        <strong className="block">{live.engine === "oracle" ? "Also create it as an Oracle database" : "Also create it as a live PostgreSQL database"}</strong>
                        <span className="text-muted-foreground">
                            {live.engine === "oracle"
                                ? "A real Oracle database (its own schema) is created on GoForge's Oracle server, the tables are built in it, and you can run Oracle SQL on it under SQL."
                                : "A real database is created on the server you pick, the schema is built in it, and it appears under Data, Modernizer, Schema Change and SQL."}
                        </span>
                    </span>
                </label>
            )}
            {live.enabled && live.oracleAvailable && (
                <div className="min-w-0 space-y-1">
                    <label htmlFor="live-database-engine" className="text-[11px] text-muted-foreground">Create it in</label>
                    <Select value={live.engine} onValueChange={(value) => live.setEngine(value as LiveEngine)}>
                        <SelectTrigger id="live-database-engine" size="sm" className="h-8 w-full min-w-0" aria-label="Database to create"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="oracle">Oracle (GoForge Oracle server)</SelectItem>
                            <SelectItem value="postgres">PostgreSQL (the schema is converted)</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            )}
            {live.enabled && (
                <div className="grid gap-2 sm:grid-cols-2">
                    {live.engine === "postgres" && (
                    <div className="min-w-0 space-y-1">
                        <label htmlFor="live-database-server" className="text-[11px] text-muted-foreground">Server</label>
                        <Select value={live.connectionId || undefined} onValueChange={live.setConnectionId}>
                            <SelectTrigger id="live-database-server" size="sm" className="h-8 w-full min-w-0" aria-label="Server to create the database on"><SelectValue placeholder="Pick a server" /></SelectTrigger>
                            <SelectContent className="max-h-72">
                                {live.cloudAvailable && (
                                    <SelectItem value={CLOUD_SERVER}>GoForge cloud (your account)</SelectItem>
                                )}
                                {live.connections.map((connection) => (
                                    <SelectItem key={connection.id} value={connection.id} title={connectionAddress(connection)}>
                                        {connectionLabel(connection, live.connections)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    )}
                    <div className="min-w-0 space-y-1">
                        <label htmlFor="live-database-name" className="text-[11px] text-muted-foreground">New database name</label>
                        <Input id="live-database-name" value={live.database} onChange={(event) => live.setDatabase(event.target.value)} maxLength={63} autoComplete="off" spellCheck={false} className="h-8 font-mono text-xs" aria-invalid={Boolean(live.problem)} />
                    </div>
                </div>
            )}
            {live.enabled && live.converts && (
                <p className="text-muted-foreground" data-testid="live-database-conversion-note">
                    This diagram is Oracle, so the database is created in PostgreSQL: NUMBER becomes integer, bigint or numeric, VARCHAR2 becomes varchar, DATE becomes timestamp, and upper-case names become lower-case. A column that cannot be converted stops it, and says which.
                </p>
            )}
            {live.enabled && live.engine === "oracle" && !live.problem && (
                <p className="text-muted-foreground">Created on GoForge&apos;s Oracle server as a schema of its own. Only you can open it; deleting it from the SQL page deletes it for good. The Data, Modernizer and Schema Change pages work on PostgreSQL and will not list it.</p>
            )}
            {live.enabled && live.engine === "postgres" && live.connectionId === CLOUD_SERVER && !live.problem && (
                <p className="text-muted-foreground">Created on the GoForge server for your account. Only you can open it; deleting it from the connection list deletes it for good.</p>
            )}
            {live.problem && <p className="text-destructive" role="alert">{live.problem}</p>}
        </div>
    );
};
