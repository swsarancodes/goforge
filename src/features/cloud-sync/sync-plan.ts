/**
 * What to do so this browser and the account's cloud copy agree. Pure: the caller does the reading and the writing.
 *
 * A diagram is the same one on both sides when it has the same id. The browser remembers, for each diagram it has synced, the cloud
 * version and a hash of the content as of that sync (`synced`); comparing against that tells which side changed since.
 */
export interface LocalProject {
    id: string;
    /** Hash of the diagram's content as it is now. */
    hash: string;
}

export interface RemoteProject {
    id: string;
    version: number;
}

export interface SyncedMark {
    version: number;
    hash: string;
}

export interface SyncPlan {
    /** Cloud has it, this browser lacks it or has an older copy that was not edited here: bring it down. */
    pull: string[];
    /** This browser has it new or edited: send it up (the last save wins when both sides changed). */
    push: string[];
    /** It was synced before and has since been deleted from the cloud on another device: delete it here too. */
    deleteLocal: string[];
}

export function planSync(local: LocalProject[], remote: RemoteProject[], synced: Record<string, SyncedMark>): SyncPlan {
    const plan: SyncPlan = { pull: [], push: [], deleteLocal: [] };
    const localById = new Map(local.map((project) => [project.id, project]));
    const remoteById = new Map(remote.map((project) => [project.id, project]));

    for (const cloud of remote) {
        const mine = localById.get(cloud.id);
        const mark = synced[cloud.id];
        if (!mine) {
            // Missing here. Never read as "deleted here": a wiped browser store looks the same, and the cloud copy is the safe one to keep.
            plan.pull.push(cloud.id);
            continue;
        }
        const editedHere = !mark || mine.hash !== mark.hash;
        const editedThere = !mark || cloud.version > mark.version;
        if (editedHere) plan.push.push(cloud.id);
        else if (editedThere) plan.pull.push(cloud.id);
    }

    for (const mine of local) {
        if (remoteById.has(mine.id)) continue;
        if (synced[mine.id]) plan.deleteLocal.push(mine.id);
        else plan.push.push(mine.id);
    }
    return plan;
}

/** A short stable fingerprint of a diagram's content (not for security), to notice that it changed. */
export function hashContent(text: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${hash.toString(16)}:${text.length}`;
}

// ---- what the browser remembers between visits -----------------------------------------------------------------------------------

export interface SyncMemory {
    /** The account this browser's diagrams were last synced for. Another account signing in must not inherit them. */
    ownerId?: string;
    synced: Record<string, SyncedMark>;
}

const KEY = "goforge.cloud.v1";

export function readSyncMemory(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): SyncMemory {
    try {
        const raw = storage?.getItem(KEY);
        if (!raw) return { synced: {} };
        const parsed = JSON.parse(raw) as Partial<SyncMemory>;
        return { ownerId: typeof parsed.ownerId === "string" ? parsed.ownerId : undefined, synced: parsed.synced && typeof parsed.synced === "object" ? parsed.synced : {} };
    } catch {
        return { synced: {} };
    }
}

export function writeSyncMemory(memory: SyncMemory, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
    try {
        storage?.setItem(KEY, JSON.stringify(memory));
    } catch {
        // not remembered: the next visit syncs everything again, which is safe
    }
}

function safeStorage(): Storage | undefined {
    try {
        return typeof localStorage === "undefined" ? undefined : localStorage;
    } catch {
        return undefined;
    }
}
