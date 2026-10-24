import { useCallback, useRef, useState } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { AuditPanel, SettingsForm } from "./components/governance-panel";
import { HealthPanel } from "./components/health-panel";
import { PlanPanel } from "./components/plan-panel";
import { ScopeList } from "./components/scope-list";
import { useSchemaChange, type SchemaChange, type Tab } from "./use-schema-change";

const Workspace: React.FC<{ state: SchemaChange; toolbarStart: React.ReactNode }> = ({ state, toolbarStart }) => (
    <Tabs value={state.tab} onValueChange={(value) => state.setTab(value as Tab)} className="flex h-full min-h-0 min-w-0 flex-col gap-0">
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b px-2 py-1.5">
            {toolbarStart}
            <TabsList className="h-8">
                <TabsTrigger value="plan" className="px-2.5 text-xs">Plan</TabsTrigger>
                <TabsTrigger value="health" className="px-2.5 text-xs">Health</TabsTrigger>
                <TabsTrigger value="governance" className="px-2.5 text-xs">AI settings</TabsTrigger>
                <TabsTrigger value="audit" className="px-2.5 text-xs">Audit log</TabsTrigger>
            </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
            <TabsContent value="plan" className="m-0"><PlanPanel state={state} /></TabsContent>
            <TabsContent value="health" className="m-0"><HealthPanel state={state} /></TabsContent>
            <TabsContent value="governance" className="m-0 space-y-3 p-3">
                <div className="space-y-1">
                    <h2 className="text-sm font-semibold">AI settings</h2>
                    <p className="max-w-3xl text-xs text-muted-foreground">Choose where requests go, which models may receive them, and whether names are hidden. What leaves this machine is only table definitions, sizes and counts, never rows or credentials.</p>
                </div>
                <SettingsForm onChanged={state.refreshAiStatus} />
            </TabsContent>
            <TabsContent value="audit" className="m-0 space-y-3 p-3">
                <h2 className="text-sm font-semibold">Audit log</h2>
                <AuditPanel />
            </TabsContent>
        </div>
    </Tabs>
);

/**
 * Schema Change: plan a change to a large live PostgreSQL database. The tables a request is about are found in the catalog and
 * shown (and editable) on the left; the plan, the runbook, the health report and the AI settings are on the right.
 */
const SchemaChangePage: React.FC = () => {
    const state = useSchemaChange();
    const isMobile = useIsMobile();
    const listPanel = useRef<ImperativePanelHandle>(null);
    const [collapsed, setCollapsed] = useState(false);
    const [drawer, setDrawer] = useState(false);

    const toggle = useCallback(() => {
        const panel = listPanel.current;
        if (!panel) return;
        if (panel.isCollapsed()) panel.expand();
        else panel.collapse();
    }, []);

    if (isMobile) {
        return (
            <div className="flex h-full min-h-0 w-full flex-col">
                <Workspace
                    state={state}
                    toolbarStart={
                        <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => setDrawer(true)}>
                            <PanelLeftOpen className="size-4" /> Tables{state.selected.length > 0 ? ` · ${state.selected.length}` : ""}
                        </Button>
                    }
                />
                <Sheet open={drawer} onOpenChange={setDrawer}>
                    <SheetContent side="left" className="w-[85vw] gap-0 p-0 sm:max-w-sm">
                        <SheetHeader className="pb-2">
                            <SheetTitle>Tables in scope</SheetTitle>
                            <SheetDescription className="sr-only">Choose a connection and the tables the change is about.</SheetDescription>
                        </SheetHeader>
                        <div className="min-h-0 flex-1"><ScopeList state={state} onPicked={() => setDrawer(false)} /></div>
                    </SheetContent>
                </Sheet>
            </div>
        );
    }

    const label = collapsed ? "Show the table list" : "Hide the table list";
    return (
        <div className="h-full min-h-0 w-full">
            <ResizablePanelGroup direction="horizontal" autoSaveId="goforge-schema-change">
                <ResizablePanel ref={listPanel} id="schema-change-list" order={1} defaultSize={26} minSize={18} maxSize={42} collapsible collapsedSize={0} onCollapse={() => setCollapsed(true)} onExpand={() => setCollapsed(false)} className="bg-card">
                    <div className={cn("h-full", collapsed && "invisible")}><ScopeList state={state} /></div>
                </ResizablePanel>
                <ResizableHandle withHandle className="transition-colors hover:bg-primary/50 active:bg-primary/50" />
                <ResizablePanel id="schema-change-work" order={2} minSize={35}>
                    <Workspace
                        state={state}
                        toolbarStart={
                            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={toggle} aria-label={label} aria-expanded={!collapsed} title={label}>
                                {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                            </Button>
                        }
                    />
                </ResizablePanel>
            </ResizablePanelGroup>
        </div>
    );
};

export default SchemaChangePage;
