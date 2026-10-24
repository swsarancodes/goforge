export interface AccountUser {
    id: string;
    email: string;
    displayName: string;
    isAdmin: boolean;
}

export interface CloudDatabaseQuota {
    limit: number;
    used: number;
}

/** What the server says before anything is shown: no accounts (local mode), or accounts with nobody signed in, or someone signed in. */
export type SessionInfo =
    | { mode: "local" }
    | { mode: "cloud"; user: AccountUser | null; signupOpen: boolean; cloudDatabases?: CloudDatabaseQuota };

export class AuthApiError extends Error {
    constructor(message: string, public status: number) {
        super(message);
        this.name = "AuthApiError";
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/auth${path}`, { headers: { "Content-Type": "application/json" }, ...init });
    if (!response.ok) {
        let message = response.statusText || "Something went wrong";
        try {
            const body = await response.json();
            if (typeof body?.error === "string") message = body.error;
        } catch {
            // not JSON: the status text will do
        }
        throw new AuthApiError(message, response.status);
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export const fetchSession = (signal?: AbortSignal) => request<SessionInfo>("/me", { signal });
export const signUp = (input: { email: string; password: string; displayName?: string }) => request<{ user: AccountUser }>("/signup", { method: "POST", body: JSON.stringify(input) });
export const signIn = (input: { email: string; password: string }) => request<{ user: AccountUser }>("/login", { method: "POST", body: JSON.stringify(input) });
export const signOut = () => request<void>("/logout", { method: "POST" });
