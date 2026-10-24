import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

// The store opens its database when it is first imported, so point it at a throwaway file first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goforge-ai-store-"));
process.env.SQLITE_PATH = path.join(dir, "test.db");
process.env.MASTER_KEY = randomBytes(32).toString("base64");

const { createSqliteAiStores, AUDIT_RETENTION } = await import("./ai-store.js");
const { DEFAULT_SETTINGS } = await import("../ai/policy.js");
const { getDb } = await import("./store.js");
const db = getDb();
const { encryptSecret } = await import("../crypto/vault.js");

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("SQLite AI stores", () => {
    const { settings, audit } = createSqliteAiStores();

    it("starts from the defaults", () => {
        expect(settings.read()).toEqual({ settings: { ...DEFAULT_SETTINGS } });
    });

    it("keeps the settings, and reads settings saved by an earlier version for another kind of endpoint without the parts that no longer apply", () => {
        settings.write({ ...DEFAULT_SETTINGS, model: "gpt-5.6-luna", allowedModels: ["gpt-5.6-*"], redactNames: true });
        expect(settings.read()).toEqual({ settings: { ...DEFAULT_SETTINGS, model: "gpt-5.6-luna", allowedModels: ["gpt-5.6-*"], redactNames: true } });

        // a row as an earlier version wrote it, with an endpoint, a key and training-tier patterns
        const secret = "sk-this-must-not-survive-1234";
        const key = encryptSecret(secret);
        db.prepare("UPDATE ai_settings SET json = ?, key_ciphertext = ?, key_iv = ?, key_auth_tag = ? WHERE id = 1").run(
            JSON.stringify({ provider: "custom", baseUrl: "https://llm.example/v1", model: "house-gpt", apiStyle: "chat", allowedModels: ["house-*"], blockTrainingTiers: true, trainingPatterns: ["free"], redactNames: true, timeoutMs: 60000 }),
            key.ciphertext, key.iv, key.authTag,
        );
        expect(settings.read().settings).toMatchObject({ model: "", allowedModels: [], redactNames: true });
        expect(settings.read().settings).not.toHaveProperty("baseUrl");

        // saving anything erases the stored key, so no credential for a service that is no longer used stays on disk
        settings.write(settings.read().settings);
        expect(db.prepare("SELECT key_ciphertext FROM ai_settings WHERE id = 1").get()).toEqual({ key_ciphertext: null });
        const onDisk = fs.readFileSync(path.join(dir, "test.db"));
        const wal = fs.existsSync(path.join(dir, "test.db-wal")) ? fs.readFileSync(path.join(dir, "test.db-wal")) : Buffer.alloc(0);
        expect(onDisk.includes(secret) || wal.includes(secret)).toBe(false);
    });

    it("reads settings saved while Amazon Bedrock was the endpoint without the model, region or allow-list, which mean nothing to OpenAI", () => {
        db.prepare("UPDATE ai_settings SET json = ? WHERE id = 1").run(JSON.stringify({ region: "us-east-1", model: "deepseek.v3.2", allowedModels: ["global.anthropic.*"], timeoutMs: 90000, redactNames: true }));
        const read = settings.read().settings;
        expect(read).toMatchObject({ model: "", allowedModels: [], timeoutMs: 120000, redactNames: true });
        expect(read).not.toHaveProperty("region");

        settings.write({ ...read, model: "gpt-5.6-luna" });
        expect(JSON.parse((db.prepare("SELECT json FROM ai_settings WHERE id = 1").get() as { json: string }).json)).not.toHaveProperty("region");
        expect(settings.read().settings.model).toBe("gpt-5.6-luna");
    });

    it("records, lists newest first, finds one and keeps the detail", () => {
        const first = audit.record({ kind: "model-call", purpose: "schema-plan", status: "ok", model: "m", redacted: true, requestChars: 100, payload: '{"instructions":"x"}', sha256: "ab", detail: { tables: ["a.b"] } });
        const second = audit.record({ kind: "runbook-opened", purpose: "schema-plan", status: "ok", parentId: first, detail: { steps: 3 } });
        expect(second).toBeGreaterThan(first);
        const listed = audit.list({ limit: 10 });
        expect(listed.map((entry) => entry.id)).toEqual([second, first]);
        expect(audit.get(first)).toMatchObject({ kind: "model-call", redacted: true, requestChars: 100, payload: '{"instructions":"x"}', detail: { tables: ["a.b"] } });
        expect(audit.get(second)).toMatchObject({ parentId: first, detail: { steps: 3 } });
        expect(audit.list({ sinceId: first }).map((entry) => entry.id)).toEqual([second]);
        expect(audit.get(9999)).toBeUndefined();
    });

    it("keeps only the newest entries", () => {
        let last = 0;
        for (let i = 0; i < 25; i++) last = audit.record({ kind: "model-call", purpose: "retention", status: "ok" });
        expect(AUDIT_RETENTION).toBe(5000);
        expect(audit.list({ limit: 5000 }).length).toBeLessThanOrEqual(AUDIT_RETENTION);
        expect(audit.get(last)).toBeDefined();
    });
});
