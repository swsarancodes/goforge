import { beforeEach, describe, expect, it } from "vitest";
import { connectionOfDiagram, diagramsOfConnection, linkDiagram, unlinkDiagram } from "./live-link";

/** The test environment has no browser storage; this is just enough of it. */
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value), removeItem: (key: string) => void memory.delete(key), clear: () => memory.clear() },
    configurable: true,
});

describe("which live database belongs to which diagram", () => {
    beforeEach(() => localStorage.clear());

    it("remembers the link in both directions", () => {
        linkDiagram("diagram-1", "connection-a");
        linkDiagram("diagram-2", "connection-a");
        linkDiagram("diagram-3", "connection-b");
        expect(connectionOfDiagram("diagram-1")).toBe("connection-a");
        expect(diagramsOfConnection("connection-a").sort()).toEqual(["diagram-1", "diagram-2"]);
        expect(connectionOfDiagram("unknown")).toBeUndefined();
    });

    it("moves a diagram to a new database and forgets one on request", () => {
        linkDiagram("diagram-1", "connection-a");
        linkDiagram("diagram-1", "connection-b");
        expect(diagramsOfConnection("connection-a")).toEqual([]);
        unlinkDiagram("diagram-1");
        expect(connectionOfDiagram("diagram-1")).toBeUndefined();
    });

    it("copes with stored text that is not a link table", () => {
        localStorage.setItem("goforge.live-links", "not json");
        expect(connectionOfDiagram("diagram-1")).toBeUndefined();
        localStorage.setItem("goforge.live-links", "[1,2]");
        expect(diagramsOfConnection("connection-a")).toEqual([]);
        linkDiagram("diagram-1", "connection-a");
        expect(connectionOfDiagram("diagram-1")).toBe("connection-a");
    });
});
