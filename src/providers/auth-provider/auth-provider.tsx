import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AccountUser, AuthApiError, CloudDatabaseQuota, fetchSession, signIn as apiSignIn, signOut as apiSignOut, signUp as apiSignUp } from "@/lib/auth-api";
import AuthScreen from "./auth-screen";

type Status = "loading" | "unreachable" | "local" | "signed-out" | "signed-in";

interface AuthContextValue {
    status: Status;
    /** Accounts are on (the server has a Postgres application database). Off means one anonymous workspace, as before. */
    cloud: boolean;
    user?: AccountUser;
    signupOpen: boolean;
    cloudDatabases?: CloudDatabaseQuota;
    signIn(email: string, password: string): Promise<void>;
    signUp(email: string, password: string, displayName?: string): Promise<void>;
    signOut(): Promise<void>;
    /** Re-reads who is signed in and the cloud database quota (after creating or deleting one). */
    refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
    status: "local",
    cloud: false,
    signupOpen: false,
    signIn: async () => undefined,
    signUp: async () => undefined,
    signOut: async () => undefined,
    refresh: async () => undefined,
});

export const useAuth = () => useContext(AuthContext);

const isApiCall = (input: RequestInfo | URL): boolean => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = url.startsWith("http") ? new URL(url).pathname : url;
    return path.startsWith("/api/") && !path.startsWith("/api/auth/");
};

/**
 * Knows who is signed in. With accounts on, nothing of the app is shown until someone is; with them off it steps aside. A session that
 * ends while the app is open (any /api call answered 401) sends the person back to the sign-in screen instead of leaving a broken page.
 */
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [status, setStatus] = useState<Status>("loading");
    const [user, setUser] = useState<AccountUser | undefined>(undefined);
    const [signupOpen, setSignupOpen] = useState(false);
    const [cloudDatabases, setCloudDatabases] = useState<CloudDatabaseQuota | undefined>(undefined);
    const [loadError, setLoadError] = useState<string | undefined>(undefined);

    const refresh = useCallback(async () => {
        try {
            const session = await fetchSession();
            setLoadError(undefined);
            if (session.mode === "local") {
                setStatus("local");
                return;
            }
            setSignupOpen(session.signupOpen);
            setUser(session.user ?? undefined);
            setCloudDatabases(session.cloudDatabases);
            setStatus(session.user ? "signed-in" : "signed-out");
        } catch (error) {
            // A server from before accounts existed has no such route: it is local mode, not a broken server.
            if (error instanceof AuthApiError && error.status === 404) {
                setStatus("local");
                return;
            }
            setLoadError(error instanceof Error ? error.message : String(error));
            setStatus("unreachable");
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // Any API answer of 401 means the session is gone.
    const signedIn = useRef(false);
    signedIn.current = status === "signed-in";
    useEffect(() => {
        const original = window.fetch;
        window.fetch = async (...args: Parameters<typeof fetch>) => {
            const response = await original(...args);
            if (response.status === 401 && signedIn.current && isApiCall(args[0])) {
                setUser(undefined);
                setStatus("signed-out");
            }
            return response;
        };
        return () => {
            window.fetch = original;
        };
    }, []);

    const signIn = useCallback(async (email: string, password: string) => {
        const result = await apiSignIn({ email, password });
        setUser(result.user);
        await refresh();
    }, [refresh]);

    const signUp = useCallback(async (email: string, password: string, displayName?: string) => {
        const result = await apiSignUp({ email, password, displayName: displayName || undefined });
        setUser(result.user);
        await refresh();
    }, [refresh]);

    const signOut = useCallback(async () => {
        await apiSignOut().catch(() => undefined);
        // Everything held in memory belonged to that account (table pages, remembered connections); a reload starts clean.
        window.location.reload();
    }, []);

    const value = useMemo<AuthContextValue>(
        () => ({ status, cloud: status === "signed-in" || status === "signed-out", user, signupOpen, cloudDatabases, signIn, signUp, signOut, refresh }),
        [status, user, signupOpen, cloudDatabases, signIn, signUp, signOut, refresh],
    );

    if (status === "loading") return <div role="status" aria-busy="true" className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
    if (status === "unreachable") {
        return (
            <div role="alert" className="mx-auto flex h-screen max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
                <p className="text-sm font-medium">The GoForge server did not answer.</p>
                <p className="break-words text-xs text-muted-foreground">{loadError}</p>
                <button type="button" className="rounded-md border px-3 py-1.5 text-sm hover:bg-secondary" onClick={() => void refresh()}>Try again</button>
            </div>
        );
    }
    if (status === "signed-out") return <AuthContext.Provider value={value}><AuthScreen /></AuthContext.Provider>;
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export { AuthApiError };
