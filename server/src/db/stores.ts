import type { AuditStore, SettingsStore } from "../ai/provider.js";
import type { ConnectionConfig } from "../services/pg-client.js";
import type { ConnectionRow } from "./store.js";
import { createLocalConnectionStore } from "./local-stores.js";

/**
 * What the API keeps, behind interfaces: saved connections, accounts, sessions and diagrams, plus AI settings and the audit log (those
 * two interfaces live with the AI code). Two sets of implementations exist. The local set (SQLite, one anonymous owner) is what runs
 * when no DATABASE_URL is set; the cloud set (Postgres, one owner per account) runs when it is.
 */

/** The only owner in local mode. Never a database id. */
export const LOCAL_OWNER = "local";

export type { ConnectionRow };

export interface ConnectionStore {
    insert(ownerId: string, row: ConnectionRow): Promise<void>;
    list(ownerId: string): Promise<ConnectionRow[]>;
    get(ownerId: string, id: string): Promise<ConnectionRow | undefined>;
    rename(ownerId: string, id: string, name: string): Promise<ConnectionRow | undefined>;
    delete(ownerId: string, id: string): Promise<void>;
    /** How many PostgreSQL databases this app created for the owner on its own server. */
    countCloud(ownerId: string): Promise<number>;
    /** How many databases of this engine this app created for the owner on its own servers. */
    countManaged(ownerId: string, engine: "postgres" | "oracle"): Promise<number>;
}

export interface UserRecord {
    id: string;
    email: string;
    displayName: string;
    isAdmin: boolean;
    passwordHash: string;
    createdAt: string;
}

export class EmailTakenError extends Error {
    constructor() {
        super("An account with this email already exists.");
        this.name = "EmailTakenError";
    }
}

export interface UserStore {
    count(): Promise<number>;
    /** Creates the account; the first one is created as admin by the caller. Throws `EmailTakenError`. */
    create(input: { email: string; displayName: string; passwordHash: string; isAdmin: boolean }): Promise<UserRecord>;
    findByEmail(email: string): Promise<UserRecord | undefined>;
    findById(id: string): Promise<UserRecord | undefined>;
}

export interface SessionStore {
    create(input: { tokenHash: string; userId: string; expiresAt: Date; userAgent?: string }): Promise<void>;
    /** The account this session belongs to, unless it has expired. */
    findUser(tokenHash: string): Promise<UserRecord | undefined>;
    delete(tokenHash: string): Promise<void>;
    deleteForUser(userId: string): Promise<void>;
    deleteExpired(): Promise<number>;
}

export interface ProjectSummary {
    id: string;
    name: string;
    dialect: string;
    tables: number;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface ProjectRecord extends ProjectSummary {
    /** The portable project file (`goforge-project`), exactly as the browser exported it. */
    document: unknown;
}

export interface ProjectStore {
    list(ownerId: string): Promise<ProjectSummary[]>;
    get(ownerId: string, id: string): Promise<ProjectRecord | undefined>;
    /** Creates or replaces the owner's project; undefined when the id belongs to someone else. */
    upsert(ownerId: string, input: { id: string; name: string; dialect: string; tables: number; document: unknown }): Promise<ProjectSummary | undefined>;
    delete(ownerId: string, id: string): Promise<boolean>;
}

/** Everything that only exists with a Postgres application database. */
export interface CloudServices {
    users: UserStore;
    sessions: SessionStore;
    projects: ProjectStore;
    /** The server (direct connection) on which databases for people are created. */
    admin: ConnectionConfig;
    maxDatabasesPerUser: number;
    /** Whether more accounts than the first may be created. */
    allowSignup: boolean;
    /** Marks cookies `Secure` (set when the API is served over https). */
    secureCookies: boolean;
}

let connectionStore: ConnectionStore | undefined;
let cloudServices: CloudServices | undefined;

/** The local SQLite store unless another was installed. The SQLite file is only opened when it is first used. */
export function getConnectionStore(): ConnectionStore {
    connectionStore ??= createLocalConnectionStore();
    return connectionStore;
}

export function installConnectionStore(store?: ConnectionStore): void {
    connectionStore = store;
}

export const getCloud = (): CloudServices | undefined => cloudServices;
export const isCloudMode = (): boolean => cloudServices !== undefined;

/** Installed once at boot when DATABASE_URL is set; tests install and remove their own. */
export function installCloud(services?: CloudServices): void {
    cloudServices = services;
}

export type { AuditStore, SettingsStore };
