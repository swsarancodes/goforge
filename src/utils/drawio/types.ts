import { DatabaseDialect } from "@/lib/database";
import { ProjectFile } from "@/utils/project-file";

export interface DrawioExportOptions {
    /** Diagram page name in Draw.io (default: "Database Schema"). */
    pageName?: string;
    /** Whether to include PK / FK badges in column labels (default: true). */
    includeBadges?: boolean;
    /** Whether to include table notes as tooltips/data attributes (default: true). */
    includeNotes?: boolean;
    /** Color scheme for tables (default: "slate"). */
    theme?: "slate" | "blue" | "dark";
}

export interface DrawioWarning {
    code: string;
    message: string;
    table?: string;
    field?: string;
}

export interface DrawioExportResult {
    xml: string;
    warnings: DrawioWarning[];
}

export interface DrawioParseResult {
    file: ProjectFile;
    warnings: DrawioWarning[];
}

export interface DrawioParsedCell {
    id: string;
    value: string;
    style: string;
    parent?: string;
    isVertex: boolean;
    isEdge: boolean;
    source?: string;
    target?: string;
    x: number;
    y: number;
    width: number;
    height: number;
}
