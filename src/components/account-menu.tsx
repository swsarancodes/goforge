import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAuth } from "@/providers/auth-provider/auth-provider";
import { useCloudSyncStatus } from "@/features/cloud-sync/cloud-sync-provider";

/** Who is signed in, and a way out. Only shown when the server has accounts. */
export function AccountMenu() {
    const { status, user, signOut } = useAuth();
    const sync = useCloudSyncStatus();
    if (status !== "signed-in" || !user) return null;

    const initial = (user.displayName || user.email).trim().charAt(0).toUpperCase() || "?";
    return (
        <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="size-8 rounded-full text-xs font-semibold" aria-label={`Account: ${user.email}`}>
                    {initial}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuLabel className="space-y-0.5">
                    <span className="block truncate text-sm font-medium">{user.displayName || user.email}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">{user.email}{user.isAdmin ? " · admin" : ""}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <p className={`px-2 py-1.5 text-xs ${sync.state === "error" ? "text-destructive" : "text-muted-foreground"}`} role="status">
                    {sync.state === "syncing" ? "Saving to your account…" : sync.state === "error" ? `Not saved to your account: ${sync.error}` : sync.state === "saved" ? `Saved to your account${sync.lastSyncedAt ? ` · ${sync.lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}` : "Your diagrams are saved to your account."}
                </p>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void signOut()}>
                    <LogOut className="size-4" /> Sign out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
