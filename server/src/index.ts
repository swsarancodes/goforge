import "dotenv/config";
import { createApp } from "./app.js";
import { getMasterKey } from "./crypto/vault.js";
import { sqlSessions } from "./services/sql-sessions.js";

// Fail fast at boot rather than on the first request that needs to encrypt/decrypt a password.
getMasterKey();

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
    void sqlSessions.closeAll().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
