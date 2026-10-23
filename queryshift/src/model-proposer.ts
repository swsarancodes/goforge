import type { CorrectQueryRequest } from "../../server/src/ai/correct-query";
import { createQueryCorrection } from "../../server/src/ai/correct-query";
import type { Proposer } from "./loop";

/**
 * Asks the model through GoForge's own AI layer (policy check, the audit log, structured outputs), not around it. What it sends is the
 * legacy query, the table and column names, the mapping, the previous query and the measured evidence. Evidence includes the values of
 * the rows that differ, so this must only run on synthetic or approved data. That is the data policy of the challenge and of this harness.
 */
export function modelProposer(): Proposer {
    return {
        name: "model",
        async propose(input) {
            const request: CorrectQueryRequest = {
                legacySql: input.loaded.legacySql,
                sourceDialect: input.loaded.definition.legacyDialect as CorrectQueryRequest["sourceDialect"],
                businessPurpose: input.loaded.definition.businessPurpose,
                schema: { tables: input.schema },
                mapping: input.mapping.map(({ sourceTable, sourceColumn, targetTable, targetColumn, note }) => ({ sourceTable, sourceColumn, targetTable, targetColumn, ...(note ? { note } : {}) })),
                previousSql: input.previousSql,
                attempt: input.attempt,
                maxAttempts: input.maxAttempts,
                evidence: {
                    kind: input.evidence.kind,
                    message: input.evidence.message,
                    expectedColumns: input.evidence.expectedColumns,
                    columnProblem: input.evidence.columnProblem,
                    orderProblem: input.evidence.orderProblem,
                    missingRows: input.evidence.missingRows,
                    unexpectedRows: input.evidence.unexpectedRows,
                    missingCount: input.evidence.missingCount,
                    unexpectedCount: input.evidence.unexpectedCount,
                    differingColumns: input.evidence.differingColumns,
                    brokenInvariants: input.evidence.brokenInvariants,
                    staticFindings: input.evidence.staticFindings,
                },
                engineWarnings: input.engineWarnings,
            };
            const { result, model, auditId, usage, latencyMs } = await createQueryCorrection(request);
            return { sql: result.sql, explanation: result.explanation, changes: result.changes, risks: result.risks, model, auditId, usage, latencyMs };
        },
    };
}
