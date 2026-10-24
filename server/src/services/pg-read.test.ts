import { describe, expect, it } from "vitest";
import { runReadOnly, STATEMENT_TIMEOUT_MS, type Queryable } from "./pg-read.js";

describe("runReadOnly", () => {
    it("wraps the statements in one READ ONLY transaction that always rolls back, sent as a single query", async () => {
        const sent: string[] = [];
        const client: Queryable = {
            async query(text: string) {
                sent.push(text);
                return [{ command: "BEGIN" }, { command: "SET" }, { rows: [{ a: 1 }] }, { rows: [{ b: 2 }] }, { command: "ROLLBACK" }];
            },
        };

        const results = await runReadOnly(client, ["SELECT 1 AS a", "SELECT 2 AS b"]);

        expect(sent).toEqual([`BEGIN READ ONLY; SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}; SELECT 1 AS a; SELECT 2 AS b; ROLLBACK`]);
        expect(results).toEqual([{ rows: [{ a: 1 }] }, { rows: [{ b: 2 }] }]);
    });

    it("copes with a driver that returns a single result for a single statement", async () => {
        const client: Queryable = { query: async () => ({ command: "SELECT", rows: [] }) };
        // Not an array: treated as one result, so nothing is left once BEGIN/SET/ROLLBACK are stripped.
        await expect(runReadOnly(client, ["SELECT 1"])).resolves.toEqual([]);
    });

    it("propagates database errors", async () => {
        const client: Queryable = {
            async query() {
                throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
            },
        };
        await expect(runReadOnly(client, ["SELECT pg_sleep(60)"])).rejects.toMatchObject({ code: "57014" });
    });
});
