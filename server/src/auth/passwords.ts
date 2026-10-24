import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt (built into Node, memory-hard), a fresh salt per password, and the cost parameters stored with each
 * hash so they can be raised later without locking anyone out.
 */
const COST = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

const derive = (password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> =>
    new Promise((resolve, reject) => scrypt(password, salt, KEY_LENGTH, { maxmem: 64 * 1024 * 1024, ...options }, (error, key) => (error ? reject(error) : resolve(key))));

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await derive(password, salt, COST);
    return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, n, r, p, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
    try {
        const expected = Buffer.from(hash, "base64");
        const actual = await derive(password, Buffer.from(salt, "base64"), { N: Number(n), r: Number(r), p: Number(p) });
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

// Verified against when an email is unknown, so "no such account" takes as long as "wrong password".
let decoy: Promise<string> | undefined;
export async function verifyAgainstDecoy(password: string): Promise<false> {
    decoy ??= hashPassword(randomBytes(12).toString("hex"));
    await verifyPassword(password, await decoy);
    return false;
}

export function passwordProblem(password: string): string | undefined {
    if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`;
    if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters for the password.`;
    return undefined;
}
