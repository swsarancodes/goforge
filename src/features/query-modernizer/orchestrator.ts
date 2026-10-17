import { AgentTrace, ModernizeRequest, ModernizeResponse } from "./types";
import { runMapperAgent } from "./agents/mapper-agent";
import { runTranspilerAgent } from "./agents/transpiler-agent";
import { runValidatorAgent } from "./agents/validator-agent";
import { runOptimizerAgent } from "./agents/optimizer-agent";
import { runJudgeAgent } from "./agents/judge-agent";

export type OnStepCallback = (trace: AgentTrace) => void;

/**
 * Multi-Agent Orchestrator coordinates the specialized agents:
 * 1. Mapper Agent -> Entity resolution & catalog alignment
 * 2. Transpiler Agent -> Grammar & dialect transformation
 * 3. Validator Agent -> AST syntax & schema verification (+ Reflection retry loop)
 * 4. Optimizer Agent -> SARGable rewrites, anti-pattern removal & index recommendations
 * 5. Judge Agent -> Equivalence scoring, risk rating & diff analysis
 */
export async function modernizeQuery(
    request: ModernizeRequest,
    onStep?: OnStepCallback
): Promise<ModernizeResponse> {
    const traces: AgentTrace[] = [];

    const emitStep = (trace: AgentTrace) => {
        traces.push(trace);
        if (onStep) onStep(trace);
    };

    // Optional delay helper for visual streaming in UI demo
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // STEP 1: Mapper Agent
    if (onStep) await sleep(80);
    const mapperOutput = runMapperAgent(request);
    emitStep(mapperOutput.trace);

    // STEP 2: Transpiler Agent
    if (onStep) await sleep(80);
    let transpilerOutput = runTranspilerAgent(request, mapperOutput);
    emitStep(transpilerOutput.trace);

    // STEP 3: Validator Agent (with reflection retry loop)
    if (onStep) await sleep(80);
    let validatorOutput = runValidatorAgent(request, transpilerOutput, 0);
    emitStep(validatorOutput.trace);

    // Reflection Self-Correction Loop
    if (validatorOutput.needsRetry) {
        if (onStep) await sleep(100);
        // Transpiler Agent re-runs with validator feedback
        transpilerOutput = runTranspilerAgent(request, mapperOutput, validatorOutput.report.astErrors);
        emitStep({
            ...transpilerOutput.trace,
            title: `Self-Correction Attempt 1: Repaired ${validatorOutput.report.astErrors.length} syntax issues`,
        });

        // Re-validate
        validatorOutput = runValidatorAgent(request, transpilerOutput, 1);
        emitStep(validatorOutput.trace);
    }

    // STEP 4: Optimizer Agent
    if (onStep) await sleep(80);
    const currentSql = transpilerOutput.translatedSql;
    const optimizerOutput = runOptimizerAgent(request, validatorOutput, currentSql);
    emitStep(optimizerOutput.trace);

    // STEP 5: Judge Agent
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
