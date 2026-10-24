import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The store opens its database when it is first imported, so point it at a throwaway file first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goforge-connections-"));
process.env.SQLITE_PATH = path.join(dir, "test.db");
process.env.MASTER_KEY = randomBytes(32).toString("base64");

const { createApp } = await import("../app.js");

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";

beforeAll(async () => {
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connections`;
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
});

const send = (method: string, url: string, body?: unknown) =>
    fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const create = async () => {
    const response = await send("POST", base, { name: "neondb", host: "db.example.com", port: 5432, username: "app", password: "not-a-real-password", database: "neondb", sslMode: "require" });
    return (await response.json()) as { id: string; name: string; updatedAt: string };
};

describe("renaming a saved connection", () => {
    it("changes the name and nothing else, and does not return the password", async () => {
        const created = await create();
        const response = await send("PATCH", `${base}/${created.id}`, { name: "  Production analytics  " });
        expect(response.status).toBe(200);
        const renamed = await response.json();
        expect(renamed).toMatchObject({ id: created.id, name: "Production analytics", host: "db.example.com", database: "neondb", username: "app", sslMode: "require" });
        expect(JSON.stringify(renamed)).not.toContain("not-a-real-password");

        const listed = (await (await send("GET", base)).json()) as { id: string; name: string }[];
        expect(listed.find((connection) => connection.id === created.id)?.name).toBe("Production analytics");
    });

    it("refuses a blank or oversized name and leaves the old one", async () => {
        const created = await create();
        expect((await send("PATCH", `${base}/${created.id}`, { name: "   " })).status).toBe(400);
        expect((await send("PATCH", `${base}/${created.id}`, { name: "x".repeat(101) })).status).toBe(400);
        expect((await send("PATCH", `${base}/${created.id}`, {})).status).toBe(400);
        const listed = (await (await send("GET", base)).json()) as { id: string; name: string }[];
        expect(listed.find((connection) => connection.id === created.id)?.name).toBe("neondb");
    });

    it("answers 404 for a connection that does not exist", async () => {
        expect((await send("PATCH", `${base}/does-not-exist`, { name: "x" })).status).toBe(404);
    });
});
