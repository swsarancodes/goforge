import { describe, expect, it } from "vitest";
import type { ConnectionRow } from "../db/store.js";
import { SqlSessionError, SqlSessions, type SessionClient } from "./sql-sessions.js";

const row = (id = "conn-1"): ConnectionRow => ({ id, updated_at: "t0" }) as ConnectionRow;
const result = (command: string, extra: Record<string, unknown> = {}) => ({ command, rowCount: 0, fields: [], rows: [], ...extra });

type Handler = (text: string) => unknown;

/** A scriptable client: every query text is recorded; `handle` decides what comes back (or throws). */
function fakeClient(handle: Handler = () => undefined) {
    const sent: string[] = [];
    let destroyed = false;
    let ended = false;
    let errorListener: ((error: Error) => void) | undefined;
    const client: SessionClient = {
        async query(config) {
            const text = typeof config === "string" ? config : config.text;
            sent.push(text);
            if (text.startsWith("SELECT pg_backend_pid")) return { rows: [[4242]] };
            const custom = handle(text);
            if (custom !== undefined) return custom;
            if (text.includes("SAVEPOINT goforge_run;") && !text.startsWith("ROLLBACK")) {
                // BEGIN? SET.. SAVEPOINT; <sql>; RELEASE
                const header = text.startsWith("BEGIN;") ? 4 : 1;
                return [...Array.from({ length: header }, () => result("BEGIN")), result("UPDATE", { rowCount: 2 }), result("RELEASE")];
            }
            return result("OK");
        },
        async end() {
            ended = true;
        },
        destroy() {
            destroyed = true;
        },
        onError(listener) {
            errorListener = listener;
        },
    };
    return { client, sent, state: () => ({ destroyed, ended }), emitError: (error: Error) => errorListener?.(error) };
}

function setup(handle?: Handler, deps: Partial<ConstructorParameters<typeof SqlSessions>[0]> = {}) {
    const fake = fakeClient(handle);
    const connects: ConnectionRow[] = [];
    let now = 1_000;
    const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
    const sessions = new SqlSessions({
        connect: async (r) => {
            connects.push(r);
            return fake.client;
        },
        now: () => now,
        setTimer: (callback, ms) => {
            const timer = { callback, ms, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimer: (handle) => void ((handle as { cleared: boolean }).cleared = true),
        ...deps,
    });
    return { sessions, fake, connects, timers, advance: (ms: number) => void (now += ms) };
}

const SID = "session-aaaa";

describe("SqlSessions.run", () => {
    it("opens one connection per session, begins a transaction once and keeps it open", async () => {
        const { sessions, fake, connects } = setup();

        const first = await sessions.run(row(), SID, "UPDATE t SET a = 1");
        expect(first.ok).toBe(true);
        expect(first.ok && first.transaction).toMatchObject({ open: true, hasChanges: true });
        expect(connects).toHaveLength(1);

        await sessions.run(row(), SID, "UPDATE t SET a = 2");
        expect(connects).toHaveLength(1);

        const batches = fake.sent.filter((text) => text.includes("SAVEPOINT goforge_run;"));
        expect(batches[0]).toMatch(/^BEGIN; SET LOCAL statement_timeout/);
        expect(batches[1]).toMatch(/^SAVEPOINT goforge_run;/); // already in the transaction: no second BEGIN
    });

    it("runs a lone SELECT without leaving a transaction open", async () => {
        const { sessions, fake } = setup((text) =>
            text.startsWith("BEGIN READ ONLY")
                ? [result("BEGIN"), result("SET"), result("SET"), result("DECLARE"), result("FETCH", { rowCount: 1, fields: [{ name: "n", dataTypeID: 23 }], rows: [["1"]] }), result("CLOSE"), result("ROLLBACK")]
                : undefined,
        );

        const outcome = await sessions.run(row(), SID, "SELECT 1 AS n");

        expect(outcome.ok && outcome.results).toMatchObject([{ command: "SELECT", rows: [["1"]], columns: [{ name: "n", dataType: "integer" }] }]);
        expect(outcome.transaction.open).toBe(false);
        expect(fake.sent.some((text) => text.startsWith("COMMIT"))).toBe(false);
    });

    it("keeps earlier work when a later run fails: rolls back to the savepoint only", async () => {
        let call = 0;
        const { sessions, fake } = setup((text) => {
            if (text.includes("SAVEPOINT goforge_run;") && ++call === 2) throw Object.assign(new Error('relation "nope" does not exist'), { code: "42P01", position: "1" });
            return undefined;
        });

        await sessions.run(row(), SID, "UPDATE t SET a = 1");
        const failed = await sessions.run(row(), SID, "SELECT * FROM nope; UPDATE t SET a = 2");

        expect(failed.ok).toBe(false);
        expect(!failed.ok && failed.error).toMatchObject({ code: "42P01" });
        expect(failed.transaction).toMatchObject({ open: true, hasChanges: true });
        expect(fake.sent).toContain("ROLLBACK TO SAVEPOINT goforge_run; RELEASE SAVEPOINT goforge_run");
        expect(fake.sent).not.toContain("ROLLBACK");
    });

    it("closes the transaction when the very first run fails", async () => {
        const { sessions, fake } = setup((text) => {
            if (text.includes("SAVEPOINT goforge_run;")) throw Object.assign(new Error("syntax error"), { code: "42601" });
            return undefined;
        });

        const failed = await sessions.run(row(), SID, "UPDATE oops");

        expect(failed.ok).toBe(false);
        expect(failed.transaction.open).toBe(false);
        expect(fake.sent).toContain("ROLLBACK");
    });

    it("falls back to running a SELECT as written when the cursor is refused", async () => {
        let attempts = 0;
        const { sessions, fake } = setup((text) => {
            if (text.includes("DECLARE goforge_cur")) {
                attempts++;
                throw Object.assign(new Error("cannot specify INTO"), { code: "0A000" });
            }
            if (text.startsWith("BEGIN READ ONLY")) return [result("BEGIN"), result("SET"), result("SET"), result("SELECT", { rowCount: 1, fields: [{ name: "a", dataTypeID: 23 }], rows: [["7"]] }), result("ROLLBACK")];
            return undefined;
        });

        const outcome = await sessions.run(row(), SID, "SELECT 7 AS a");

        expect(attempts).toBe(1);
        expect(outcome.ok && outcome.results[0].rows).toEqual([["7"]]);
        expect(fake.sent.filter((text) => text === "ROLLBACK")).toHaveLength(1);
    });

    it("rejects transaction control, empty input and a busy session", async () => {
        const { sessions } = setup();
        await expect(sessions.run(row(), SID, "COMMIT")).rejects.toMatchObject({ status: 400, code: "transaction_control" });
        await expect(sessions.run(row(), SID, "  -- nothing\n ")).rejects.toMatchObject({ status: 400 });
        await expect(sessions.run(row(), "short", "SELECT 1")).rejects.toBeInstanceOf(SqlSessionError);

        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const slow = setup(async (text) => {
            if (text.includes("SAVEPOINT goforge_run;")) await gate;
            return undefined;
        });
        const running = slow.sessions.run(row(), SID, "UPDATE t SET a = 1");
        await new Promise((resolve) => setTimeout(resolve, 0));
        await expect(slow.sessions.run(row(), SID, "UPDATE t SET a = 2")).rejects.toMatchObject({ status: 409, code: "busy" });
        release();
        await running;
    });

    it("refuses to continue a transaction that expired when the browser expects one", async () => {
        const { sessions } = setup();
        await expect(sessions.run(row(), SID, "UPDATE t SET a = 1", { expectOpenTransaction: true })).rejects.toMatchObject({ status: 409, code: "session_expired" });
    });

    it("refuses to use another connection's session", async () => {
        const { sessions } = setup();
        await sessions.run(row("conn-1"), SID, "UPDATE t SET a = 1");
        await expect(sessions.run(row("conn-2"), SID, "UPDATE t SET a = 1")).rejects.toMatchObject({ code: "wrong_connection" });
    });

    it("drops the session and reports lost work when the connection dies mid-run", async () => {
        let call = 0;
        const { sessions, fake } = setup((text) => {
            if (text.includes("SAVEPOINT goforge_run;") && ++call === 2) throw new Error("Connection terminated unexpectedly");
            return undefined;
        });

        await sessions.run(row(), SID, "UPDATE t SET a = 1");
        const failed = await sessions.run(row(), SID, "UPDATE t SET a = 2");

        expect(failed.ok).toBe(false);
        expect(!failed.ok && failed.transactionLost).toBe(true);
        expect(failed.transaction.open).toBe(false);
        expect(sessions.size).toBe(0);
        expect(fake.state().destroyed).toBe(true);
    });
});

describe("autocommit mode", () => {
    it("runs statements one at a time and reports the ones that already committed when one fails", async () => {
        const { sessions, fake } = setup((text) => {
            if (text === "CREATE INDEX CONCURRENTLY i ON t (a)") return result("CREATE");
            if (text === "VACUUM") throw Object.assign(new Error("boom"), { code: "XX000", position: "1" });
            return undefined;
        });

        const outcome = await sessions.run(row(), SID, "CREATE INDEX CONCURRENTLY i ON t (a); VACUUM; SELECT 1", { transactional: false });

        expect(outcome.ok).toBe(false);
        expect(outcome.results.map((r) => r.command)).toEqual(["CREATE"]);
        expect(fake.sent).not.toContain("SELECT 1");
        expect(fake.sent.some((text) => text.startsWith("BEGIN"))).toBe(false);
    });

    it("is refused while a transaction is open", async () => {
        const { sessions } = setup();
        await sessions.run(row(), SID, "UPDATE t SET a = 1");
        await expect(sessions.run(row(), SID, "VACUUM", { transactional: false })).rejects.toMatchObject({ status: 409, code: "transaction_open" });
    });
});

describe("commit and rollback", () => {
    it("COMMIT ends the transaction; the next run begins a new one", async () => {
        const { sessions, fake } = setup();
        await sessions.run(row(), SID, "UPDATE t SET a = 1");

        const committed = await sessions.commit("conn-1", SID);

        expect(committed).toMatchObject({ ok: true, transaction: { open: false, hasChanges: false } });
        expect(fake.sent).toContain("COMMIT");

        await sessions.run(row(), SID, "UPDATE t SET a = 2");
        expect(fake.sent.filter((text) => text.startsWith("BEGIN;"))).toHaveLength(2);
    });

    it("ROLLBACK discards the transaction", async () => {
        const { sessions, fake } = setup();
        await sessions.run(row(), SID, "UPDATE t SET a = 1");
        const rolledBack = await sessions.rollback("conn-1", SID);
        expect(rolledBack.transaction.open).toBe(false);
        expect(fake.sent).toContain("ROLLBACK");
    });

    it("reports a failed COMMIT and leaves nothing open", async () => {
        const { sessions } = setup((text) => {
            if (text === "COMMIT") throw Object.assign(new Error("deferred constraint violated"), { code: "23505" });
            return undefined;
        });
        await sessions.run(row(), SID, "UPDATE t SET a = 1");

        const committed = await sessions.commit("conn-1", SID);

        expect(committed.ok).toBe(false);
        expect(committed.error).toMatchObject({ code: "23505" });
        expect(committed.transaction.open).toBe(false);
    });

    it("says the session expired when it is gone", async () => {
        const { sessions } = setup();
        await expect(sessions.commit("conn-1", SID)).rejects.toMatchObject({ status: 404, code: "session_expired" });
    });
});

describe("lifecycle", () => {
    it("rolls back and closes an idle session when the idle timer fires", async () => {
        const { sessions, fake, timers } = setup();
        await sessions.run(row(), SID, "UPDATE t SET a = 1");
        const idle = timers.filter((timer) => !timer.cleared).at(-1)!;
        expect(idle.ms).toBe(5 * 60_000);

        idle.callback();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(sessions.size).toBe(0);
        expect(fake.sent).toContain("ROLLBACK");
        expect(fake.state().ended).toBe(true);
        expect(sessions.status("conn-1", SID)).toBeUndefined();
    });

    it("closeForConnection and closeAll roll back what is open", async () => {
        const { sessions, fake } = setup();
        await sessions.run(row(), SID, "UPDATE t SET a = 1");
        await sessions.closeForConnection("conn-1");
        expect(sessions.size).toBe(0);
        expect(fake.sent).toContain("ROLLBACK");

        await sessions.run(row(), "session-bbbb", "UPDATE t SET a = 1");
        await sessions.closeAll();
        expect(sessions.size).toBe(0);
    });

    it("limits concurrent sessions, evicting an idle one but never one with uncommitted work", async () => {
        const connects: number[] = [];
        let n = 0;
        const sessions = new SqlSessions({
            connect: async () => {
                connects.push(n++);
                return fakeClient().client;
            },
            maxSessions: 2,
            setTimer: () => undefined,
            clearTimer: () => undefined,
        });

        await sessions.run(row(), "session-aaaa", "SELECT 1"); // read-only: no transaction left open
        await sessions.run(row(), "session-bbbb", "UPDATE t SET a = 1"); // holds a transaction
        await sessions.run(row(), "session-cccc", "UPDATE t SET a = 1"); // evicts the idle "aaaa"
        expect(sessions.size).toBe(2);
        expect(sessions.status("conn-1", "session-aaaa")).toBeUndefined();

        await expect(sessions.run(row(), "session-dddd", "UPDATE t SET a = 1")).rejects.toMatchObject({ status: 429 });
    });

    it("forgets a session whose connection errors", async () => {
        const { sessions, fake } = setup();
        await sessions.run(row(), SID, "UPDATE t SET a = 1");
        fake.emitError(new Error("socket closed"));
        expect(sessions.size).toBe(0);
    });

    it("cancel asks Postgres to cancel and drops the connection if the statement keeps running", async () => {
        const cancelled: number[] = [];
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const { sessions, fake, timers } = setup(
            async (text) => {
                if (text.includes("SAVEPOINT goforge_run;")) await gate;
                return undefined;
            },
            { cancelBackend: async (_row, pid) => void cancelled.push(pid) },
        );

        const running = sessions.run(row(), SID, "UPDATE t SET a = pg_sleep(60)");
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(sessions.cancel(row(), SID)).resolves.toEqual({ cancelling: true });
        expect(cancelled).toEqual([4242]);

        const grace = timers.filter((timer) => !timer.cleared).at(-1)!;
        expect(grace.ms).toBe(3000);
        grace.callback();
        expect(fake.state().destroyed).toBe(true);

        release();
        await running.catch(() => undefined);
        await expect(sessions.cancel(row(), "nothing-here")).resolves.toEqual({ cancelling: false });
    });
});
