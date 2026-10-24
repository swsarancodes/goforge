import { Router } from "express";
import { z } from "zod";
import { AttemptLimiter } from "../auth/rate-limit.js";
import { MAX_PASSWORD_LENGTH, hashPassword, passwordProblem, verifyAgainstDecoy, verifyPassword } from "../auth/passwords.js";
import { endSession, startSession } from "../auth/sessions.js";
import { handle } from "./async-handler.js";
import { EmailTakenError, getCloud, getConnectionStore, type UserRecord } from "../db/stores.js";

export const authRouter = Router();

const publicUser = (user: UserRecord) => ({ id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin });

const credentials = z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});
const signupSchema = credentials.extend({ displayName: z.string().trim().max(100).optional() });

// Ten wrong passwords for one account from one address in fifteen minutes, then wait.
const logins = new AttemptLimiter(10, 15 * 60 * 1000);
const signups = new AttemptLimiter(20, 60 * 60 * 1000);
const keyFor = (ip: string | undefined, email: string) => `${ip ?? "?"}|${email}`;

/** What the browser needs before it shows anything: whether there are accounts at all, who is signed in, and what the account may create. */
authRouter.get("/me", handle(async (req, res) => {
    const cloud = getCloud();
    if (!cloud) return res.json({ mode: "local" });
    const signupOpen = cloud.allowSignup || (await cloud.users.count()) === 0;
    if (!req.auth) return res.json({ mode: "cloud", user: null, signupOpen });
    const used = await getConnectionStore().countCloud(req.auth.userId);
    res.json({
        mode: "cloud",
        user: { id: req.auth.userId, email: req.auth.email, displayName: req.auth.displayName, isAdmin: req.auth.isAdmin },
        signupOpen,
        cloudDatabases: { limit: cloud.maxDatabasesPerUser, used },
    });
}));

authRouter.post("/signup", handle(async (req, res) => {
    const cloud = getCloud();
    if (!cloud) return res.status(404).json({ error: "Accounts are not enabled on this server." });
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the email and password." });
    const { email, password, displayName } = parsed.data;

    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    const limitKey = keyFor(req.ip, "signup");
    if (signups.isBlocked(limitKey)) return res.status(429).json({ error: "Too many sign-ups from here. Try again later." });

    try {
        const first = (await cloud.users.count()) === 0;
        if (!first && !cloud.allowSignup) return res.status(403).json({ error: "Sign-up is closed on this server. Ask the admin to create your account." });
        signups.fail(limitKey);
        const user = await cloud.users.create({ email, displayName: displayName || email.split("@")[0], passwordHash: await hashPassword(password), isAdmin: first });
        await startSession(cloud.sessions, user, req, res, cloud.secureCookies);
        res.status(201).json({ user: publicUser(user) });
    } catch (error) {
        if (error instanceof EmailTakenError) return res.status(409).json({ error: error.message });
        throw error;
    }
}));

authRouter.post("/login", handle(async (req, res) => {
    const cloud = getCloud();
    if (!cloud) return res.status(404).json({ error: "Accounts are not enabled on this server." });
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter your email and password." });
    const { email, password } = parsed.data;

    const key = keyFor(req.ip, email);
    if (logins.isBlocked(key)) {
        res.setHeader("Retry-After", String(logins.retryAfterSeconds(key)));
        return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
    }

    const user = await cloud.users.findByEmail(email);
    const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyAgainstDecoy(password);
    if (!user || !ok) {
        logins.fail(key);
        return res.status(401).json({ error: "That email and password do not match an account." });
    }
    logins.succeed(key);
    await startSession(cloud.sessions, user, req, res, cloud.secureCookies);
    res.json({ user: publicUser(user) });
}));

authRouter.post("/logout", handle(async (req, res) => {
    const cloud = getCloud();
    if (cloud) await endSession(cloud.sessions, req, res, cloud.secureCookies);
    res.status(204).end();
}));
