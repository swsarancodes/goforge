import "dotenv/config";
import { createApp } from "./app.js";
import { getMasterKey } from "./crypto/vault.js";

// Fail fast at boot rather than on the first request that needs to encrypt/decrypt a password.
getMasterKey();

const port = Number(process.env.PORT) || 4000;

const app = createApp();

app.listen(port, () => {
    console.log(`goforge-api listening on :${port}`);
});
