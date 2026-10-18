import { DatabaseType } from "@/lib/schemas/database-schema";

export type DriftCategory = "table" | "column" | "index" | "foreign_key" | "check" | "view" | "sequence";

export type DriftStatus = "added_in_live" | "removed_in_live" | "modified";

export type DriftResolution = "pull" | "push" | "ignore";

export interface DriftItem {
    id: string;
    category: DriftCategory;
    targetName: string;
    tableName?: string;
    status: DriftStatus;
    details: string;
    canvasValue?: string;
    liveValue?: string;
    resolution: DriftResolution;
}

export interface DriftReport {
    items: DriftItem[];
    summary: {
        total: number;
        addedInLive: number;
        removedInLive: number;
        modified: number;
        inSync: boolean;
    };
    liveDialect: string;
    timestamp: string;
}

export interface ReconciliationPlan {
    pullOperations: any[]; // canvas operations to apply
    pushSql: string; // SQL to execute on live database
    ignoredCount: number;
    pullCount: number;
    pushCount: number;
}
