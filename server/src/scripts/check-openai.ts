import "dotenv/config";
import { z } from "zod";
import { correctQueryResultSchema } from "../ai/correct-query.js";
import { modernizeQueryResultSchema } from "../ai/modernize-query.js";
import { openAiHost } from "../ai/openai.js";
import { normalizePlanOutput } from "../ai/plan-normalize.js";
import { aiSchemaPlanModelSchema, aiSchemaPlanSchema } from "../ai/schema-plan.js";
import { callModelJson, getAiStatus } from "../ai/provider.js";
import type { ResponseFormat } from "../ai/structured.js";
import { healthAnswerSchema } from "../schema-change/health-summary.js";

/**
 * npm --prefix server run check:openai
 *
 * Asks OpenAI, once per kind of answer this app asks a model for, to fill the answer with placeholder text. It checks that the key and the
 * model work, and above all that OpenAI accepts each answer schema in strict structured-output mode, which nothing in the test suite can
 * prove without a key. It costs a few hundred tokens in all, sends no schema or data of yours, and prints no key.
 */
/** `accepts` is the validator the app really applies to this answer afterwards. */
const checks: { name: string; format: ResponseFormat; instructions: string; accepts?: (output: unknown) => z.SafeParseReturnType<unknown, unknown> }[] = [
    { name: "ping", format: { name: "ping", schema: z.object({ ok: z.boolean() }) }, instructions: 'Return the JSON object {"ok": true}.' },
    { name: "modernize_query", format: { name: "modernize_query", schema: modernizeQueryResultSchema }, instructions: "Return JSON for the query SELECT 1: sql is the query, summary is one short sentence, changes, risks and unsupported are empty lists." },
    { name: "correct_query", format: { name: "correct_query", schema: correctQueryResultSchema }, instructions: "Return JSON for the query SELECT 1: sql is the query, explanation is one short sentence, changes and risks are empty lists." },
    { name: "health_summary", format: { name: "health_summary", schema: healthAnswerSchema }, instructions: "Return JSON: headline is the sentence No findings., priorities is an empty list." },
    { name: "schema_change_plan", format: { name: "schema_change_plan", schema: aiSchemaPlanModelSchema }, instructions: "Return JSON: summary is the word check, assumptions and warnings are empty lists, clarifyingQuestions holds the one question Which table?, operations is an empty list.", accepts: (output) => aiSchemaPlanSchema.safeParse(normalizePlanOutput(output)) },
];

const status = await getAiStatus();
if (!status.configured) {
    console.error(`Not ready: ${status.problem}`);
    process.exit(1);
}
console.log(`Checking ${status.model} on ${openAiHost()} (key from ${status.credentialsSource})\n`);

let failed = 0;
for (const check of checks) {
    try {
        const result = await callModelJson({ instructions: check.instructions, input: "check", maxOutputTokens: 1_500, format: check.format, purpose: "check-openai" });
        const parsed = (check.accepts ?? ((output: unknown) => check.format.schema.safeParse(output)))(result.output);
        if (!parsed.success) throw new Error(`answered, but not in the shape our validator accepts: ${parsed.error.issues[0]?.path.join(".") || "answer"}: ${parsed.error.issues[0]?.message}`);
        console.log(`  ok    ${check.name.padEnd(20)} ${result.latencyMs} ms, ${result.usage.inputTokens ?? "?"} in / ${result.usage.outputTokens ?? "?"} out tokens`);
    } catch (error) {
        failed++;
        console.log(`  FAIL  ${check.name.padEnd(20)} ${error instanceof Error ? error.message : String(error)}`);
    }
}
console.log(failed === 0 ? "\nEvery answer schema was accepted." : `\n${failed} of ${checks.length} failed.`);
process.exit(failed === 0 ? 0 : 1);
