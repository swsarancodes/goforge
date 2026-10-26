import { defineConfig } from "vitest/config";

// Oracle Free refuses new connections (ORA-12516) when several test files open schemas on it at the same time, so with a real Oracle
// configured the files run one after the other. Without one nothing here talks to Oracle, and the files run side by side as usual.
export default defineConfig({
    test: { fileParallelism: !process.env.ORACLE_TEST_ADMIN_URL },
});
