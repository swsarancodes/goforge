import { DatabaseDialect } from "@/lib/database";
import { DataType } from "@/lib/schemas/data-type-schema";
import { Cardinality } from "@/lib/schemas/relationship-schema";
import {
    PROJECT_FILE_FORMAT,
    PROJECT_FILE_VERSION,
    ProjectFile,
    ProjectRelationship,
    ProjectTable,
} from "@/utils/project-file";
import { v4 } from "uuid";
import type { DrawioParsedCell, DrawioParseResult, DrawioWarning } from "./types";

/**
 * Strips HTML tags and unescapes standard XML/HTML entities.
 */
const cleanHtmlText = (text: string): string => {
    return text
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&nbsp;/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/?[^>]+(>|$)/g, "")
        .trim();
};

/**
 * Robust XML attribute extractor for regex-based parsing without DOMParser dependency.
 */
const extractAttribute = (tag: string, attr: string): string | undefined => {
    const regex = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i");
    const match = tag.match(regex);
    return match ? match[1] : undefined;
};

/**
 * Parses raw XML string into flat list of DrawioParsedCell structures.
 */
const parseDrawioCells = (xml: string): DrawioParsedCell[] => {
    const cells: DrawioParsedCell[] = [];
    const cellRegex = /<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/gi;
    let match: RegExpExecArray | null;

    while ((match = cellRegex.exec(xml)) !== null) {
        const fullAttributes = match[1];
        const innerContent = match[3] || "";

        const id = extractAttribute(fullAttributes, "id");
        if (!id) continue;

        const value = extractAttribute(fullAttributes, "value") ?? "";
        const style = extractAttribute(fullAttributes, "style") ?? "";
        const parent = extractAttribute(fullAttributes, "parent");
        const vertex = extractAttribute(fullAttributes, "vertex") === "1";
        const edge = extractAttribute(fullAttributes, "edge") === "1";
        const source = extractAttribute(fullAttributes, "source");
        const target = extractAttribute(fullAttributes, "target");

        // Parse child <mxGeometry> if present
        let x = 0;
        let y = 0;
        let width = 200;
        let height = 30;

        const geoMatch = innerContent.match(/<mxGeometry\b([^>]*?)\/?>/i);
        if (geoMatch) {
            const geoAttrs = geoMatch[1];
            x = parseFloat(extractAttribute(geoAttrs, "x") || "0") || 0;
            y = parseFloat(extractAttribute(geoAttrs, "y") || "0") || 0;
            width = parseFloat(extractAttribute(geoAttrs, "width") || "200") || 200;
            height = parseFloat(extractAttribute(geoAttrs, "height") || "30") || 30;
        }

        cells.push({
            id,
            value: cleanHtmlText(value),
            style,
            parent,
            isVertex: vertex,
            isEdge: edge,
            source,
            target,
            x,
            y,
            width,
            height,
        });
    }

    return cells;
};

/**
 * Extracts a key-value property from a Draw.io style string (e.g. style="key=val;foo=bar;").
 */
const extractStyleProp = (style: string, key: string): string | undefined => {
    const regex = new RegExp(`(?:^|;)\\s*${key}=([^;]+)`, "i");
    const match = style.match(regex);
    return match ? match[1].trim() : undefined;
};

/**
 * Maps parsed arrow styles to canonical GoForge Cardinality.
 */
const parseCardinality = (style: string): Cardinality => {
    const startArrow = extractStyleProp(style, "startArrow") || "";
    const endArrow = extractStyleProp(style, "endArrow") || "";

    const isStartMany = /many|ERmany/i.test(startArrow);
    const isEndMany = /many|ERmany/i.test(endArrow);

    if (isStartMany && isEndMany) return Cardinality.many_to_many;
    if (isStartMany && !isEndMany) return Cardinality.many_to_one;
    if (!isStartMany && isEndMany) return Cardinality.one_to_many;
    return Cardinality.one_to_one;
};

export interface ParseDrawioOptions {
    dialect?: DatabaseDialect;
    dataTypes: DataType[];
    fallbackName?: string;
}

/**
 * Parses a Draw.io XML or .drawio file into a canonical GoForge ProjectFile.
 */
export const parseDrawio = (xmlText: string, options: ParseDrawioOptions): DrawioParseResult => {
    const warnings: DrawioWarning[] = [];
    const dialect = options.dialect ?? DatabaseDialect.POSTGRES;
    const dataTypes = options.dataTypes;
    const defaultTypeId = dataTypes[0]?.id ?? "text-default";

    // Helper to find closest matching DataType ID
    const findDataTypeId = (rawType: string): string => {
        const normalized = rawType.toLowerCase().trim();
        const exactMatch = dataTypes.find((t) => t.name.toLowerCase() === normalized);
        if (exactMatch) return exactMatch.id;

        const prefixMatch = dataTypes.find((t) => normalized.startsWith(t.name.toLowerCase()));
        if (prefixMatch) return prefixMatch.id;

        return defaultTypeId;
    };

    const cells = parseDrawioCells(xmlText);

    // Group cells by their parent
    const cellsByParent = new Map<string, DrawioParsedCell[]>();
    for (const cell of cells) {
        if (cell.parent) {
            const list = cellsByParent.get(cell.parent) ?? [];
            list.push(cell);
            cellsByParent.set(cell.parent, list);
        }
    }

    // A table must be a top-level vertex (parent is "1" or not set, or parent is root)
    // and must not be a child of another table vertex.
    const vertexIds = new Set(cells.filter((c) => c.isVertex && c.id !== "0" && c.id !== "1").map((c) => c.id));
    const tableCells = cells.filter((cell) => {
        if (!cell.isVertex) return false;
        if (cell.id === "0" || cell.id === "1") return false;
        // If its parent is another vertex in the graph, this cell is a field row, not a table.
        if (cell.parent && vertexIds.has(cell.parent)) return false;

        const hasChildren = (cellsByParent.get(cell.id)?.length ?? 0) > 0;
        const isSwimlane = /swimlane|table|stackLayout/i.test(cell.style);
        return isSwimlane || hasChildren;
    });

    const projectTables: ProjectTable[] = [];
    const tableIdMapping = new Map<string, string>(); // drawioCellId -> goforgeTableId
    const fieldIdMapping = new Map<string, string>(); // drawioCellId -> goforgeFieldId

    for (const tableCell of tableCells) {
        const goforgeTableId = v4();
        tableIdMapping.set(tableCell.id, goforgeTableId);

        let tableName = tableCell.value.trim() || `table_${projectTables.length + 1}`;
        let namespace: string | undefined = undefined;

        if (tableName.includes(".")) {
            const parts = tableName.split(".");
            namespace = parts[0];
            tableName = parts.slice(1).join(".");
        }

        const childRows = cellsByParent.get(tableCell.id) ?? [];
        const tableFields: ProjectTable["fields"] = [];

        if (childRows.length > 0) {
            for (let i = 0; i < childRows.length; i++) {
                const row = childRows[i];
                const rawLine = row.value.trim();
                if (!rawLine) continue;

                const goforgeFieldId = v4();
                fieldIdMapping.set(row.id, goforgeFieldId);

                // Parse column line: e.g. "+ id: uuid [PK]" or "email varchar(255) unique"
                let isPrimary = /\[PK\]|PRIMARY KEY|\(PK\)/i.test(rawLine);
                let isUnique = /\[UQ\]|\[UNIQUE\]|UNIQUE/i.test(rawLine);
                let isNullable = !/\[NN\]|NOT NULL|\*/i.test(rawLine);

                // Strip badges from line
                const cleanLine = rawLine
                    .replace(/\[.*?\]/g, "")
                    .replace(/PRIMARY KEY|UNIQUE|NOT NULL/gi, "")
                    .replace(/^[+*o-]\s*/, "")
                    .trim();

                let colName = `column_${i + 1}`;
                let colTypeStr = "text";

                if (cleanLine.includes(":")) {
                    const [left, right] = cleanLine.split(":");
                    colName = left.trim();
                    colTypeStr = right ? right.trim() : "text";
                } else if (cleanLine.includes(" ")) {
                    const parts = cleanLine.split(/\s+/);
                    colName = parts[0];
                    colTypeStr = parts.slice(1).join(" ");
                } else if (cleanLine.length > 0) {
                    colName = cleanLine;
                }

                if (isPrimary) {
                    isNullable = false;
                }

                tableFields.push({
                    id: goforgeFieldId,
                    name: colName,
                    typeId: findDataTypeId(colTypeStr),
                    isPrimary,
                    isNullable,
                    isUnique,
                    sequence: i + 1,
                    size: null,
                    scale: null,
                    defaultValue: null,
                    comment: null,
                    color: null,
                    typeOptions: null,
                });
            }
        }

        // If table had no row cells but had multi-line text value
        if (tableFields.length === 0 && tableCell.value.includes("\n")) {
            const lines = tableCell.value.split("\n").filter((l) => l.trim().length > 0);
            tableName = lines[0].replace(/^[+*o-]\s*/, "").trim();

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                const goforgeFieldId = v4();
                const isPrimary = /\[PK\]|PK/i.test(line);

                tableFields.push({
                    id: goforgeFieldId,
                    name: line.split(/[:\s]/)[0] || `col_${i}`,
                    typeId: defaultTypeId,
                    isPrimary,
                    isNullable: !isPrimary,
                    isUnique: false,
                    sequence: i,
                    size: null,
                    scale: null,
                    defaultValue: null,
                    comment: null,
                    color: null,
                    typeOptions: null,
                });
            }
        }

        // If table still has no columns, add default id column
        if (tableFields.length === 0) {
            tableFields.push({
                id: v4(),
                name: "id",
                typeId: defaultTypeId,
                isPrimary: true,
                isNullable: false,
                isUnique: true,
                sequence: 1,
                size: null,
                scale: null,
                defaultValue: null,
                comment: null,
                color: null,
                typeOptions: null,
            });
        }

        projectTables.push({
            id: goforgeTableId,
            name: tableName,
            namespace: namespace ?? null,
            posX: tableCell.x,
            posY: tableCell.y,
            width: tableCell.width || 240,
            color: null,
            note: null,
            sequence: projectTables.length + 1,
            createdAt: new Date().toISOString(),
            fields: tableFields,
            indices: [],
            checks: [],
        });
    }

    // Identify relationships / edges
    const projectRelationships: ProjectRelationship[] = [];
    const edgeCells = cells.filter((cell) => cell.isEdge && cell.source && cell.target);

    for (const edge of edgeCells) {
        // Source and target might point directly to tables, or to field rows inside tables
        let sourceTableId = tableIdMapping.get(edge.source!);
        let targetTableId = tableIdMapping.get(edge.target!);

        let sourceFieldId: string | undefined = fieldIdMapping.get(edge.source!);
        let targetFieldId: string | undefined = fieldIdMapping.get(edge.target!);

        // If source points to a row, trace parent to table
        if (!sourceTableId && edge.source) {
            const sourceCell = cells.find((c) => c.id === edge.source);
            if (sourceCell?.parent) {
                sourceTableId = tableIdMapping.get(sourceCell.parent);
            }
        }

        // If target points to a row, trace parent to table
        if (!targetTableId && edge.target) {
            const targetCell = cells.find((c) => c.id === edge.target);
            if (targetCell?.parent) {
                targetTableId = tableIdMapping.get(targetCell.parent);
            }
        }

        if (sourceTableId && targetTableId && sourceTableId !== targetTableId) {
            const srcTable = projectTables.find((t) => t.id === sourceTableId);
            const tgtTable = projectTables.find((t) => t.id === targetTableId);

            if (srcTable && tgtTable) {
                if (!sourceFieldId) {
                    sourceFieldId = srcTable.fields.find((f) => f.isPrimary)?.id ?? srcTable.fields[0]?.id;
                }
                if (!targetFieldId) {
                    targetFieldId = tgtTable.fields.find((f) => f.name.toLowerCase().includes("id"))?.id ?? tgtTable.fields[0]?.id;
                }

                if (sourceFieldId && targetFieldId) {
                    const relId = v4();
                    const cardinality = parseCardinality(edge.style);

                    projectRelationships.push({
                        id: relId,
                        name: edge.value || `fk_${tgtTable.name}_${srcTable.name}`,
                        sourceTableId,
                        targetTableId,
                        sourceFieldId,
                        targetFieldId,
                        cardinality,
                        createdAt: new Date().toISOString(),
                        updateConstraint: "NO_ACTION",
                        deleteConstraint: "NO_ACTION",
                        relationshipFields: [
                            {
                                id: v4(),
                                relationshipId: relId,
                                sourceFieldId,
                                targetFieldId,
                                sequence: 0,
                            },
                        ],
                    });
                }
            }
        }
    }

    const file: ProjectFile = {
        format: PROJECT_FILE_FORMAT,
        formatVersion: PROJECT_FILE_VERSION,
        exportedAt: new Date().toISOString(),
        project: {
            name: options.fallbackName || "Imported Draw.io Diagram",
            dialect,
            tables: projectTables,
            relationships: projectRelationships,
            views: [],
            sequences: [],
        },
    };

    return { file, warnings };
};
