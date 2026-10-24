// Runs PostgreSQL (PGlite) in a worker thread so the parent can stop it. PGlite is in-process WebAssembly and ignores statement_timeout
// (measured), so the only way to put a wall-clock limit on a query is to run it where it can be killed: the parent terminates this thread
// and starts another. Plain JavaScript on purpose: a worker started from a .ts file would not be transformed under every test runner.
import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const { PGlite } = require("@electric-sql/pglite");

// Every type is read back as the text PostgreSQL prints, so what is compared is what a person would see.
const AS_TEXT = (value) => value;
const TEXT_OIDS = [16, 20, 21, 23, 700, 701, 1082, 1114, 1184, 1700];
const db = new PGlite({ parsers: Object.fromEntries(TEXT_OIDS.map((oid) => [oid, AS_TEXT])) });
await db.waitReady;
await db.exec("SET TIME ZONE 'UTC'");

const asText = (value) => (value === null || value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value));

parentPort.on("message", async ({ id, op, sql, maxRows }) => {
    try {
        let value;
        if (op === "exec") {
            await db.exec(sql);
            value = null;
        } else if (op === "query") {
            const result = await db.query(sql, [], { rowMode: "object" });
            value = { rows: result.rows, fields: result.fields.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID })) };
        } else if (op === "readonly") {
            await db.exec("BEGIN READ ONLY");
            try {
                const result = await db.query(sql, [], { rowMode: "array" });
                const rows = result.rows.map((row) => row.map(asText));
                value = { rows: rows.slice(0, maxRows), fields: result.fields.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID })), truncated: rows.length > maxRows };
            } finally {
                await db.exec("ROLLBACK");
            }
        } else throw new Error(`unknown operation ${op}`);
        parentPort.postMessage({ id, ok: true, value });
    } catch (error) {
        parentPort.postMessage({ id, ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
    }
});
parentPort.postMessage({ id: 0, ok: true, value: "ready" });
