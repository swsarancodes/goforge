import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import DataGrid from "./data-grid";
import RelationList from "./relation-list";
import { useDataBrowser } from "./use-data-browser";

/**
 * Data page: table and view names in a list on the left, rows on the right using the remaining width.
 * Desktop: resizable, collapsible list (size and collapsed state are remembered). Mobile: the list lives in
 * a slide-over drawer opened from the toolbar.
 */
const DataBrowserPage: React.FC = () => {
    const { t } = useTranslation();
    const browser = useDataBrowser();
    const isMobile = useIsMobile();

    const listPanel = useRef<ImperativePanelHandle>(null);
    const [isListCollapsed, setIsListCollapsed] = useState<boolean>(false);
    const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);

    const toggleList = useCallback(() => {
        const panel = listPanel.current;
        if (!panel) return;
        if (panel.isCollapsed()) panel.expand();
        else panel.collapse();
    }, []);

    if (isMobile) {
        return (
            <div className="w-full h-full min-h-0 flex flex-col">
                <DataGrid
                    browser={browser}
                    toolbarStart={
                        <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={() => setIsDrawerOpen(true)}>
                            <PanelLeftOpen className="size-4" /> {t("data_browser.tables", { defaultValue: "Tables" })}
                        </Button>
                    }
                />
                <Sheet open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
                    <SheetContent side="left" className="w-[85vw] sm:max-w-sm p-0 gap-0">
                        <SheetHeader className="pb-2">
                            <SheetTitle>{t("data_browser.tables", { defaultValue: "Tables" })}</SheetTitle>
                            <SheetDescription className="sr-only">
                                {t("data_browser.drawer_description", { defaultValue: "Choose a connection and a table or view to browse." })}
                            </SheetDescription>
                        </SheetHeader>
                        <div className="flex-1 min-h-0">
                            <RelationList browser={browser} onPicked={() => setIsDrawerOpen(false)} />
                        </div>
                    </SheetContent>
                </Sheet>
            </div>
        );
    }

    const toggleLabel = isListCollapsed
        ? t("data_browser.show_list", { defaultValue: "Show table list" })
        : t("data_browser.hide_list", { defaultValue: "Hide table list" });

    return (
        <div className="w-full h-full min-h-0">
            <ResizablePanelGroup direction="horizontal" autoSaveId="goforge-data-browser">
                <ResizablePanel
                    ref={listPanel}
                    id="data-browser-list"
                    order={1}
                    defaultSize={24}
                    minSize={16}
                    maxSize={40}
                    collapsible
                    collapsedSize={0}
                    onCollapse={() => setIsListCollapsed(true)}
                    onExpand={() => setIsListCollapsed(false)}
                    className="bg-card"
                >
                    {/* A collapsed panel is 0px wide; `invisible` also takes its buttons out of the tab order. */}
                    <div className={cn("h-full", isListCollapsed && "invisible")}>
                        <RelationList browser={browser} />
                    </div>
                </ResizablePanel>
                <ResizableHandle withHandle className="hover:bg-primary/50 active:bg-primary/50 transition-colors" />
                <ResizablePanel id="data-browser-grid" order={2} minSize={30}>
                    <DataGrid
                        browser={browser}
                        toolbarStart={
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 shrink-0"
                                onClick={toggleList}
                                aria-label={toggleLabel}
                                aria-expanded={!isListCollapsed}
                                title={toggleLabel}
                            >
                                {isListCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                            </Button>
                        }
                    />
                </ResizablePanel>
            </ResizablePanelGroup>
        </div>
    );
};

export default DataBrowserPage;
