import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

let cachedKey: Buffer | null = null;

export function getMasterKey(): Buffer {
    if (cachedKey) return cachedKey;

    const raw = process.env.MASTER_KEY;
    if (!raw) {
        throw new Error("MASTER_KEY env var is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
    }

    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) {
        throw new Error(`MASTER_KEY must decode to exactly 32 bytes (got ${key.length}). Regenerate it as a base64-encoded 32-byte value.`);
    }

    cachedKey = key;
    return cachedKey;
}

export interface EncryptedPayload {
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
}

export function encryptSecret(plaintext: string): EncryptedPayload {
    const key = getMasterKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, iv, authTag };
}

export function decryptSecret(payload: EncryptedPayload): string {
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, payload.iv);
    decipher.setAuthTag(payload.authTag);
    const plaintext = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
}
