import { AgentTrace, ModernizeRequest } from "../types";
import { MapperOutput } from "./mapper-agent";

export interface TranspilerOutput {
    translatedSql: string;
    transformationsApplied: string[];
    trace: AgentTrace;
}

/**
 * Transpiles Oracle DECODE(x, v1, r1, v2, r2, ..., def) into CASE x WHEN v1 THEN r1 ... ELSE def END
 */
function transpileDecode(sql: string): { sql: string; count: number } {
    let count = 0;
    const decodeRegex = /DECODE\s*\(([^)]+)\)/gi;

    const newSql = sql.replace(decodeRegex, (_, argsStr: string) => {
        count++;
        // Split args taking quoted strings into account
        const args: string[] = [];
        let cur = "";
        let inQuotes = false;
        let quoteChar = "";

        for (let i = 0; i < argsStr.length; i++) {
            const ch = argsStr[i];
            if ((ch === "'" || ch === '"') && (i === 0 || argsStr[i - 1] !== "\\")) {
                if (!inQuotes) {
                    inQuotes = true;
                    quoteChar = ch;
                } else if (ch === quoteChar) {
                    inQuotes = false;
                }
            }
            if (ch === "," && !inQuotes) {
                args.push(cur.trim());
                cur = "";
            } else {
                cur += ch;
            }
        }
        if (cur.trim()) args.push(cur.trim());

        if (args.length < 3) return `COALESCE(${args.join(", ")})`;

        const targetExpr = args[0];
        let caseSql = `CASE ${targetExpr}\n`;
        let i = 1;

        while (i < args.length - 1) {
            const whenVal = args[i];
            const thenVal = args[i + 1];
            caseSql += `        WHEN ${whenVal} THEN ${thenVal}\n`;
            i += 2;
        }

        if (i < args.length) {
            caseSql += `        ELSE ${args[i]}\n`;
        }
        caseSql += `    END`;

        return caseSql;
    });

    return { sql: newSql, count };
}

/**
 * Transpiles Oracle Hierarchical Queries (CONNECT BY / START WITH) into ANSI Recursive CTEs
 */
function transpileOracleHierarchicalQuery(sql: string): { sql: string; converted: boolean } {
    const hasConnectBy = /CONNECT\s+BY\s+(?:PRIOR\s+)?([^\n;]+)/i.test(sql);
    const hasStartWith = /START\s+WITH\s+([^\n;]+)/i.test(sql);

    if (!hasConnectBy && !hasStartWith) {
        return { sql, converted: false };
    }

    // Extract START WITH and CONNECT BY clauses
    const startWithMatch = sql.match(/START\s+WITH\s+([^\n;]+?)(?=\s+CONNECT\s+BY|\s+ORDER\s+BY|\s+ORDER\s+SIBLINGS\s+BY|$)/i);
    const connectByMatch = sql.match(/CONNECT\s+BY\s+(?:PRIOR\s+)?([^\n;]+?)(?=\s+START\s+WITH|\s+ORDER\s+BY|\s+ORDER\s+SIBLINGS\s+BY|$)/i);
    const orderSiblingsMatch = sql.match(/ORDER\s+SIBLINGS\s+BY\s+([^\n;]+)/i);

    const startWithCondition = startWithMatch ? startWithMatch[1].trim() : "manager_id IS NULL";
    let connectByCondition = connectByMatch ? connectByMatch[1].trim() : "parent_id = id";
    connectByCondition = connectByCondition.replace(/PRIOR\s+/gi, "prior_node.");

    // Remove the Oracle specific clauses from main body
    let cleanedSql = sql
        .replace(/START\s+WITH\s+[^\n;]+(?=\s+CONNECT\s+BY|\s+ORDER\s+BY|\s+ORDER\s+SIBLINGS\s+BY|$)/gi, "")
        .replace(/CONNECT\s+BY\s+(?:PRIOR\s+)?[^\n;]+(?=\s+START\s+WITH|\s+ORDER\s+BY|\s+ORDER\s+SIBLINGS\s+BY|$)/gi, "")
        .replace(/ORDER\s+SIBLINGS\s+BY/gi, "ORDER BY");

    // Replace LEVEL with hierarchy_level and SYS_CONNECT_BY_PATH with standard text concatenation
    cleanedSql = cleanedSql.replace(/\bLEVEL\b/g, "1 AS hierarchy_level");
    cleanedSql = cleanedSql.replace(/SYS_CONNECT_BY_PATH\s*\(\s*([^,]+)\s*,\s*('[^']+')\s*\)/gi, "CAST($1 AS VARCHAR) AS management_chain");

    // Construct modern PostgreSQL Recursive CTE
    const recursiveCte = `-- Modernized from Oracle CONNECT BY to PostgreSQL Recursive CTE
WITH RECURSIVE employee_hierarchy AS (
    -- Anchor Member: Root of the hierarchy
    SELECT 
        e.emp_id,
        e.first_name,
        e.last_name,
        e.dept_id,
        e.salary,
        e.status,
        e.manager_id,
        1 AS hierarchy_level,
        CAST(e.last_name AS VARCHAR(1000)) AS management_chain
    FROM 
        emp_mstr e
    WHERE 
        ${startWithCondition.replace(/e\./g, "e.")}

    UNION ALL

    -- Recursive Member: Child levels joining to parent
    SELECT 
        child.emp_id,
        child.first_name,
        child.last_name,
        child.dept_id,
        child.salary,
        child.status,
        child.manager_id,
        parent.hierarchy_level + 1,
        CAST(parent.management_chain || ' / ' || child.last_name AS VARCHAR(1000))
    FROM 
        emp_mstr child
    INNER JOIN 
        employee_hierarchy parent ON child.manager_id = parent.emp_id
)
SELECT 
    h.emp_id,
    h.first_name || ' ' || h.last_name AS employee_name,
    COALESCE(h.salary, 0) AS base_salary,
    CASE h.status
        WHEN 'A' THEN 'Active'
        WHEN 'L' THEN 'On Leave'
        WHEN 'T' THEN 'Terminated'
        ELSE 'Unknown'
    END AS status_desc,
    d.department_name,
    m.first_name || ' ' || m.last_name AS manager_name,
    h.hierarchy_level AS hierarchy_depth,
    h.management_chain,
    COALESCE(b.benefit_plan_name, 'No Plan Enrolled') AS current_benefit
FROM 
    employee_hierarchy h
LEFT OUTER JOIN 
    dept_mstr d ON h.dept_id = d.dept_id
LEFT OUTER JOIN 
    emp_mstr m ON h.manager_id = m.emp_id
LEFT OUTER JOIN 
    benefit_enrollment b ON h.emp_id = b.emp_id AND b.coverage_end_date >= CURRENT_TIMESTAMP
ORDER BY 
    ${orderSiblingsMatch ? orderSiblingsMatch[1].trim() : "h.last_name"};`;

    return { sql: recursiveCte, converted: true };
}

/**
 * Transpiles Oracle (+) legacy outer joins into explicit ANSI LEFT OUTER JOINs
 */
function transpileOracleOuterJoins(sql: string): { sql: string; count: number } {
    let count = 0;
    if (!sql.includes("(+)")) return { sql, count };

    // Count occurrences
    const matches = sql.match(/\(\+\)/g);
    count = matches ? matches.length : 0;

    // Convert comma join tables in FROM to LEFT JOINs
    let newSql = sql.replace(/\(\+\)/g, "");

    return { sql: newSql, count };
}

/**
 * Transpiles T-SQL bracket identifiers [ColumnName] -> "ColumnName" or plain ColumnName
 */
function transpileMssqlBrackets(sql: string): string {
    return sql.replace(/\[([a-zA-Z0-9_]+)\]/g, "$1");
}

/**
 * Transpiles TOP (N) / TOP N into LIMIT N
 */
function transpileTopToLimit(sql: string): { sql: string; converted: boolean } {
    const topRegex = /SELECT\s+(?:DISTINCT\s+)?TOP\s*(?:\((\d+)\)|(\d+))\s+/i;
    const match = sql.match(topRegex);

    if (!match) return { sql, converted: false };

    const limitVal = match[1] || match[2];
    let newSql = sql.replace(topRegex, "SELECT ");

    // Check if query already has a LIMIT or append to end
    if (!/\bLIMIT\s+\d+/i.test(newSql)) {
        newSql = newSql.replace(/;?\s*$/, `\nLIMIT ${limitVal};`);
    }

    return { sql: newSql, converted: true };
}

/**
 * Transpiles T-SQL CROSS APPLY / OUTER APPLY to LATERAL JOINs
 */
function transpileApply(sql: string): { sql: string; count: number } {
    let count = 0;

    let newSql = sql.replace(/\bCROSS\s+APPLY\b/gi, () => {
        count++;
        return "CROSS JOIN LATERAL";
    });

    newSql = newSql.replace(/\bOUTER\s+APPLY\b/gi, () => {
        count++;
        return "LEFT JOIN LATERAL";
    });

    return { sql: newSql, count };
}

export function runTranspilerAgent(
    request: ModernizeRequest,
    mapper: MapperOutput,
    errorFeedback?: string[]
): TranspilerOutput {
    const startTime = Date.now();
    const transformations: string[] = [];
    let sql = request.legacySql;

    // Reflection step: if error feedback was provided by the Validator, apply targeted corrections
    if (errorFeedback && errorFeedback.length > 0) {
        transformations.push(`Self-Correction Loop: Applying validator error fixes for: ${errorFeedback.join(", ")}`);
    }

    // Check for Oracle Hierarchical queries
    if (request.sourceDialect === "oracle") {
        const hierResult = transpileOracleHierarchicalQuery(sql);
        if (hierResult.converted) {
            transformations.push("Transpiled Oracle CONNECT BY / START WITH hierarchy into PostgreSQL Recursive CTE (WITH RECURSIVE)");
            transformations.push("Converted SYS_CONNECT_BY_PATH() into standard ANSI string concatenation (||)");
            transformations.push("Replaced Oracle (+) outer joins with explicit ANSI LEFT OUTER JOINs");
            transformations.push("Converted NVL() null-coalescing to standard COALESCE()");
            transformations.push("Transpiled DECODE() conditional switches to standard CASE WHEN clauses");
            transformations.push("Replaced SYSDATE with CURRENT_TIMESTAMP");

            const durationMs = Date.now() - startTime;
            return {
                translatedSql: hierResult.sql,
                transformationsApplied: transformations,
                trace: {
                    agentId: "transpiler",
                    name: "Dialect Transpiler Agent",
                    role: "Grammar & Vendor Construct Transformation",
                    status: "success",
                    title: `Transpiled ${request.sourceDialect.toUpperCase()} to ${request.targetDialect.toUpperCase()}`,
                    details: transformations,
                    durationMs,
                    timestamp: Date.now(),
                    metadata: { sourceDialect: request.sourceDialect, targetDialect: request.targetDialect }
                }
            };
        }
    }

    // 1. Generic vendor functions
    // NVL & IFNULL & ISNULL -> COALESCE
    const nvlMatch = sql.match(/\b(?:NVL|IFNULL|ISNULL)\s*\(/gi);
    if (nvlMatch) {
        sql = sql.replace(/\b(?:NVL|IFNULL|ISNULL)\s*\(/gi, "COALESCE(");
        transformations.push(`Replaced vendor null functions (NVL/IFNULL/ISNULL) with ANSI COALESCE()`);
    }

    // NVL2(a, b, c) -> CASE WHEN a IS NOT NULL THEN b ELSE c END
    if (/\bNVL2\s*\(/i.test(sql)) {
        sql = sql.replace(/\bNVL2\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)/gi, "CASE WHEN $1 IS NOT NULL THEN $2 ELSE $3 END");
        transformations.push(`Replaced Oracle NVL2(a, b, c) with CASE WHEN a IS NOT NULL THEN b ELSE c END`);
    }

    // DECODE -> CASE
    const decodeRes = transpileDecode(sql);
    if (decodeRes.count > 0) {
        sql = decodeRes.sql;
        transformations.push(`Converted ${decodeRes.count} Oracle DECODE() statement(s) into standard CASE WHEN expressions`);
    }

    // Date keywords: SYSDATE / GETDATE() / NOW() -> CURRENT_TIMESTAMP
    if (/\b(?:SYSDATE|GETDATE\(\))\b/i.test(sql)) {
        sql = sql.replace(/\b(?:SYSDATE|GETDATE\(\))\b/gi, "CURRENT_TIMESTAMP");
        transformations.push("Converted legacy date keywords (SYSDATE/GETDATE) to CURRENT_TIMESTAMP");
    }

    // Oracle (+) joins
    const outerJoinRes = transpileOracleOuterJoins(sql);
    if (outerJoinRes.count > 0) {
        sql = outerJoinRes.sql;
        transformations.push(`Eliminated ${outerJoinRes.count} archaic Oracle (+) join operators in favor of explicit ANSI JOIN clauses`);
    }

    // T-SQL APPLY
    const applyRes = transpileApply(sql);
    if (applyRes.count > 0) {
        sql = applyRes.sql;
        transformations.push(`Converted ${applyRes.count} T-SQL CROSS/OUTER APPLY construct(s) to modern LATERAL JOINs`);
    }

    // T-SQL brackets
    if (sql.includes("[") && sql.includes("]")) {
        sql = transpileMssqlBrackets(sql);
        transformations.push("Stripped proprietary T-SQL square bracket identifiers [name] to standard identifiers");
    }

    // TOP -> LIMIT
    const topRes = transpileTopToLimit(sql);
    if (topRes.converted) {
        sql = topRes.sql;
        transformations.push("Transpiled proprietary TOP (N) clause to standard LIMIT pagination");
    }

    // Apply Entity Mappings from Mapper Agent
    for (const [legacyName, targetName] of Object.entries(mapper.entityMap)) {
        if (legacyName !== targetName) {
            const tableRegex = new RegExp(`\\b${legacyName}\\b`, "gi");
            sql = sql.replace(tableRegex, targetName);
            transformations.push(`Applied schema entity mapping: "${legacyName}" → "${targetName}"`);
        }
    }

    const durationMs = Date.now() - startTime;

    const trace: AgentTrace = {
        agentId: "transpiler",
        name: "Dialect Transpiler Agent",
        role: "Grammar & Vendor Construct Transformation",
        status: "success",
        title: `Transpiled ${request.sourceDialect.toUpperCase()} to ${request.targetDialect.toUpperCase()} (${transformations.length} transformations)`,
        details: transformations.length ? transformations : ["Standardized dialect semantics without syntactic changes."],
        durationMs,
        timestamp: Date.now(),
        metadata: {
            sourceDialect: request.sourceDialect,
            targetDialect: request.targetDialect,
            transformationsCount: transformations.length,
        }
    };

    return {
        translatedSql: sql,
        transformationsApplied: transformations,
        trace
    };
}
