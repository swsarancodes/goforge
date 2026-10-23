import { describe, expect, it, vi } from "vitest";
import type { ValidationResponse } from "@/lib/modernizer-api";
import type { QueryModernizationRequest } from "@/lib/ai-api";
import { MAX_AI_ATTEMPTS, modernize, type ModernizeDeps } from "./modernize";
import type { AiConversion } from "./types";

const accepted: ValidationResponse = { status: "accepted", statements: [{ index: 0, sql: "", status: "accepted" }], elapsedMs: 3 };
const rejected = (message: string): ValidationResponse => ({ status: "rejected", statements: [{ index: 0, sql: "", status: "rejected", error: { message, position: 8 } }], elapsedMs: 3 });
const reply = (sql: string): { result: AiConversion; model: string } => ({ model: "test-model", result: { sql, summary: "Converted.", changes: ["did a thing"], risks: ["maybe different"], unsupported: [] } });

const deps = (overrides: Partial<ModernizeDeps> = {}): ModernizeDeps => ({ syntax: async () => ({ ok: true }), ...overrides });

describe("modernize", () => {
    it("uses only the rules when they finish and PostgreSQL accepts the result", async () => {
        const ask = vi.fn();
        const validate = vi.fn(async () => accepted);
        const outcome = await modernize({ sql: "SELECT NVL(a, 0) FROM t", dialect: "oracle" }, deps({ ask, validate, connectionName: "prod" }));

        expect(outcome.sql).toBe("SELECT COALESCE(a, 0) FROM t");
        expect(outcome.source).toBe("rules");
        expect(outcome.postgres).toMatchObject({ status: "accepted", connectionName: "prod" });
        expect(ask).not.toHaveBeenCalled();
        expect(validate).toHaveBeenCalledWith("SELECT COALESCE(a, 0) FROM t");
    });

    it("says PostgreSQL was not asked when no connection is chosen, and still checks the syntax", async () => {
        const syntax = vi.fn(async () => ({ ok: true }));
        const outcome = await modernize({ sql: "SELECT NVL(a, 0) FROM t", dialect: "oracle" }, { syntax });
        expect(outcome.postgres.status).toBe("not-run");
        expect(syntax).toHaveBeenCalled();
    });

    it("asks the model only for what the rules couldn't do, and shows its answer when PostgreSQL accepts it", async () => {
        const ask = vi.fn(async (_request: QueryModernizationRequest) => reply("SELECT date_trunc('day', hired) FROM emp"));
        const outcome = await modernize({ sql: "SELECT TRUNC(hired) FROM emp", dialect: "oracle" }, deps({ ask, validate: async () => accepted }));

        expect(outcome.engine.unconverted).toHaveLength(1);
        expect(ask).toHaveBeenCalledTimes(1);
        const request = ask.mock.calls[0][0];
        expect(request.draft?.notConverted[0].reason).toMatch(/TRUNC/);
        expect(request.legacySql).toBe("SELECT TRUNC(hired) FROM emp");
        expect(outcome.source).toBe("ai");
        expect(outcome.sql).toBe("SELECT date_trunc('day', hired) FROM emp");
        expect(outcome.ai).toMatchObject({ model: "test-model", attempts: 1, checkedByDatabase: true, risks: ["maybe different"] });
    });

    it("feeds PostgreSQL's complaint back, then uses the repaired answer", async () => {
        const answers = ["SELECT nope(hired) FROM emp", "SELECT hired FROM emp"];
        const requests: QueryModernizationRequest[] = [];
        const ask = vi.fn(async (request: QueryModernizationRequest) => {
            requests.push(request);
            return reply(answers[requests.length - 1]);
        });
        const validate = vi.fn(async (sql: string) => (sql.includes("nope") ? rejected('function nope(date) does not exist') : accepted));

        const outcome = await modernize({ sql: "SELECT TRUNC(hired) FROM emp", dialect: "oracle" }, deps({ ask, validate }));

        expect(ask).toHaveBeenCalledTimes(2);
        expect(requests[1].draft?.sql).toBe("SELECT nope(hired) FROM emp");
        expect(requests[1].draft?.postgresError).toContain("function nope(date) does not exist");
        expect(outcome.source).toBe("ai");
        expect(outcome.ai?.attempts).toBe(2);
        expect(outcome.sql).toBe("SELECT hired FROM emp");
    });

    it("keeps the rules' conversion, and says so, when the model never gets an accepted answer", async () => {
        const ask = vi.fn(async () => reply("SELECT broken FROM"));
        const outcome = await modernize({ sql: "SELECT TRUNC(hired) FROM emp", dialect: "oracle" }, deps({ ask, validate: async (sql) => (sql.includes("broken") ? rejected("syntax error") : accepted) }));

        expect(ask).toHaveBeenCalledTimes(MAX_AI_ATTEMPTS);
        expect(outcome.source).toBe("rules");
        expect(outcome.sql).toContain("-- NOT CONVERTED");
        expect(outcome.aiNotice).toMatch(/not accepted after 2 tries \(syntax error/);
    });

    it("does not ask the model when the only complaint is that a table is not on the connection", async () => {
        const ask = vi.fn(async () => reply("SELECT 1"));
        const missing: ValidationResponse = { status: "rejected", statements: [{ index: 0, sql: "", status: "rejected", error: { message: 'relation "emp" does not exist', code: "42P01", position: 15 } }], elapsedMs: 2 };
        const outcome = await modernize({ sql: "SELECT NVL(a, 0) FROM emp", dialect: "oracle" }, deps({ ask, validate: async () => missing }));
        expect(ask).not.toHaveBeenCalled();
        expect(outcome.source).toBe("rules");
        expect(outcome.postgres.status).toBe("rejected");

        // an unconverted construct still gets the model, whatever else is missing
        const unconverted = await modernize({ sql: "SELECT TRUNC(hired) FROM emp", dialect: "oracle" }, deps({ ask, validate: async () => missing }));
        expect(unconverted.engine.unconverted).toHaveLength(1);
        expect(ask).toHaveBeenCalled();
    });

    it("sends the model back when PostgreSQL rejects the rules' own SQL", async () => {
        const ask = vi.fn(async () => reply("SELECT 1"));
        const validate = vi.fn(async (sql: string) => (sql === "SELECT 1" ? accepted : rejected('relation "nope" does not exist')));
        const outcome = await modernize({ sql: "SELECT * FROM nope", dialect: "oracle" }, deps({ ask, validate }));

        expect(outcome.engine.unconverted).toEqual([]);
        expect(ask.mock.calls[0]).toBeDefined();
        const draft = (ask.mock.calls[0] as unknown as [QueryModernizationRequest])[0].draft;
        expect(draft?.postgresError).toMatch(/relation "nope" does not exist/);
        expect(outcome.source).toBe("ai");
    });

    it("without a connection, accepts the model's answer only if a PostgreSQL grammar does, and says it wasn't checked by a database", async () => {
        const syntax = vi.fn(async (sql: string) => (sql.includes("broken") ? { ok: false, error: "syntax error" } : { ok: true }));
        const ask = vi.fn(async () => reply("SELECT CAST(hired AS date) FROM emp"));
        const outcome = await modernize({ sql: "SELECT TRUNC(hired) FROM emp", dialect: "oracle" }, { syntax, ask });
        expect(outcome.source).toBe("ai");
        expect(outcome.ai?.checkedByDatabase).toBe(false);
        expect(outcome.postgres.status).toBe("not-run");

        const bad = await modernize({ sql: "SELECT TRUNC(hired) FROM emp", dialect: "oracle" }, { syntax, ask: async () => reply("broken") });
        expect(bad.source).toBe("rules");
    });

    it("treats an unreachable database as unknown, not as a rejection", async () => {
        const validate = vi.fn(async () => {
            throw new Error("connect ECONNREFUSED");
        });
        const outcome = await modernize({ sql: "SELECT NVL(a, 0) FROM t", dialect: "oracle" }, deps({ validate, connectionName: "prod" }));
        expect(outcome.postgres).toMatchObject({ status: "unreachable", message: "connect ECONNREFUSED" });
        expect(outcome.source).toBe("rules");
    });

    it("explains when the model can't be reached and keeps the rules' result", async () => {
        const ask = vi.fn(async () => {
            throw new Error("api_key_expired");
        });
        const outcome = await modernize({ sql: "SELECT TRUNC(hired) FROM emp", dialect: "oracle" }, deps({ ask }));
        expect(outcome.aiNotice).toMatch(/api_key_expired/);
        expect(outcome.source).toBe("rules");
        expect(ask).toHaveBeenCalledTimes(1);
    });

    it("never asks the model when it isn't available", async () => {
        const outcome = await modernize({ sql: "SELECT TRUNC(hired) FROM emp", dialect: "oracle" }, deps());
        expect(outcome.aiNotice).toBeUndefined();
        expect(outcome.engine.unconverted).toHaveLength(1);
    });

    it("lets a database check SQL that has bind variables by replacing them", async () => {
        const validate = vi.fn(async () => accepted);
        await modernize({ sql: "SELECT NVL(a, 0) FROM t WHERE id = :id", dialect: "oracle" }, deps({ validate }));
        expect(validate).toHaveBeenCalledWith("SELECT COALESCE(a, 0) FROM t WHERE id = NULL");
    });

    it("returns unreadable SQL untouched with the reason", async () => {
        const outcome = await modernize({ sql: "SELECT 'oops", dialect: "oracle" }, deps({ validate: vi.fn() }));
        expect(outcome.sql).toBe("SELECT 'oops");
        expect(outcome.syntax.ok).toBe(false);
        expect(outcome.postgres.status).toBe("not-run");
    });

    describe("when the model is asked first", () => {
        it("asks even though the rules finished and PostgreSQL accepts their SQL, and shows the model's answer", async () => {
            const ask = vi.fn(async (_request: QueryModernizationRequest) => reply("SELECT coalesce(a, 0) AS a FROM t"));
            const outcome = await modernize({ sql: "SELECT NVL(a, 0) FROM t", dialect: "oracle" }, deps({ ask, aiFirst: true, validate: async () => accepted }));

            expect(ask).toHaveBeenCalledTimes(1);
            expect(outcome.source).toBe("ai");
            expect(outcome.sql).toBe("SELECT coalesce(a, 0) AS a FROM t");
            // the rules still ran, and are what the model was given as a draft
            expect(outcome.engine.sql).toBe("SELECT COALESCE(a, 0) FROM t");
            expect(ask.mock.calls[0][0].draft?.sql).toBe("SELECT COALESCE(a, 0) FROM t");
            expect(ask.mock.calls[0][0].legacySql).toBe("SELECT NVL(a, 0) FROM t");
        });

        it("falls back to the rules' SQL, saying so, when the model's answer is never accepted", async () => {
            const ask = vi.fn(async () => reply("SELECT broken FROM"));
            const outcome = await modernize({ sql: "SELECT NVL(a, 0) FROM t", dialect: "oracle" }, deps({ ask, aiFirst: true, validate: async (sql) => (sql.includes("broken") ? rejected("syntax error") : accepted) }));
            expect(ask).toHaveBeenCalledTimes(MAX_AI_ATTEMPTS);
            expect(outcome.source).toBe("rules");
            expect(outcome.sql).toBe("SELECT COALESCE(a, 0) FROM t");
            expect(outcome.aiNotice).toMatch(/not accepted after 2 tries/);
        });

        it("does nothing different when there is no model to ask", async () => {
            const outcome = await modernize({ sql: "SELECT NVL(a, 0) FROM t", dialect: "oracle" }, deps({ aiFirst: true, validate: async () => accepted }));
            expect(outcome.source).toBe("rules");
            expect(outcome.aiNotice).toBeUndefined();
        });

        it("lets the model read a query the rules could not, and keeps the unreadable-query verdict if it cannot either", async () => {
            const ask = vi.fn(async () => reply("SELECT 'oops'"));
            const helped = await modernize({ sql: "SELECT 'oops", dialect: "oracle" }, deps({ ask, aiFirst: true }));
            expect(ask).toHaveBeenCalledTimes(1);
            expect(helped.source).toBe("ai");
            expect(helped.sql).toBe("SELECT 'oops'");

            const refused = await modernize({ sql: "SELECT 'oops", dialect: "oracle" }, deps({ ask: async () => reply("SELECT broken"), aiFirst: true, syntax: async (sql) => (sql.includes("broken") ? { ok: false, error: "syntax error" } : { ok: true }) }));
            expect(refused.source).toBe("rules");
            expect(refused.engine.syntaxError).toBeDefined();
        });

        it("never asks in the default mode when the rules are enough", async () => {
            const ask = vi.fn(async () => reply("SELECT 1"));
            await modernize({ sql: "SELECT NVL(a, 0) FROM t", dialect: "oracle" }, deps({ ask, validate: async () => accepted }));
            expect(ask).not.toHaveBeenCalled();
        });
    });

    it("suggests indexes for the tables it was given", async () => {
        const outcome = await modernize(
            { sql: "SELECT * FROM orders WHERE status = 'open'", dialect: "oracle", schema: { tables: [{ name: "orders", columns: [{ name: "id", type: "integer", isPrimary: true }, { name: "status", type: "text" }] }] } },
            deps(),
        );
        expect(outcome.advice.recommendations[0].ddl).toBe("CREATE INDEX idx_orders_status ON orders (status);");
    });
});
