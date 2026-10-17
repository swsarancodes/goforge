import { AgentTrace, ModernizeRequest, ModernizeResponse } from "./types.js";
import { runMapperAgent } from "./agents/mapper-agent.js";
import { runTranspilerAgent } from "./agents/transpiler-agent.js";
import { runValidatorAgent } from "./agents/validator-agent.js";
import { runOptimizerAgent } from "./agents/optimizer-agent.js";
import { runJudgeAgent } from "./agents/judge-agent.js";

export type OnStepCallback = (trace: AgentTrace) => void;

export async function modernizeQuery(
    request: ModernizeRequest,
    onStep?: OnStepCallback
): Promise<ModernizeResponse> {
    const traces: AgentTrace[] = [];

    const emitStep = (trace: AgentTrace) => {
        traces.push(trace);
        if (onStep) onStep(trace);
    };

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    if (onStep) await sleep(80);
    const mapperOutput = runMapperAgent(request);
    emitStep(mapperOutput.trace);

    if (onStep) await sleep(80);
    let transpilerOutput = runTranspilerAgent(request, mapperOutput);
    emitStep(transpilerOutput.trace);

    if (onStep) await sleep(80);
    let validatorOutput = runValidatorAgent(request, transpilerOutput, 0);
    emitStep(validatorOutput.trace);

    if (validatorOutput.needsRetry) {
        if (onStep) await sleep(100);
        transpilerOutput = runTranspilerAgent(request, mapperOutput, validatorOutput.report.astErrors);
        emitStep({
            ...transpilerOutput.trace,
            title: `Self-Correction Attempt 1: Repaired ${validatorOutput.report.astErrors.length} syntax issues`,
        });

        validatorOutput = runValidatorAgent(request, transpilerOutput, 1);
        emitStep(validatorOutput.trace);
    }

    if (onStep) await sleep(80);
    const currentSql = transpilerOutput.translatedSql;
    const optimizerOutput = runOptimizerAgent(request, validatorOutput, currentSql);
    emitStep(optimizerOutput.trace);

    if (onStep) await sleep(80);
    const judgeOutput = runJudgeAgent(
        request,
        mapperOutput,
        transpilerOutput,
        validatorOutput,
        optimizerOutput,
        request.legacySql,
        optimizerOutput.optimizedSql
    );
    emitStep(judgeOutput.trace);

    return {
        originalSql: request.legacySql,
        translatedSql: transpilerOutput.translatedSql,
        optimizedSql: optimizerOutput.optimizedSql,
        diff: judgeOutput.diff,
        confidenceScore: judgeOutput.confidenceScore,
        riskLevel: judgeOutput.riskLevel,
        agentTraces: traces,
        indexRecommendations: optimizerOutput.indexRecommendations,
        transformationsSummary: judgeOutput.transformationsSummary,
        validationReport: validatorOutput.report,
        verificationSql: judgeOutput.verificationSql
    };
}
