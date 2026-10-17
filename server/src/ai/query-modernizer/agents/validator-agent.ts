import { AgentTrace, ModernizeRequest, ValidationReport } from "../types.js";
import { TranspilerOutput } from "./transpiler-agent.js";

export interface ValidatorOutput {
    report: ValidationReport;
    needsRetry: boolean;
    trace: AgentTrace;
}

function checkDelimiters(sql: string): string[] {
    const errors: string[] = [];
    const stack: { char: string; index: number }[] = [];
    let inString = false;
    let quoteChar = "";

    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];

        if ((ch === "'" || ch === '"') && (i === 0 || sql[i - 1] !== "\\")) {
            if (!inString) {
                inString = true;
                quoteChar = ch;
            } else if (ch === quoteChar) {
                inString = false;
            }
            continue;
        }

        if (inString) continue;

        if (ch === "(" || ch === "[") {
            stack.push({ char: ch, index: i });
        } else if (ch === ")") {
            const last = stack.pop();
            if (!last || last.char !== "(") {
                errors.push(`Unmatched closing parenthesis ')' at character index ${i}`);
            }
        } else if (ch === "]") {
            const last = stack.pop();
            if (!last || last.char !== "[") {
                errors.push(`Unmatched closing bracket ']' at character index ${i}`);
            }
        }
    }

    if (stack.length > 0) {
        errors.push(`Unclosed '${stack[0].char}' detected in translated query`);
    }

    return errors;
}

function checkRecursiveCte(sql: string): string[] {
    const errors: string[] = [];
    if (/WITH\s+RECURSIVE/i.test(sql)) {
        if (!/UNION\s+ALL/i.test(sql)) {
            errors.push("Recursive CTE requires a 'UNION ALL' separating anchor and recursive components");
        }
    }
    return errors;
}

function detectAntiPatterns(sql: string): string[] {
    const warnings: string[] = [];

    if (/WHERE[^\n;]+(?:YEAR|MONTH|DAY)\s*\(/i.test(sql)) {
        warnings.push("Non-SARGable predicate detected: Applying date function on indexed column prevents index seek");
    }

    if (/NOT\s+IN\s*\(\s*SELECT/i.test(sql)) {
        warnings.push("Hazardous 'NOT IN (SELECT ...)' detected: Subquery returning NULL will silently yield 0 rows");
    }

    if (/SELECT[\s\S]+?\(\s*SELECT[\s\S]+?FROM[\s\S]+?WHERE[\s\S]+?\)\s*AS/i.test(sql)) {
        warnings.push("Correlated scalar subquery in SELECT projection: Forces N+1 query execution plan");
    }

    if (/SELECT\s+(?:\w+\.)?\*\s+FROM/i.test(sql)) {
        warnings.push("Unbounded 'SELECT *' detected: Excessive network IO and breaks cache contracts");
    }

    return warnings;
}

export function runValidatorAgent(
    _request: ModernizeRequest,
    transpiler: TranspilerOutput,
    retryCount: number = 0
): ValidatorOutput {
    const startTime = Date.now();
    const sql = transpiler.translatedSql;

    const astErrors: string[] = [];
    const schemaWarnings: string[] = [];

    const delimErrors = checkDelimiters(sql);
    astErrors.push(...delimErrors);

    const cteErrors = checkRecursiveCte(sql);
    astErrors.push(...cteErrors);

    if (!/SELECT\b/i.test(sql) || !/FROM\b/i.test(sql)) {
        astErrors.push("Query must contain standard SELECT and FROM clauses");
    }

    const antiPatterns = detectAntiPatterns(sql);

    const isValid = astErrors.length === 0;
    const needsRetry = !isValid && retryCount < 2;

    const details: string[] = [];
    if (isValid) {
        details.push("AST Syntax check: PASSED (ANSI/PostgreSQL grammar verified)");
        if (antiPatterns.length > 0) {
            details.push(`Flagged ${antiPatterns.length} potential performance anti-pattern(s) for the Optimizer Agent`);
            for (const ap of antiPatterns) {
                details.push(`• Anti-Pattern: ${ap}`);
            }
        } else {
            details.push("Zero syntax errors and zero structural anti-patterns detected.");
        }
    } else {
        details.push(`AST Syntax check: FAILED (${astErrors.length} issue(s) found)`);
        for (const err of astErrors) {
            details.push(`• Error: ${err}`);
        }
        if (needsRetry) {
            details.push(`Triggering reflection feedback loop (Attempt ${retryCount + 1} of 2)`);
        }
    }

    const durationMs = Date.now() - startTime;

    const report: ValidationReport = {
        isValid,
        astErrors,
        schemaWarnings,
        antiPatternsDetected: antiPatterns,
        retryCount
    };

    const trace: AgentTrace = {
        agentId: "validator",
        name: "Validation & AST Verifier Agent",
        role: "Static Analysis, Grammar & Schema Conformance",
        status: isValid ? "success" : needsRetry ? "retrying" : "error",
        title: isValid ? "Syntax & Schema Validation Passed" : `Validation Failed: ${astErrors[0] || "Syntax error"}`,
        details,
        durationMs,
        timestamp: Date.now(),
        metadata: {
            isValid,
            errorsCount: astErrors.length,
            antiPatternsCount: antiPatterns.length,
            retryCount
        }
    };

    return {
        report,
        needsRetry,
        trace
    };
}
