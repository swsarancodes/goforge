import { SavedConnection, deleteSavedConnection } from "@/lib/live-connection-api";

/**
 * Removes a saved connection. For a database GoForge created for the account, the connection is the only handle on it, so removing it
 * deletes the database for good; that is asked about first. Resolves to false when the person said no.
 */
export async function forgetConnection(connection: Pick<SavedConnection, "id" | "name" | "kind">): Promise<boolean> {
    if (connection.kind === "cloud") {
        const confirmed = window.confirm(`Delete the database “${connection.name}”?\n\nThis permanently deletes it and everything in it. It cannot be undone.`);
        if (!confirmed) return false;
        await deleteSavedConnection(connection.id, { dropDatabase: true });
        return true;
    }
    await deleteSavedConnection(connection.id);
    return true;
}
