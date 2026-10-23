import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

process.env.MASTER_KEY ||= randomBytes(32).toString("base64");

const { adminConfigFromUrl, cloudConnectionRow, cloudDatabaseName, dropCloudDatabase, isCloudDatabaseName, newDatabaseOwner } = await import("./cloud-databases.js");
const { appDbConfigFromEnv, describeDatabaseUrl, explicitTls } = await import("../db/app-db.js");
const { toConnectionConfig } = await import("./pg-client.js");

describe("adminConfigFromUrl", () => {
    it("reads a Neon style connection string, including the extra parameters it carries", () => {
        const config = adminConfigFromUrl("postgresql://neondb_owner:p%40ss%2Fword@ep-example-abc123.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require");
        expect(config).toEqual({ host: "ep-example-abc123.c-7.us-east-2.aws.neon.tech", port: 5432, user: "neondb_owner", password: "p@ss/word", database: "neondb", sslMode: "require" });
    });

    it("takes the port, and chooses no TLS for this machine and TLS for anywhere else when the string does not say", () => {
        expect(adminConfigFromUrl("postgres://u:p@127.0.0.1:54332/appdb")).toMatchObject({ port: 54332, sslMode: "disable", database: "appdb" });
        expect(adminConfigFromUrl("postgres://u:p@db.example.com/app")).toMatchObject({ sslMode: "require" });
        expect(adminConfigFromUrl("postgres://u:p@db.example.com/app?sslmode=verify-full").sslMode).toBe("verify-full");
        expect(adminConfigFromUrl("postgres://u:p@db.example.com/app?sslmode=bogus").sslMode).toBe("require");
        expect(adminConfigFromUrl("postgres://u:p@db.example.com").database).toBe("postgres");
    });
});

describe("the app database settings", () => {
    it("are absent without DATABASE_URL, and carry the pooled address when there is one", () => {
        expect(appDbConfigFromEnv({})).toBeUndefined();
        expect(appDbConfigFromEnv({ DATABASE_URL: "   " })).toBeUndefined();
        expect(appDbConfigFromEnv({ DATABASE_URL: "postgres://a", DATABASE_URL_POOLED: "postgres://b" })).toEqual({ url: "postgres://a", poolUrl: "postgres://b" });
        expect(appDbConfigFromEnv({ DATABASE_URL: "postgres://a", DATABASE_URL_POOLED: "" })).toEqual({ url: "postgres://a", poolUrl: undefined });
    });

    it("are described for the log without the user or the password", () => {
        const text = describeDatabaseUrl("postgresql://neondb_owner:very-secret@ep-x.c-7.us-east-2.aws.neon.tech:5432/neondb?sslmode=require");
        expect(text).toBe("ep-x.c-7.us-east-2.aws.neon.tech:5432/neondb");
        expect(text).not.toMatch(/neondb_owner|very-secret/);
        expect(describeDatabaseUrl("not a url")).toBe("the configured database");
    });
});

describe("explicitTls", () => {
    it("spells out the certificate check that sslmode=require already does, and keeps everything else in the string", () => {
        const url = explicitTls("postgresql://neondb_owner:p%40ss@ep-x.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require");
        expect(url).toBe("postgresql://neondb_owner:p%40ss@ep-x.c-7.us-east-2.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require");
        for (const mode of ["prefer", "verify-ca"]) expect(explicitTls(`postgres://u:p@h/db?sslmode=${mode}`)).toContain("sslmode=verify-full");
    });

    it("leaves a string alone that already says what it means, says nothing about TLS, or is not a URL", () => {
        for (const text of ["postgres://u:p@h/db?sslmode=verify-full", "postgres://u:p@127.0.0.1:5432/db?sslmode=disable", "postgres://u:p@h/db", "host=h dbname=db", ""]) expect(explicitTls(text), text).toBe(text);
    });
});

describe("cloud database names", () => {
    const owner = "A10B51B3-F098-4298-BF08-E5D7AD3C38F2";

    it("carry the account and a slug of what it was called", () => {
        expect(cloudDatabaseName(owner, "My Shop!")).toBe("gf_a10b51b3_my_shop");
        expect(cloudDatabaseName(owner, "Café Münster 2")).toBe("gf_a10b51b3_cafe_munster_2");
        expect(cloudDatabaseName(owner, "!!!")).toBe("gf_a10b51b3_database");
        expect(cloudDatabaseName(owner, "x".repeat(100))).toHaveLength("gf_a10b51b3_".length + 40);
        expect(cloudDatabaseName("55ac18d7-6cec-4801-9641-ba4dd7cf0163", "crm")).not.toBe(cloudDatabaseName(owner, "crm"));
    });

    it("are always valid identifiers that this app recognises as its own, and nothing else is", () => {
        for (const wanted of ["My Shop!", "!!!", "x".repeat(100), "2026 plan", "a_b-c d"]) expect(isCloudDatabaseName(cloudDatabaseName(owner, wanted)), wanted).toBe(true);
        for (const other of ["appdb", "neondb", "postgres", "template1", "gf_short_x", "gf_a10b51b3_", "GF_a10b51b3_x", "gf_a10b51b3_x; drop", 'gf_a10b51b3_x"']) expect(isCloudDatabaseName(other), other).toBe(false);
    });

    it("are the only databases it will drop", async () => {
        await expect(dropCloudDatabase({ host: "127.0.0.1", port: 1, user: "u", password: "p", database: "d", sslMode: "disable" }, "neondb")).rejects.toThrow(/not a database this app created/);
    });
});

describe("the role behind a cloud database", () => {
    it("is named like the database, has a password that is safe to write into CREATE ROLE, and differs each time", () => {
        const first = newDatabaseOwner("gf_a10b51b3_shop");
        const second = newDatabaseOwner("gf_a10b51b3_shop");
        expect(first).toMatchObject({ role: "gf_a10b51b3_shop", connectionLimit: 10 });
        expect(first.password).toMatch(/^[A-Za-z0-9_-]{16,}$/);
        expect(first.password).not.toBe(second.password);
    });

    it("is what the saved connection signs in as, with the password encrypted in the row", () => {
        const admin = { host: "db.example.com", port: 5432, user: "app_admin", password: "admin-secret", database: "neondb", sslMode: "require" };
        const owner = newDatabaseOwner("gf_a10b51b3_shop");
        const row = cloudConnectionRow(admin, "gf_a10b51b3_shop", "Shop", owner);
        expect(row).toMatchObject({ name: "Shop", kind: "cloud", username: "gf_a10b51b3_shop", database_name: "gf_a10b51b3_shop", host: "db.example.com", ssl_mode: "require" });
        expect(toConnectionConfig(row)).toMatchObject({ user: "gf_a10b51b3_shop", password: owner.password });
        expect(row.password_ciphertext.toString("utf8")).not.toContain(owner.password);
        expect(JSON.stringify(row)).not.toContain("admin-secret");
    });
});
