import { Cardinality } from "@/lib/schemas/relationship-schema";
import type { DatabaseType } from "@/lib/schemas/database-schema";
import type { TableType } from "@/lib/schemas/table-schema";
import type { FieldType } from "@/lib/schemas/field-schema";
import type { DrawioExportOptions, DrawioExportResult, DrawioWarning } from "./types";

const escapeXml = (unsafe: string): string =>
    unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

const THEME_COLORS: Record<"slate" | "blue" | "dark", { fill: string; stroke: string; font: string; edge: string; headerFill: string }> = {
    slate: {
        fill: "#ffffff",
        stroke: "#64748b",
        font: "#1e293b",
        edge: "#475569",
        headerFill: "#f1f5f9",
    },
    blue: {
        fill: "#ffffff",
        stroke: "#2563eb",
        font: "#1e3a8a",
        edge: "#3b82f6",
        headerFill: "#dbeafe",
    },
    dark: {
        fill: "#1e293b",
        stroke: "#475569",
        font: "#f8fafc",
        edge: "#94a3b8",
        headerFill: "#0f172a",
    },
};

const getCardinalityArrows = (cardinality?: Cardinality): { startArrow: string; endArrow: string } => {
    switch (cardinality) {
        case Cardinality.one_to_one:
            return { startArrow: "ERone", endArrow: "ERone" };
        case Cardinality.many_to_one:
            return { startArrow: "ERmany", endArrow: "ERone" };
        case Cardinality.many_to_many:
            return { startArrow: "ERmany", endArrow: "ERmany" };
        case Cardinality.one_to_many:
        default:
            return { startArrow: "ERone", endArrow: "ERmany" };
    }
};

/**
 * Converts a GoForge database bundle or project into an editable Draw.io (.drawio) XML string.
 * Uses standard mxGraphModel Entity-Relationship swimlane shapes and orthogonal connector edges.
 */
export const toDrawio = (
    database: Pick<DatabaseType, "name" | "dialect" | "tables" | "relationships">,
    options: DrawioExportOptions = {},
): DrawioExportResult => {
    const warnings: DrawioWarning[] = [];
    const theme = THEME_COLORS[options.theme ?? "slate"];
    const includeBadges = options.includeBadges !== false;
    const pageName = options.pageName ?? database.name ?? "Database Schema";

    const HEADER_HEIGHT = 28;
    const ROW_HEIGHT = 24;
    const DEFAULT_TABLE_WIDTH = 240;

    let cellsXml = "";

    // 1. Root cells required by Draw.io
    cellsXml += `        <mxCell id="0" />\n`;
    cellsXml += `        <mxCell id="1" parent="0" />\n`;

    const tables = database.tables ?? [];
    const relationships = database.relationships ?? [];
    const tableIdMap = new Map<string, TableType>();

    for (const table of tables) {
        tableIdMap.set(table.id, table as TableType);
    }

    // 2. Render each table as an ER swimlane container
    for (const table of tables) {
        const fields = (table.fields ?? []) as FieldType[];
        const width = Number(table.width) || DEFAULT_TABLE_WIDTH;
        const posX = Math.round(Number(table.posX) || 100);
        const posY = Math.round(Number(table.posY) || 100);
        const height = HEADER_HEIGHT + Math.max(fields.length, 1) * ROW_HEIGHT;

        const tableName = table.namespace ? `${table.namespace}.${table.name}` : table.name;
        const tableColor = table.color || theme.headerFill;

        const tableStyle = [
            "swimlane",
            "fontStyle=1",
            "align=center",
            "verticalAlign=top",
            "childLayout=stackLayout",
            "horizontal=1",
            `startSize=${HEADER_HEIGHT}`,
            "horizontalStack=0",
            "resizeParent=1",
            "resizeParentMax=0",
            "resizeLast=0",
            "collapsible=1",
            "marginBottom=0",
            "whiteSpace=wrap",
            "html=1",
            `fillColor=${tableColor}`,
            `strokeColor=${theme.stroke}`,
            `fontColor=${theme.font}`,
        ].join(";");

        cellsXml += `        <mxCell id="table_${escapeXml(table.id)}" value="${escapeXml(tableName)}" style="${escapeXml(tableStyle)}" vertex="1" parent="1">\n`;
        cellsXml += `          <mxGeometry x="${posX}" y="${posY}" width="${width}" height="${height}" as="geometry" />\n`;
        cellsXml += `        </mxCell>\n`;

        // Render each field as a row vertex inside the table swimlane
        fields.forEach((field, index) => {
            const badges: string[] = [];
            if (includeBadges) {
                if (field.isPrimary) badges.push("PK");
                if (field.isUnique && !field.isPrimary) badges.push("UQ");
                if (field.isNullable === false && !field.isPrimary) badges.push("NN");
            }

            const typeName = field.type?.name ?? "text";
            const badgeSuffix = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
            const rowLabel = `${field.name}: ${typeName}${badgeSuffix}`;

            const rowStyle = [
                "text",
                "strokeColor=none",
                "fillColor=none",
                "align=left",
                "verticalAlign=middle",
                "spacingLeft=8",
                "spacingRight=8",
                "overflow=hidden",
                "points=[[0,0.5],[1,0.5]]",
                "portConstraint=eastwest",
                "rotatable=0",
                "whiteSpace=wrap",
                "html=1",
                "fontSize=11",
                `fontColor=${theme.font}`,
            ].join(";");

            const rowY = HEADER_HEIGHT + index * ROW_HEIGHT;

            cellsXml += `        <mxCell id="field_${escapeXml(field.id)}" value="${escapeXml(rowLabel)}" style="${escapeXml(rowStyle)}" vertex="1" parent="table_${escapeXml(table.id)}">\n`;
            cellsXml += `          <mxGeometry y="${rowY}" width="${width}" height="${ROW_HEIGHT}" as="geometry" />\n`;
            cellsXml += `        </mxCell>\n`;
        });
    }

    // 3. Render relationships as orthogonal connector edges
    for (const rel of relationships) {
        const sourceTable = tableIdMap.get(rel.sourceTableId);
        const targetTable = tableIdMap.get(rel.targetTableId);

        if (!sourceTable || !targetTable) {
            warnings.push({
                code: "MISSING_RELATIONSHIP_ENDPOINT",
                message: `Relationship "${rel.id}" references non-existent table endpoint.`,
            });
            continue;
        }

        const { startArrow, endArrow } = getCardinalityArrows(rel.cardinality);
        const edgeStyle = [
            "edgeStyle=orthogonalEdgeStyle",
            "rounded=1",
            "orthogonalLoop=1",
            "jettySize=auto",
            "html=1",
            `startArrow=${startArrow}`,
            `endArrow=${endArrow}`,
            `strokeColor=${theme.edge}`,
            "strokeWidth=1.5",
        ].join(";");

        const edgeLabel = rel.name ? escapeXml(rel.name) : "";

        cellsXml += `        <mxCell id="rel_${escapeXml(rel.id)}" value="${edgeLabel}" style="${escapeXml(edgeStyle)}" edge="1" parent="1" source="table_${escapeXml(rel.sourceTableId)}" target="table_${escapeXml(rel.targetTableId)}">\n`;
        cellsXml += `          <mxGeometry relative="1" as="geometry" />\n`;
        cellsXml += `        </mxCell>\n`;
    }

    const xml = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<mxfile host="GoForge" modified="${new Date().toISOString()}" agent="GoForge Schema Studio" version="24.0.0" type="device">`,
        `  <diagram id="goforge-${Date.now()}" name="${escapeXml(pageName)}">`,
        `    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" background="#ffffff">`,
        `      <root>`,
        cellsXml.trimEnd(),
        `      </root>`,
        `    </mxGraphModel>`,
        `  </diagram>`,
        `</mxfile>`,
    ].join("\n");

    return { xml, warnings };
};
