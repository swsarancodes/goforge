import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "./auth-provider";

const MIN_PASSWORD = 10;

/** Sign in or create an account (both always offered; creating one says so when the server has sign-up turned off). Shown instead of the app until someone is signed in. */
const AuthScreen: React.FC = () => {
    const { signIn, signUp, signupOpen } = useAuth();
    const [mode, setMode] = useState<"signin" | "signup">("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [error, setError] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);

    const creating = mode === "signup";
    const closed = creating && !signupOpen;
    const choose = (next: "signin" | "signup") => {
        setMode(next);
        setError(undefined);
    };
    const tooShort = creating && password.length > 0 && password.length < MIN_PASSWORD;

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (busy || closed) return;
        setBusy(true);
        setError(undefined);
        try {
            if (creating) await signUp(email.trim(), password, name.trim() || undefined);
            else await signIn(email.trim(), password);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setBusy(false);
        }
    };

    return (
        <main className="flex min-h-screen items-center justify-center bg-background px-4">
            <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 shadow-sm" aria-labelledby="auth-title">
                <div role="tablist" aria-label="Sign in or create an account" className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-sm">
                    {([["signin", "Sign in"], ["signup", "Create account"]] as const).map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            role="tab"
                            aria-selected={mode === value}
                            onClick={() => choose(value)}
                            className={`rounded px-3 py-1.5 font-medium transition-colors ${mode === value ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                <div className="space-y-1">
                    <h1 id="auth-title" className="text-lg font-semibold">{creating ? "Create your account" : "Sign in to GoForge"}</h1>
                    <p className="text-sm text-muted-foreground">
                        {creating ? "Your diagrams and databases are saved to your account." : "Your diagrams and databases are waiting where you left them."}
                    </p>
                </div>

                {creating && (
                    <div className="space-y-1.5">
                        <Label htmlFor="auth-name">Name <span className="text-muted-foreground">(optional)</span></Label>
                        <Input id="auth-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={100} />
                    </div>
                )}
                <div className="space-y-1.5">
                    <Label htmlFor="auth-email">Email</Label>
                    <Input id="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required autoFocus />
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="auth-password">Password</Label>
                    <Input id="auth-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={creating ? "new-password" : "current-password"} required aria-invalid={tooShort} />
                    {creating && <p className={tooShort ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>At least {MIN_PASSWORD} characters.</p>}
                </div>

                {closed && (
                    <Alert role="status">
                        <AlertDescription>Sign-up is turned off on this server. Whoever runs it can turn it on with <code>ALLOW_SIGNUP=true</code>, or create your account for you.</AlertDescription>
                    </Alert>
                )}

                {error && (
                    <Alert variant="destructive" role="alert">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}

                <Button type="submit" className="w-full" disabled={busy || closed || !email || !password || tooShort}>
                    {busy ? (creating ? "Creating account…" : "Signing in…") : creating ? "Create account" : "Sign in"}
                </Button>

            </form>
        </main>
    );
};

export default AuthScreen;
