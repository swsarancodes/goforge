import "dotenv/config";
import { appDbConfigFromEnv, createPgAppDb, describeDatabaseUrl } from "../db/app-db.js";
import { importLocalConnections } from "../db/import-local.js";
import { migrate } from "../db/migrations.js";
import { createPgConnectionStore, createPgUserStore } from "../db/pg-stores.js";
import { getDb, listConnections } from "../db/store.js";

/**
 * npm --prefix server run import:local -- you@example.com
 *
 * Copies the connections saved in the local SQLite file (the ones you made before switching to the Postgres application database) to that
 * account. Passwords are copied still encrypted; MASTER_KEY must be the one that encrypted them.
 */
const email = process.argv[2]?.trim();
const config = appDbConfigFromEnv();
if (!email || !config) {
    console.error(`Usage: npm --prefix server run import:local -- <account email>\nDATABASE_URL must be set (in server/.env or the environment).${config ? "" : " It is not."}`);
    process.exit(1);
}

const db = createPgAppDb(config.url, { max: 2 });
try {
    await migrate(db);
    const user = await createPgUserStore(db).findByEmail(email);
    if (!user) {
        console.error(`No account with the email ${email} on ${describeDatabaseUrl(config.url)}. Sign up in the app first.`);
        process.exit(1);
    }
    const rows = listConnections();
    const { imported, skipped } = await importLocalConnections(rows, createPgConnectionStore(db), user.id);
    console.log(`${rows.length} saved connection${rows.length === 1 ? "" : "s"} in ${process.env.SQLITE_PATH || "./data/connections.db"}: ${imported.length} copied to ${email}${skipped.length ? `, ${skipped.length} already there` : ""}.`);
    for (const name of imported) console.log(`  + ${name}`);
} finally {
    await db.close();
    getDb().close();
}
