import { getOracleServer } from "./services/oracle-schemas.js";
import "dotenv/config";
import { createApp } from "./app.js";
import { getMasterKey } from "./crypto/vault.js";
import { sqlSessions } from "./services/sql-sessions.js";
import { createSqliteAiStores } from "./db/ai-store.js";
import { installAiStores } from "./ai/provider.js";
import { appDbConfigFromEnv, createPgAppDb, describeDatabaseUrl, type AppDb } from "./db/app-db.js";
import { migrate } from "./db/migrations.js";
import { createPgStores } from "./db/pg-stores.js";
import { installCloud, installConnectionStore } from "./db/stores.js";
import { adminConfigFromUrl } from "./services/cloud-databases.js";

// Fail fast at boot rather than on the first request that needs to encrypt/decrypt a password.
getMasterKey();

let appDb: AppDb | undefined;
let sweep: NodeJS.Timeout | undefined;

const dbConfig = appDbConfigFromEnv();
if (dbConfig) {
    // Cloud mode: accounts, saved connections, diagrams, AI settings and the audit log live in the Postgres database named by DATABASE_URL.
    try {
        // Schema changes go over the direct connection (a pooler in transaction mode cannot hold the migration lock).
        const direct = createPgAppDb(dbConfig.url, { max: 1 });
        try {
            const applied = await migrate(direct);
            if (applied.length > 0) console.log(`application database: applied ${applied.join(", ")}`);
        } finally {
            await direct.close();
        }
        appDb = createPgAppDb(dbConfig.poolUrl ?? dbConfig.url);
        const stores = await createPgStores(appDb);
        installConnectionStore(stores.connections);
        installAiStores({ settings: stores.settings, audit: stores.audit });
        const cloud = {
            users: stores.users,
            sessions: stores.sessions,
            projects: stores.projects,
            admin: adminConfigFromUrl(dbConfig.url),
            maxDatabasesPerUser: Number(process.env.MAX_CLOUD_DATABASES_PER_USER) || 10,
            allowSignup: process.env.ALLOW_SIGNUP === "true",
            secureCookies: process.env.COOKIE_SECURE === "true",
        };
        installCloud(cloud);
        sweep = setInterval(() => void cloud.sessions.deleteExpired().catch(() => undefined), 60 * 60 * 1000);
        sweep.unref();
        console.log(`application database: ${describeDatabaseUrl(dbConfig.url)} (accounts on, sign-up ${cloud.allowSignup ? "open" : "closed after the first account"})`);
    } catch (error) {
        console.error(`Could not start on the application database ${describeDatabaseUrl(dbConfig.url)}: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
} else {
    // Local mode: one anonymous owner, everything in the SQLite file next to the API.
    installAiStores(createSqliteAiStores());
}

// Oracle databases (schemas on the app's own Oracle server) are optional: they exist when ORACLE_ADMIN_URL is set.
try {
    const oracle = getOracleServer();
    if (oracle) console.log(`oracle server: ${oracle.admin.host}:${oracle.admin.port}/${oracle.admin.database} (a schema per Oracle database, up to ${oracle.maxSchemasPerUser} per account)`);
} catch (error) {
    console.error(`Could not read ORACLE_ADMIN_URL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

const port = Number(process.env.PORT) || 4000;

// The API can run SQL against your saved databases, so by default it only listens on this machine.
// Set HOST=0.0.0.0 to expose it (e.g. inside a container that sits behind the nginx proxy).
const host = process.env.HOST?.trim() || "127.0.0.1";

const app = createApp();

const server = app.listen(port, host, () => {
    console.log(`goforge-api listening on ${host}:${port}`);
});

// Roll back any open SQL editor transactions instead of leaving them to time out on the database.
const shutdown = () => {
    server.close();
    if (sweep) clearInterval(sweep);
    void sqlSessions.closeAll().finally(async () => {
        await appDb?.close().catch(() => undefined);
        process.exit(0);
    });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
