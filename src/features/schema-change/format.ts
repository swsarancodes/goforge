export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export const formatCount = (value: number): string => new Intl.NumberFormat("en-US").format(Math.round(value));

/** `~5,000,000` for a planner estimate, `unknown` when the table was never analyzed. */
export const formatRows = (rows: number | null): string => (rows === null ? "rows unknown" : `~${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(rows)} rows`);

export const formatTime = (iso: string): string => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
