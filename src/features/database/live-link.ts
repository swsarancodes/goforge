/**
 * Which live database was created together with which diagram, so that renaming one renames the other. Kept in the browser, next to
 * the other per-person choices: it is a convenience that links names, not data, and a diagram with no entry here simply keeps its own name.
 */
const KEY = "goforge.live-links";

type Links = Record<string, string>;

const read = (): Links => {
    try {
        const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Links) : {};
    } catch {
        return {};
    }
};

const write = (links: Links): void => {
    try {
        localStorage.setItem(KEY, JSON.stringify(links));
    } catch {
        // not remembered
    }
};

export const linkDiagram = (diagramId: string, connectionId: string): void => write({ ...read(), [diagramId]: connectionId });

/** The live database made with this diagram, if any. */
export const connectionOfDiagram = (diagramId: string): string | undefined => read()[diagramId];

/** Every diagram made with this live database. */
export const diagramsOfConnection = (connectionId: string): string[] => Object.entries(read()).filter(([, id]) => id === connectionId).map(([diagramId]) => diagramId);

export const unlinkDiagram = (diagramId: string): void => {
    const { [diagramId]: _removed, ...rest } = read();
    write(rest);
};
