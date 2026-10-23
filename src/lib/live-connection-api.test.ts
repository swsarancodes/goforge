import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionAddress, connectionLabel, createOracleDatabase, getOracleStatus, listSavedConnections } from "./live-connection-api";

const connection = (id: string, name: string, database = "neondb") => ({ id, name, database, host: "ep-old-cell.example.tech", port: 5432, username: "owner" });

describe("connectionLabel", () => {
    it("is the name and nothing else", () => {
        const all = [connection("1", "shop-db"), connection("2", "crm-db")];
        expect(connectionLabel(all[0], all)).toBe("shop-db");
        expect(connectionLabel(all[1], all)).toBe("crm-db");
    });

    it("adds the database only when two connections share a name, so two lines never read the same", () => {
        const all = [connection("1", "neondb", "orders"), connection("2", "NeonDB ", "billing"), connection("3", "other")];
        expect(connectionLabel(all[0], all)).toBe("neondb · orders");
        expect(connectionLabel(all[1], all)).toBe("NeonDB  · billing");
        expect(connectionLabel(all[2], all)).toBe("other");
    });

    it("keeps the address for a tooltip", () => {
        expect(connectionAddress(connection("1", "shop-db"))).toBe("owner@ep-old-cell.example.tech:5432/neondb");
    });
});

describe("the Oracle parts of the API", () => {
    const respond = (body: unknown, init: ResponseInit = { status: 200 }) => vi.fn(async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init }));
    afterEach(() => vi.unstubAllGlobals());

    it("lists PostgreSQL connections unless asked for more, so pages that predate Oracle see what they always saw", async () => {
        const fetchMock = respond([]);
        vi.stubGlobal("fetch", fetchMock);
        await listSavedConnections();
        await listSavedConnections("all");
        await listSavedConnections("oracle");
        expect(fetchMock.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual(["/api/connections/", "/api/connections/?engine=all", "/api/connections/?engine=oracle"]);
    });

    it("asks the server whether Oracle is available, and treats a failure as not available", async () => {
        vi.stubGlobal("fetch", respond({ configured: true, limit: 5, used: 1 }));
        expect(await getOracleStatus()).toEqual({ configured: true, limit: 5, used: 1 });
        vi.stubGlobal("fetch", respond({ error: "nope" }, { status: 500 }));
        expect(await getOracleStatus()).toEqual({ configured: false });
    });

    it("creates an Oracle database with the name and the script, and says what the server said when it refuses", async () => {
        const created = respond({ connection: { id: "c1", name: "demo", engine: "oracle" }, statementsRun: 3 }, { status: 201 });
        vi.stubGlobal("fetch", created);
        expect(await createOracleDatabase({ name: "demo", sql: "CREATE TABLE t (id NUMBER)" })).toMatchObject({ statementsRun: 3, connection: { engine: "oracle" } });
        const [url, init] = created.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("/api/oracle-databases");
        expect(JSON.parse(String(init.body))).toEqual({ name: "demo", sql: "CREATE TABLE t (id NUMBER)" });

        vi.stubGlobal("fetch", respond({ error: "You already have 5 Oracle databases, the limit on this server. Delete one first." }, { status: 403 }));
        await expect(createOracleDatabase({ name: "x", sql: "y" })).rejects.toThrow(/already have 5 Oracle databases/);
    });
});
