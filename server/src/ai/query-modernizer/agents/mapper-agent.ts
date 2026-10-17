import { AgentTrace, ModernizeRequest, SchemaContext } from "../types.js";

export interface MapperOutput {
    entityMap: Record<string, string>;
    detectedTables: string[];
    detectedColumns: string[];
    trace: AgentTrace;
}

function cleanIdentifier(name: string): string {
    return name
        .replace(/^\[(?:dbo\]\.)?\[?|\]$/gi, "")
        .replace(/^(?:dbo\.)/i, "")
        .replace(/[`"]/g, "")
        .trim();
}

function findMatchingSchemaTable(legacyName: string, schema?: SchemaContext): string | undefined {
    if (!schema?.tables?.length) return undefined;
    const clean = cleanIdentifier(legacyName).toLowerCase();
    
    const exact = schema.tables.find(t => t.name.toLowerCase() === clean);
    if (exact) return exact.name;

    const stripped = clean.replace(/^(?:tbl_|mstr_|stg_|dim_|fact_|v_)/, "");
    const prefixMatch = schema.tables.find(t => t.name.toLowerCase() === stripped);
    if (prefixMatch) return prefixMatch.name;

    const singular = stripped.endsWith("s") ? stripped.slice(0, -1) : stripped;
    const plural = stripped.endsWith("s") ? stripped : stripped + "s";

    const pluralMatch = schema.tables.find(t => {
        const tLower = t.name.toLowerCase();
        return tLower === singular || tLower === plural;
    });

    return pluralMatch?.name;
}

export function runMapperAgent(request: ModernizeRequest): MapperOutput {
    const startTime = Date.now();
    const details: string[] = [];
    const entityMap: Record<string, string> = {};
    const detectedTables: string[] = [];
    const detectedColumns: string[] = [];

    const fromJoinRegex = /(?:FROM|JOIN)\s+([a-zA-Z0-9_.\[\]"`]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?/gi;
    let match: RegExpExecArray | null;

    while ((match = fromJoinRegex.exec(request.legacySql)) !== null) {
        const rawTable = match[1];
        const alias = match[2];
        const cleanTable = cleanIdentifier(rawTable);

        if (!cleanTable || cleanTable.toUpperCase() === "SELECT") continue;

        if (!detectedTables.includes(cleanTable)) {
            detectedTables.push(cleanTable);
        }

        const targetTable = findMatchingSchemaTable(cleanTable, request.schemaContext);
        if (targetTable && targetTable !== cleanTable) {
            entityMap[cleanTable] = targetTable;
            details.push(`Mapped legacy table "${cleanTable}" → "${targetTable}" in target schema`);
        } else {
            entityMap[cleanTable] = cleanTable.toLowerCase();
            details.push(`Retained canonical table name "${cleanTable}" (aliased as ${alias || "self"})`);
        }
    }

    const colRegex = /([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)/g;
    while ((match = colRegex.exec(request.legacySql)) !== null) {
        const col = match[2];
        if (!detectedColumns.includes(col)) {
            detectedColumns.push(col);
        }
    }

    if (request.schemaContext?.tables?.length) {
        details.push(`Contextualized against GoForge target schema containing ${request.schemaContext.tables.length} tables.`);
    } else {
        details.push(`Running standalone semantic extraction (no canvas schema binding specified).`);
    }

    const durationMs = Date.now() - startTime;

    const trace: AgentTrace = {
        agentId: "mapper",
        name: "Schema & Semantic Mapper Agent",
        role: "Entity Resolution & Target Catalog Alignment",
        status: "success",
        title: `Resolved ${detectedTables.length} tables & mapped schema aliases`,
        details: details.length ? details : ["Analyzed query structure and confirmed schema catalog alignment."],
        durationMs,
        timestamp: Date.now(),
        metadata: {
            detectedTables,
            detectedColumnsCount: detectedColumns.length,
            mappedCount: Object.keys(entityMap).length,
        }
    };

    return {
        entityMap,
        detectedTables,
        detectedColumns,
        trace
    };
}
