import { describe, expect, it } from "vitest";
import { evaluate, PREFLIGHT_LIMITS, type PreflightInput } from "./preflight.js";

const quiet = (overrides: Partial<PreflightInput> = {}): PreflightInput => ({
    tables: ["public.orders"],
    base: { version: "16.4", recovery: false, statement_timeout: "0", lock_timeout: "0", idle_timeout: "0", hidden_sessions: 0 },
    sessions: [],
    locks: [],
    prepared: [],
    vacuum: [],
    replicas: [],
    slots: [],
    ...overrides,
});
const byId = (input: PreflightInput) => Object.fromEntries(evaluate(input).checks.map((check) => [check.id, check]));

describe("preflight", () => {
    it("passes every check on a quiet primary", () => {
        const checks = byId(quiet());
        expect(Object.values(checks).map((check) => check.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
    });

    it("blocks on a replica and does not claim to have read its replication views", () => {
        const checks = byId(quiet({ base: { ...quiet().base, recovery: true } }));
        expect(checks.primary.status).toBe("block");
        expect(checks.replication.status).toBe("unknown");
        expect(checks.slots.status).toBe("unknown");
    });

    it("tells a long transaction on the tables from a short one and from one elsewhere", () => {
        const session = (pid: number, seconds: number, table: string) => ({ pid, role: "app", state: "idle in transaction", xact_seconds: seconds, query: "SELECT 1", holds: [table], waits: [] });
        const long = byId(quiet({ sessions: [session(11, PREFLIGHT_LIMITS.longTransactionSeconds + 5, "public.orders")] })).sessions;
        expect(long.status).toBe("warn");
        expect(long.detail).toMatch(/open 30s or more/);
        expect(long.items[0]).toMatch(/pid 11 .*idle in transaction.*transaction open 35s.*public\.orders: SELECT 1/);
        const short = byId(quiet({ sessions: [session(12, 2, "public.orders")] })).sessions;
        expect(short.status).toBe("warn");
        expect(short.detail).toMatch(/none for long/);
        expect(byId(quiet({ sessions: [session(13, 600, "public.other")] })).sessions.status).toBe("ok");
    });

    it("finds a session of another role through its locks, and says what it cannot see about it", () => {
        const checks = byId(quiet({ sessions: [{ pid: 21, role: null, state: null, xact_seconds: null, query: "", hidden: true, holds: ["public.orders"], waits: [] }] }));
        expect(checks.sessions.status).toBe("warn");
        expect(checks.sessions.items[0]).toMatch(/pid 21 \(another role: its transaction and query are not visible.*public\.orders/);
        expect(checks.sessions.detail).toMatch(/not visible for some/);
    });

    it("notes sessions it cannot inspect when none of them holds a lock on the tables", () => {
        const checks = byId(quiet({ base: { ...quiet().base, hidden_sessions: 3 } }));
        expect(checks.sessions.status).toBe("ok");
        expect(checks.sessions.detail).toMatch(/3 other sessions belong to roles this connection cannot inspect, but none of them holds a lock/);
    });

    it("reports strong locks, waiting ones included, and prepared transactions on the tables", () => {
        const locks = byId(quiet({ locks: [{ pid: 7, mode: "AccessExclusiveLock", granted: true, table: "public.orders" }, { pid: 8, mode: "ShareLock", granted: false, table: "public.orders" }] })).locks;
        expect(locks.status).toBe("warn");
        expect(locks.items).toEqual(["pid 7: AccessExclusiveLock on public.orders", "pid 8: ShareLock on public.orders (waiting)"]);
        const prepared = byId(quiet({ prepared: [{ gid: "tx-1", seconds: 3700, tables: ["public.orders"] }, { gid: "tx-2", seconds: 5, tables: ["public.other"] }] })).prepared;
        expect(prepared.status).toBe("warn");
        expect(prepared.items).toEqual(["tx-1, prepared 1h 1m ago"]);
    });

    it("warns about a replica that is behind and a slot nothing reads", () => {
        const behind = byId(quiet({ replicas: [{ application_name: "r1", state: "streaming", replay_bytes: String(64 * 1024 * 1024), replay_seconds: 1 }, { application_name: "r2", state: "streaming", replay_bytes: "100", replay_seconds: 0.1 }] })).replication;
        expect(behind.status).toBe("warn");
        expect(behind.items).toEqual(["r1: streaming, 64 MiB behind, 1s replay lag"]);
        const slot = byId(quiet({ slots: [{ slot_name: "old_consumer", slot_type: "physical", active: false, retained_bytes: String(5 * 1024 * 1024) }, { slot_name: "live", slot_type: "logical", active: true, retained_bytes: "10" }] })).slots;
        expect(slot.status).toBe("warn");
        expect(slot.items).toEqual(["old_consumer (physical, inactive) holds 5.0 MiB of WAL"]);
        expect(byId(quiet({ slots: [{ slot_name: "live", slot_type: "logical", active: true, retained_bytes: "10" }] })).slots.status).toBe("ok");
    });

    it("says the replication views could not be read rather than passing", () => {
        const checks = byId(quiet({ replicationNote: "permission denied for function pg_current_wal_lsn" }));
        expect(checks.replication.status).toBe("unknown");
        expect(checks.replication.detail).toContain("permission denied");
    });

    it("names the timeouts the role runs with", () => {
        const timeouts = byId(quiet({ base: { ...quiet().base, statement_timeout: "30s", idle_timeout: "1min" } })).timeouts;
        expect(timeouts.status).toBe("warn");
        expect(timeouts.items).toHaveLength(2);
        expect(timeouts.items[0]).toContain("statement_timeout = 30s");
    });
});
