import type { ProjectFile } from "@/utils/project-file";

export interface CloudProjectSummary {
    id: string;
    name: string;
    dialect: string;
    tables: number;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface CloudProject extends CloudProjectSummary {
    document: ProjectFile;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/projects${path}`, { headers: { "Content-Type": "application/json" }, ...init });
    if (!response.ok) {
        let message = response.statusText || `HTTP ${response.status}`;
        try {
            const body = await response.json();
            if (typeof body?.error === "string") message = body.error;
        } catch {
            // not JSON
        }
        throw new Error(message);
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export const listCloudProjects = (signal?: AbortSignal) => request<CloudProjectSummary[]>("", { signal });
export const getCloudProject = (id: string) => request<CloudProject>(`/${encodeURIComponent(id)}`);
export const saveCloudProject = (id: string, input: { name: string; dialect: string; document: ProjectFile }) =>
    request<CloudProjectSummary>(`/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
export const deleteCloudProject = (id: string) => request<void>(`/${encodeURIComponent(id)}`, { method: "DELETE" });
