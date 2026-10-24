import { useMemo, useState } from "react";
import { RefreshCw, Search, Table2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { connectionAddress, connectionLabel } from "@/lib/live-connection-api";
import { cn } from "@/lib/utils";
import type { ScopeReason } from "@/lib/schema-change-api";
import { formatBytes, formatRows } from "../format";
import type { SchemaChange } from "../use-schema-change";

const SHOWN = 150;
const WIDTHS = ["w-28", "w-36", "w-24", "w-32", "w-40", "w-28", "w-36", "w-24"];

export function describeReason(reason: ScopeReason): string {
    switch (reason.kind) {
        case "name":
            return `name matches “${reason.words.join(" ")}”`;
        case "column":
            return `column ${reason.columns.join(", ")}`;
        case "referenced-by":
            return `referenced by ${reason.from}`;
        case "references":
            return `references ${reason.from}`;
    }
}

const ListSkeleton: React.FC = () => (
    <div role="status" aria-busy="true" className="px-2 pt-1">
        <span className="sr-only">Loading tables</span>
        {WIDTHS.map((width, index) => (
            <div key={index} className="flex items-center gap-2 px-2 py-2">
                <Skeleton className="size-3.5 shrink-0 rounded-sm" />
                <Skeleton className={cn("h-3.5", width)} />
            </div>
        ))}
    </div>
);

/** The tables that will be read and sent: chosen ones first, with why each was chosen, then every table in the database to add from. */
export const ScopeList: React.FC<{ state: SchemaChange; onPicked?: () => void }> = ({ state }) => {
    const [filter, setFilter] = useState("");
    const chosen = useMemo(() => new Set(state.selected), [state.selected]);
    const byName = useMemo(() => new Map((state.catalog?.tables ?? []).map((table) => [table.qualified, table])), [state.catalog]);

    const matches = useMemo(() => {
        const text = filter.trim().toLowerCase();
        const all = state.catalog?.tables ?? [];
        return (text ? all.filter((table) => table.qualified.toLowerCase().includes(text)) : all).filter((table) => !chosen.has(table.qualified));
    }, [state.catalog, filter, chosen]);

    return (
        <div className="flex h-full min-h-0 min-w-0 flex-col">
            <div className="shrink-0 space-y-2 p-3">
                <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Connection</Label>
                    <Select value={state.connectionId} onValueChange={state.changeConnection}>
                        <SelectTrigger size="sm" className="h-8 w-full min-w-0" aria-label="Connection">
                            <SelectValue placeholder={state.connections.length === 0 ? "No saved connections" : "Pick a connection"} />
                        </SelectTrigger>
                        <SelectContent>
                            {state.connections.map((connection) => (
                                <SelectItem key={connection.id} value={connection.id} title={connectionAddress(connection)}>
                                    {connectionLabel(connection, state.connections)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex items-center gap-2">
                    <div className="relative min-w-0 flex-1">
                        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Find a table to add…" className="h-8 bg-secondary pl-7 dark:bg-background" disabled={!state.catalog} />
                    </div>
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => void state.refreshCatalog()} disabled={!state.connectionId || state.loadingCatalog} aria-label="Read the table list again" title="Read the table list again">
                        <RefreshCw className={cn("size-3.5", state.loadingCatalog && "animate-spin")} />
                    </Button>
                </div>
                {state.catalog && (
                    <p className="text-[11px] text-muted-foreground">
                        {state.catalog.tables.length.toLocaleString()} tables · PostgreSQL {state.catalog.serverVersion.split(" ")[0]}
                    </p>
                )}
            </div>
            <Separator />

            <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2" aria-label="Tables">
                {(state.loadingConnections || state.loadingCatalog) && !state.catalog && <ListSkeleton />}
                {!state.loadingConnections && state.connections.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">No saved connections yet. Add one from File → Connect Live Database.</p>}
                {state.catalogError && <p className="px-2 py-1 text-sm text-destructive break-words">{state.catalogError}</p>}

                {state.selected.length > 0 && (
                    <div className="mb-3">
                        <div className="flex items-center justify-between px-2 pb-1">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">In scope · {state.selected.length}</p>
                            <button type="button" className="text-[11px] text-muted-foreground underline-offset-2 hover:underline" onClick={state.clearScope}>
                                Clear
                            </button>
                        </div>
                        {state.selected.map((qualified) => {
                            const table = byName.get(qualified);
                            const why = state.reasons.get(qualified);
                            return (
                                <div key={qualified} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
                                    <Table2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm" title={qualified}>{qualified}</p>
                                        <p className="truncate text-[11px] text-muted-foreground">
                                            {table ? `${formatRows(table.estimatedRows)} · ${formatBytes(table.totalBytes)}` : "not found"}
                                            {why ? ` · ${why.reasons.map(describeReason).join("; ")}` : why === undefined && state.scope ? " · added by you" : ""}
                                        </p>
                                    </div>
                                    <button type="button" className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground" onClick={() => state.toggleTable(qualified, false)} aria-label={`Remove ${qualified} from the scope`}>
                                        <X className="size-3.5" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}

                {state.catalog && (
                    <div>
                        {state.selected.length === 0 && !filter && (
                            <p className="px-2 pb-2 text-[11px] leading-relaxed text-muted-foreground">
                                Optional. Leave this empty and the tables your request names are found for you; a request for new tables needs none. Tick tables to make sure they are included.
                            </p>
                        )}
                        <p className="px-2 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{filter ? "Matching tables" : "All tables"}</p>
                        {matches.slice(0, SHOWN).map((table) => (
                            <label key={table.qualified} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                                <input type="checkbox" className="size-3.5 accent-primary" checked={false} onChange={() => state.toggleTable(table.qualified, true)} />
                                <span className="min-w-0 flex-1 truncate" title={table.qualified}>{table.qualified}</span>
                                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{formatRows(table.estimatedRows)}</span>
                            </label>
                        ))}
                        {matches.length > SHOWN && <p className="px-2 py-1 text-xs text-muted-foreground">{(matches.length - SHOWN).toLocaleString()} more. Type to narrow the list.</p>}
                        {matches.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">{filter ? "No table matches." : "Every table is in the scope."}</p>}
                    </div>
                )}
            </nav>
        </div>
    );
};
