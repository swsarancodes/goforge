import { describe, expect, it } from "vitest";
import { hashContent, planSync, readSyncMemory, writeSyncMemory, type SyncedMark } from "./sync-plan";

const mark = (version: number, hash: string): SyncedMark => ({ version, hash });

describe("planSync", () => {
    it("sends up what the cloud has never seen, and brings down what this browser has never seen", () => {
        const plan = planSync([{ id: "a", hash: "1" }], [{ id: "b", version: 1 }], {});
        expect(plan).toEqual({ pull: ["b"], push: ["a"], deleteLocal: [] });
    });

    it("does nothing when both sides are as they were at the last sync", () => {
        expect(planSync([{ id: "a", hash: "h" }], [{ id: "a", version: 3 }], { a: mark(3, "h") })).toEqual({ pull: [], push: [], deleteLocal: [] });
    });

    it("brings down a newer cloud copy when this browser did not edit its own", () => {
        expect(planSync([{ id: "a", hash: "h" }], [{ id: "a", version: 4 }], { a: mark(3, "h") })).toEqual({ pull: ["a"], push: [], deleteLocal: [] });
    });

    it("sends up an edit made here", () => {
        expect(planSync([{ id: "a", hash: "edited" }], [{ id: "a", version: 3 }], { a: mark(3, "h") }).push).toEqual(["a"]);
    });

    it("lets the last save win when both sides changed: this browser's edit goes up", () => {
        const plan = planSync([{ id: "a", hash: "edited" }], [{ id: "a", version: 9 }], { a: mark(3, "h") });
        expect(plan).toEqual({ pull: [], push: ["a"], deleteLocal: [] });
    });

    it("sends up a diagram that exists on both sides but was never synced from here", () => {
        expect(planSync([{ id: "a", hash: "x" }], [{ id: "a", version: 1 }], {}).push).toEqual(["a"]);
    });

    it("deletes here what was deleted in the cloud from another device, but only if it had been synced", () => {
        const plan = planSync([{ id: "gone", hash: "h" }, { id: "fresh", hash: "n" }], [], { gone: mark(2, "h") });
        expect(plan).toEqual({ pull: [], push: ["fresh"], deleteLocal: ["gone"] });
    });

    it("never reads a diagram missing here as deleted here: it is brought back", () => {
        // the browser's store was wiped but its memory survived
        expect(planSync([], [{ id: "a", version: 3 }], { a: mark(3, "h") })).toEqual({ pull: ["a"], push: [], deleteLocal: [] });
    });

    it("handles nothing at all", () => {
        expect(planSync([], [], {})).toEqual({ pull: [], push: [], deleteLocal: [] });
    });
});

describe("hashContent", () => {
    it("is stable, and different for different content", () => {
        expect(hashContent("abc")).toBe(hashContent("abc"));
        expect(hashContent("abc")).not.toBe(hashContent("abd"));
        expect(hashContent("")).not.toBe(hashContent(" "));
    });
});

describe("what the browser remembers", () => {
    const memory = () => {
        const data = new Map<string, string>();
        return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
    };

    it("round-trips, starts empty, and survives bad or blocked storage", () => {
        const storage = memory();
        expect(readSyncMemory(storage)).toEqual({ synced: {} });
        writeSyncMemory({ ownerId: "u1", synced: { a: mark(2, "h") } }, storage);
        expect(readSyncMemory(storage)).toEqual({ ownerId: "u1", synced: { a: mark(2, "h") } });
        storage.data.set("goforge.cloud.v1", "{nope");
        expect(readSyncMemory(storage)).toEqual({ synced: {} });
        const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
        expect(readSyncMemory(blocked)).toEqual({ synced: {} });
        expect(() => writeSyncMemory({ synced: {} }, blocked)).not.toThrow();
    });
});
