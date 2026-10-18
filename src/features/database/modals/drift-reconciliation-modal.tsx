import React, { useCallback, useEffect, useState } from "react";
import Modal, { ModalProps } from "@/components/modal";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useDatabase, useDatabaseOperations } from "@/providers/database-provider/database-provider";
import { useVersionHistoryActions } from "@/hooks/use-version-history";
import { getRenderer } from "@/utils/render/render-uttils";
import { fromIntrospection } from "@/utils/import/from-introspection";
import { detectDrift, buildReconciliationPlan } from "@/utils/drift/detector";
import { DriftItem, DriftReport, DriftResolution, ReconciliationPlan } from "@/utils/drift/types";
import {
    SavedConnection,
    executeSql,
    introspectSavedConnection,
    listSavedConnections,
} from "@/lib/live-connection-api";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { useToast } from "@/components/ui/use-toast";
import CodeEditor from "@/components/code-editor";
import {
    Activity,
    ArrowDownLeft,
    ArrowUpRight,
    CheckCircle2,
    EyeOff,
    GitCompare,
    Loader2,
    RefreshCw,
    ShieldAlert,
    Zap,
} from "lucide-react";

export const DriftReconciliationModal: React.FC<ModalProps> = ({ isOpen, onOpenChange }) => {
    const { database } = useDatabase();
    const { data_types } = useDatabaseOperations();
    const { applyRecorded } = useVersionHistoryActions();
    const raise = useToast();

    const [connections, setConnections] = useState<SavedConnection[]>([]);
    const [connectionId, setConnectionId] = useState<string | undefined>(undefined);
    const [liveDb, setLiveDb] = useState<DatabaseType | undefined>(undefined);

    const [isScanning, setIsScanning] = useState<boolean>(false);
    const [report, setReport] = useState<DriftReport | undefined>(undefined);
    const [items, setItems] = useState<DriftItem[]>([]);
    const [plan, setPlan] = useState<ReconciliationPlan | undefined>(undefined);
    const [isReviewing, setIsReviewing] = useState<boolean>(false);
    const [isExecuting, setIsExecuting] = useState<boolean>(false);

    useEffect(() => {
        if (isOpen) {
            listSavedConnections().then(setConnections).catch(() => setConnections([]));
            setReport(undefined);
            setItems([]);
            setPlan(undefined);
            setIsReviewing(false);
        }
    }, [isOpen]);

    const runScan = useCallback(async (id: string) => {
        if (!database) return;
        setIsScanning(true);
        setReport(undefined);
        setPlan(undefined);
        setIsReviewing(false);
        try {
            const introspection = await introspectSavedConnection(id);
            const { tables, relationships, indexes, views, sequences, errors } = fromIntrospection(introspection, data_types);
            if (errors.length > 0) console.warn("Introspection warnings:", errors);

            for (const table of tables) {
                (table as any).indices = indexes.filter((idx: any) => idx.tableId === table.id);
            }

            const live: DatabaseType = {
                id: database.id,
                name: database.name,
                dialect: database.dialect,
                numOfTables: tables.length,
                createdAt: null,
                tables: tables as any,
                relationships: relationships as any,
                views: views as any,
                sequences: sequences as any,
            } as DatabaseType;

            setLiveDb(live);
            const detected = detectDrift(database, live, "pull");
            setReport(detected);
            setItems(detected.items);
        } catch (error) {
            raise("Scan Failed", error instanceof Error ? error.message : String(error), "DESTRUCTIVE");
        } finally {
            setIsScanning(false);
        }
    }, [database, data_types, raise]);

    const setItemResolution = (id: string, resolution: DriftResolution) => {
        setItems(prev => prev.map(item => item.id === id ? { ...item, resolution } : item));
    };

    const setAllResolutions = (resolution: DriftResolution) => {
        setItems(prev => prev.map(item => ({ ...item, resolution })));
    };

    const preparePlan = useCallback(async () => {
        if (!database || !liveDb || !report) return;
        const renderer = getRenderer(database.dialect, data_types);
        const updatedReport: DriftReport = { ...report, items };
        const calculatedPlan = await buildReconciliationPlan(updatedReport, database, liveDb, renderer);
        setPlan(calculatedPlan);
        setIsReviewing(true);
    }, [database, liveDb, report, items, data_types]);

    const executePlan = useCallback(async () => {
        if (!plan || !database || !connectionId) return;
        setIsExecuting(true);
        try {
            // 1. Execute Push SQL against live database if requested
            if (plan.pushCount > 0 && plan.pushSql.trim()) {
                const execResult = await executeSql(connectionId, plan.pushSql);
                if (execResult.error) {
                    throw new Error(`Live database push failed: ${execResult.error}`);
                }
            }

            // 2. Apply Pull operations to local canvas if requested
            if (plan.pullCount > 0 && plan.pullOperations.length > 0) {
                await applyRecorded(plan.pullOperations, {
                    name: `Drift Reconciliation (${plan.pullCount} pulled, ${plan.pushCount} pushed)`,
                    origin: "manual",
                });
            }

            raise(
                "Reconciliation Complete",
                `Successfully synced schema (${plan.pullCount} pulled to canvas, ${plan.pushCount} pushed to live).`,
                "SUCCESS"
            );
            onOpenChange?.(false);
        } catch (error) {
            raise("Reconciliation Failed", error instanceof Error ? error.message : String(error), "DESTRUCTIVE");
        } finally {
            setIsExecuting(false);
        }
    }, [plan, database, connectionId, applyRecorded, raise, onOpenChange]);

    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            size="4xl"
            title="Live Database Drift & Reconciliation"
            description="Inspect schema divergence between the canvas and a live database with safe 3-way reconciliation."
        >
            <div className="flex flex-col gap-4 max-h-[75vh]">
                {/* Connection Picker */}
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 rounded-lg border bg-muted/20">
                    <div className="flex items-center gap-2.5 w-full sm:w-auto">
                        <Activity className="h-4 w-4 text-primary shrink-0" />
                        <span className="text-xs font-semibold">Live Database Target:</span>
                        <Select
                            value={connectionId}
                            onValueChange={(id) => {
                                setConnectionId(id);
                                runScan(id);
                            }}
                        >
                            <SelectTrigger className="h-8 w-60 text-xs">
                                <SelectValue placeholder="Select a connected database" />
                            </SelectTrigger>
                            <SelectContent>
                                {connections.map((c) => (
                                    <SelectItem key={c.id} value={c.id} className="text-xs">
                                        {c.name} ({c.dialect})
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {connectionId && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => runScan(connectionId)}
                            disabled={isScanning}
                            className="h-8 text-xs gap-1.5 shrink-0"
                        >
                            {isScanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            Re-scan Drift
                        </Button>
                    )}
                </div>

                {/* Scan State / Results */}
                {isScanning ? (
                    <div className="flex flex-col items-center justify-center p-12 text-center border rounded-lg bg-card/40">
                        <Loader2 className="h-8 w-8 animate-spin text-primary mb-2" />
                        <span className="text-sm font-semibold">Introspecting live database...</span>
                        <span className="text-xs text-muted-foreground mt-0.5">Comparing canvas objects against remote metadata</span>
                    </div>
                ) : !report ? (
                    <div className="p-8 text-center border rounded-lg bg-card/40 text-muted-foreground text-xs">
                        Select a connected database above to begin drift detection.
                    </div>
                ) : report.summary.inSync ? (
                    <div className="flex flex-col items-center justify-center p-10 border rounded-lg bg-emerald-500/5 border-emerald-500/30 text-center">
                        <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-2" />
                        <h3 className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">Schemas Are Fully In Sync</h3>
                        <p className="text-xs text-muted-foreground max-w-sm mt-1">
                            No divergence detected between the canvas design and the live {report.liveDialect} database.
                        </p>
                    </div>
                ) : isReviewing && plan ? (
                    /* Plan Review State */
                    <div className="flex flex-col gap-3">
                        <div className="p-3 rounded-lg border bg-amber-500/10 border-amber-500/30 flex items-start gap-2.5">
                            <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                            <div className="text-xs space-y-1">
                                <span className="font-semibold text-foreground">Reconciliation Execution Plan</span>
                                <p className="text-muted-foreground">
                                    {plan.pullCount} object(s) will be pulled onto the canvas. {plan.pushCount} statement(s) will be executed on the live database. {plan.ignoredCount} item(s) ignored.
                                </p>
                            </div>
                        </div>

                        {plan.pushCount > 0 && plan.pushSql && (
                            <div className="space-y-1.5">
                                <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                                    <ArrowUpRight className="h-3.5 w-3.5 text-primary" />
                                    Push SQL for Live Database:
                                </span>
                                <div className="border rounded-lg overflow-hidden h-44">
                                    <CodeEditor value={plan.pushSql} disabled />
                                </div>
                            </div>
                        )}

                        <div className="flex items-center justify-between border-t pt-3">
                            <Button variant="ghost" size="sm" onClick={() => setIsReviewing(false)} className="h-8 text-xs">
                                Back to Items
                            </Button>
                            <Button
                                variant="default"
                                size="sm"
                                onClick={executePlan}
                                disabled={isExecuting}
                                className="h-8 text-xs gap-1.5 bg-primary font-semibold"
                            >
                                {isExecuting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                                Confirm & Execute Reconciliation
                            </Button>
                        </div>
                    </div>
                ) : (
                    /* Items List & Resolution Picker */
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                            <div className="flex items-center gap-2 text-xs">
                                <span className="font-semibold text-foreground">{report.summary.total} Drift Differences</span>
                                <Badge variant="secondary" className="text-[10px]">{report.summary.addedInLive} added in live</Badge>
                                <Badge variant="secondary" className="text-[10px]">{report.summary.removedInLive} missing in live</Badge>
                                <Badge variant="secondary" className="text-[10px]">{report.summary.modified} modified</Badge>
                            </div>

                            <div className="flex items-center gap-1.5 text-xs">
                                <span className="text-muted-foreground mr-1">Bulk action:</span>
                                <Button variant="outline" size="sm" onClick={() => setAllResolutions("pull")} className="h-6 text-[11px] px-2">
                                    Pull All
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => setAllResolutions("push")} className="h-6 text-[11px] px-2">
                                    Push All
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => setAllResolutions("ignore")} className="h-6 text-[11px] px-2">
                                    Ignore All
                                </Button>
                            </div>
                        </div>

                        <div className="overflow-y-auto space-y-2 max-h-[44vh] pr-1">
                            {items.map((item) => (
                                <div
                                    key={item.id}
                                    className="p-3 rounded-lg border bg-card/60 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
                                >
                                    <div className="space-y-1">
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-xs font-bold font-mono">{item.targetName}</span>
                                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 uppercase">
                                                {item.category}
                                            </Badge>
                                            <Badge
                                                variant="secondary"
                                                className={`text-[10px] px-1.5 py-0 ${
                                                    item.status === "added_in_live"
                                                        ? "text-emerald-500 bg-emerald-500/10"
                                                        : item.status === "removed_in_live"
                                                        ? "text-destructive bg-destructive/10"
                                                        : "text-amber-500 bg-amber-500/10"
                                                }`}
                                            >
                                                {item.status.replace(/_/g, " ")}
                                            </Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground">{item.details}</p>
                                    </div>

                                    {/* Action Selector */}
                                    <div className="flex items-center gap-1 shrink-0 bg-muted/40 p-0.5 rounded-md border">
                                        <button
                                            onClick={() => setItemResolution(item.id, "pull")}
                                            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-all ${
                                                item.resolution === "pull"
                                                    ? "bg-primary text-primary-foreground shadow-2xs"
                                                    : "text-muted-foreground hover:text-foreground"
                                            }`}
                                            title="Pull into Canvas"
                                        >
                                            <ArrowDownLeft className="h-3 w-3" />
                                            Pull
                                        </button>
                                        <button
                                            onClick={() => setItemResolution(item.id, "push")}
                                            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-all ${
                                                item.resolution === "push"
                                                    ? "bg-primary text-primary-foreground shadow-2xs"
                                                    : "text-muted-foreground hover:text-foreground"
                                            }`}
                                            title="Push to Live DB"
                                        >
                                            <ArrowUpRight className="h-3 w-3" />
                                            Push
                                        </button>
                                        <button
                                            onClick={() => setItemResolution(item.id, "ignore")}
                                            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-all ${
                                                item.resolution === "ignore"
                                                    ? "bg-muted text-foreground font-semibold"
                                                    : "text-muted-foreground hover:text-foreground"
                                            }`}
                                            title="Ignore difference"
                                        >
                                            <EyeOff className="h-3 w-3" />
                                            Ignore
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Footer Review Button */}
                        <div className="flex items-center justify-between border-t pt-3">
                            <span className="text-xs text-muted-foreground">
                                {items.filter(i => i.resolution === "pull").length} Pull, {items.filter(i => i.resolution === "push").length} Push, {items.filter(i => i.resolution === "ignore").length} Ignored
                            </span>
                            <Button
                                variant="default"
                                size="sm"
                                onClick={preparePlan}
                                className="h-8 text-xs gap-1.5 font-semibold"
                            >
                                <GitCompare className="h-3.5 w-3.5" />
                                Review Reconciliation Plan
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
};

export default DriftReconciliationModal;
