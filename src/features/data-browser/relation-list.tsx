import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, RefreshCw, Search, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { connectionAddress, connectionLabel } from "@/lib/live-connection-api";
import { cn } from "@/lib/utils";
import { formatRowEstimate, groupRelations } from "@/utils/data-view/relations";
import type { DataBrowser } from "./use-data-browser";

interface RelationListProps {
    browser: DataBrowser;
    /** Called after a table/view is picked (the mobile drawer closes itself here). */
    onPicked?: () => void;
}

const NAME_WIDTHS = ["w-24", "w-32", "w-20", "w-28", "w-36", "w-24", "w-32", "w-20", "w-28"];

/** Placeholder rows shaped like the real list (schema label, then icon + name) while tables are being read. */
const RelationListSkeleton: React.FC = () => (
    <div role="status" aria-busy="true" className="px-2 pt-1">
        <span className="sr-only">Loading tables</span>
        <Skeleton className="h-2.5 w-12 mb-3" />
        {NAME_WIDTHS.map((width, index) => (
            <div key={index} className="flex items-center gap-2 px-2 py-2">
                <Skeleton className="size-3.5 shrink-0 rounded-sm" />
                <Skeleton className={cn("h-3.5", width)} />
            </div>
        ))}
    </div>
);

/** Connection picker plus the browsable list of tables and views, grouped by schema. */
const RelationList: React.FC<RelationListProps> = ({ browser, onPicked }) => {
    const { t } = useTranslation();
    const [filter, setFilter] = useState<string>("");

    const groups = useMemo(() => groupRelations(browser.relations, filter), [browser.relations, filter]);

    // Resting the pointer (or keyboard focus) on a table reads its first page ahead of the click.
    const prefetchTimer = useRef<number | undefined>(undefined);
    const prefetchSoon = (key: string) => {
        window.clearTimeout(prefetchTimer.current);
        prefetchTimer.current = window.setTimeout(() => void browser.prefetchRelation(key), 120);
    };
    const cancelPrefetch = () => window.clearTimeout(prefetchTimer.current);
    useEffect(() => () => window.clearTimeout(prefetchTimer.current), []);

    return (
        <div className="flex flex-col h-full min-h-0 min-w-0">
            <div className="p-3 space-y-2 shrink-0">
                <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">{t("data_browser.connection", { defaultValue: "Connection" })}</Label>
                    <Select value={browser.connectionId} onValueChange={(id) => browser.changeConnection(id)}>
                        <SelectTrigger size="sm" className="w-full min-w-0 h-8" aria-label={t("data_browser.connection", { defaultValue: "Connection" })}>
                            <SelectValue
                                placeholder={
                                    browser.connections.length === 0
                                        ? t("modals.connect_live_database.no_connections")
                                        : t("data_browser.pick_connection", { defaultValue: "Pick a connection" })
                                }
                            />
                        </SelectTrigger>
                        <SelectContent>
                            {browser.connections.map((conn) => (
                                <SelectItem key={conn.id} value={conn.id} title={connectionAddress(conn)}>
                                    {connectionLabel(conn, browser.connections)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex items-center gap-2">
                    <div className="relative flex-1 min-w-0">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                        <Input
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            placeholder={t("data_browser.filter", { defaultValue: "Filter tables and views..." })}
                            className="h-8 pl-7 bg-secondary dark:bg-background"
                            disabled={browser.relations.length === 0}
                        />
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={browser.refreshRelations}
                        disabled={!browser.connectionId || browser.isLoadingRelations || browser.isRefreshingRelations}
                        aria-label={t("data_browser.refresh_list", { defaultValue: "Refresh table list" })}
                        title={t("data_browser.refresh_list", { defaultValue: "Refresh table list" })}
                    >
                        <RefreshCw className={cn("size-3.5", (browser.isLoadingRelations || browser.isRefreshingRelations) && "animate-spin")} />
                    </Button>
                </div>
            </div>
            <Separator />

            <nav className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-2" aria-label={t("data_browser.tables", { defaultValue: "Tables" })}>
                {(browser.isLoadingConnections || browser.isLoadingRelations) && browser.relations.length === 0 && <RelationListSkeleton />}

                {!browser.isLoadingConnections && browser.connections.length === 0 && (
                    <p className="px-2 py-1 text-sm text-muted-foreground">
                        {t("data_browser.no_connections_hint", { defaultValue: "No saved connections yet. Add one from File > Connect Live Database." })}
                    </p>
                )}

                {browser.connectionId && !browser.isLoadingRelations && browser.relations.length === 0 && (
                    <p className="px-2 py-1 text-sm text-muted-foreground">{t("data_browser.no_relations", { defaultValue: "No tables or views found in this database." })}</p>
                )}

                {browser.relations.length > 0 && groups.length === 0 && (
                    <p className="px-2 py-1 text-sm text-muted-foreground">{t("data_browser.no_matches", { defaultValue: "No matches." })}</p>
                )}

                {groups.map(([schema, list]) => (
                    <div key={schema} className="mb-2">
                        <p className="px-2 pt-1 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground truncate">{schema}</p>
                        {list.map((relation) => {
                            const active = relation.key === browser.selectedKey;
                            return (
                                <button
                                    key={relation.key}
                                    type="button"
                                    onClick={() => {
                                        browser.selectRelation(relation.key);
                                        onPicked?.();
                                    }}
                                    aria-current={active ? "true" : undefined}
                                    onMouseEnter={() => prefetchSoon(relation.key)}
                                    onFocus={() => prefetchSoon(relation.key)}
                                    onMouseLeave={cancelPrefetch}
                                    onBlur={cancelPrefetch}
                                    title={`${relation.schema}.${relation.name} (${relation.kind})`}
                                    className={cn(
                                        "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent min-w-0",
                                        active && "bg-accent font-medium",
                                    )}
                                >
                                    {relation.kind === "table" ? (
                                        <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
                                    ) : (
                                        <Eye className="size-3.5 shrink-0 text-muted-foreground" />
                                    )}
                                    <span className="truncate">{relation.name}</span>
                                    <span className="ml-auto shrink-0 flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                                        {relation.kind !== "table" && (
                                            <span className="text-[10px] uppercase">{relation.kind === "view" ? "view" : relation.kind === "materialized view" ? "mat." : "ext."}</span>
                                        )}
                                        {formatRowEstimate(relation.estimatedRows)}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                ))}
            </nav>
        </div>
    );
};

export default RelationList;
