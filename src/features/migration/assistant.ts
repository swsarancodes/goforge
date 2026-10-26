/** What the assistant on the migration page is called. */
export const ASSISTANT_NAME = "CosmicQuery";

const KEY = "goforge.cosmicquery-collapsed";

export function readCollapsed(): boolean {
    try {
        return localStorage.getItem(KEY) === "1";
    } catch {
        return false;
    }
}

export function writeCollapsed(collapsed: boolean): void {
    try {
        localStorage.setItem(KEY, collapsed ? "1" : "0");
    } catch {
        // not remembered
    }
}
