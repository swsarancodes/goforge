import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ConnectionRow } from "../db/store.js";
import { isConnectionLost, ReadPools, type PoolClientLike, type PoolLike } from "./pg-pool.js";

const row = (id: string, updatedAt = "t0"): ConnectionRow => ({ id, updated_at: updatedAt }) as ConnectionRow;

/** A pool double: hands out clients, records releases, and lets a test emit pg-pool's `remove` event. */
class FakePool extends EventEmitter implements PoolLike {
    totalCount = 0;
    ended = false;
    released: (Error | boolean | undefined)[] = [];
    clientBehaviours: ((text: string) => Promise<unknown>)[] = [];

    async connect(): Promise<PoolClientLike> {
        this.totalCount = Math.max(this.totalCount, 1);
        const behaviour = this.clientBehaviours.shift() ?? (async () => ({}));
        return { query: (text: string) => behaviour(text), release: (error) => void this.released.push(error) };
    }

    async end(): Promise<void> {
        this.ended = true;
    }
}

function setup() {
    const pools: FakePool[] = [];
    const readPools = new ReadPools(() => {
        const pool = new FakePool();
        pools.push(pool);
        return pool;
    });
    return { readPools, pools };
}

describe("ReadPools", () => {
    it("reuses one pool per saved connection and keeps connections separate", async () => {
        const { readPools, pools } = setup();

        await readPools.withClient(row("a"), async () => 1);
        await readPools.withClient(row("a"), async () => 2);
        await readPools.withClient(row("b"), async () => 3);

        expect(pools).toHaveLength(2);
        expect(readPools.size).toBe(2);
    });

    it("returns the client to the pool after success", async () => {
        const { readPools, pools } = setup();
        await expect(readPools.withClient(row("a"), async () => "ok")).resolves.toBe("ok");
        expect(pools[0].released).toEqual([undefined]);
    });

    it("discards the client after a database error (aborted transaction) and rethrows", async () => {
        const { readPools, pools } = setup();
        const dbError = Object.assign(new Error('relation "x" does not exist'), { code: "42P01" });

        await expect(
            readPools.withClient(row("a"), async () => {
                throw dbError;
            }),
        ).rejects.toBe(dbError);
        expect(pools[0].released).toEqual([dbError]);
    });

    it("keeps the client after an error raised by our own code", async () => {
        const { readPools, pools } = setup();
        await expect(
            readPools.withClient(row("a"), async () => {
                throw new Error("Unknown sort column");
            }),
        ).rejects.toThrow("Unknown sort column");
        expect(pools[0].released).toEqual([undefined]);
    });

    it("retries once on a fresh client when the pooled connection was dropped", async () => {
        const { readPools, pools } = setup();
        let calls = 0;

        const result = await readPools.withClient(row("a"), async () => {
            calls++;
            if (calls === 1) throw new Error("Connection terminated unexpectedly");
            return "second try";
        });

        expect(result).toBe("second try");
        expect(calls).toBe(2);
        expect(pools[0].released).toHaveLength(2);
        expect(pools[0].released[0]).toBeInstanceOf(Error);
        expect(pools[0].released[1]).toBeUndefined();
    });

    it("does not retry forever", async () => {
        const { readPools } = setup();
        let calls = 0;
        await expect(
            readPools.withClient(row("a"), async () => {
                calls++;
                throw new Error("Connection terminated unexpectedly");
            }),
        ).rejects.toThrow("Connection terminated");
        expect(calls).toBe(2);
    });

    it("drops the pool, and the password it holds, once its last connection has gone", async () => {
        const { readPools, pools } = setup();
        await readPools.withClient(row("a"), async () => undefined);
        expect(readPools.has("a")).toBe(true);

        pools[0].totalCount = 1;
        pools[0].emit("remove");
        expect(readPools.has("a")).toBe(true); // another connection is still open

        pools[0].totalCount = 0;
        pools[0].emit("remove");
        expect(readPools.has("a")).toBe(false);
        expect(pools[0].ended).toBe(true);
    });

    it("close() ends the pool when the saved connection is deleted", async () => {
        const { readPools, pools } = setup();
        await readPools.withClient(row("a"), async () => undefined);

        await readPools.close("a");

        expect(readPools.has("a")).toBe(false);
        expect(pools[0].ended).toBe(true);
        await expect(readPools.close("missing")).resolves.toBeUndefined();
    });

    it("replaces the pool when the saved connection is edited", async () => {
        const { readPools, pools } = setup();
        await readPools.withClient(row("a", "t0"), async () => undefined);
        await readPools.withClient(row("a", "t1"), async () => undefined);

        expect(pools).toHaveLength(2);
        expect(pools[0].ended).toBe(true);
    });

    it("survives errors emitted by idle clients", async () => {
        const { readPools, pools } = setup();
        await readPools.withClient(row("a"), async () => undefined);
        expect(() => pools[0].emit("error", new Error("idle client died"))).not.toThrow();
    });

    it("records how long the client took to arrive", async () => {
        const { readPools } = setup();
        const timings: { connectMs?: number } = {};
        await readPools.withClient(row("a"), async () => undefined, timings);
        expect(timings.connectMs).toBeGreaterThanOrEqual(0);
    });
});

describe("isConnectionLost", () => {
    it("recognises dropped connections but not SQL errors", () => {
        expect(isConnectionLost(new Error("Connection terminated unexpectedly"))).toBe(true);
        expect(isConnectionLost(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
        expect(isConnectionLost(Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }))).toBe(true);
        expect(isConnectionLost(Object.assign(new Error("syntax error"), { code: "42601" }))).toBe(false);
        expect(isConnectionLost(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }))).toBe(false);
        expect(isConnectionLost("nope")).toBe(false);
    });
});
