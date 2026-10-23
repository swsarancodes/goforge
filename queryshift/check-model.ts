/**
 * npm run queryshift:check-model
 *
 * Asks the configured model, through the same AI layer the correction loop uses, for a correction in the real `correct_query` shape. It
 * checks that the key and the model work and that OpenAI accepts the strict answer schema. One request, about a hundred tokens, no schema
 * or data of yours; prints no key.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { correctQueryResultSchema } from "../server/src/ai/correct-query";
import { callModelJson, getAiStatus } from "../server/src/ai/provider";
import { openAiHost } from "../server/src/ai/openai";

createRequire(new URL("../server/package.json", import.meta.url))("dotenv").config({ path: resolve(import.meta.dirname, "../server/.env") });

const status = await getAiStatus();
if (!status.configured) {
    console.error(`Not ready: ${status.problem}`);
    process.exit(1);
}
console.log(`Checking ${status.model} on ${openAiHost()} (key from ${status.credentialsSource})\n`);

const checks = [
    { name: "correct_query", schema: correctQueryResultSchema, instructions: "Return JSON for the query SELECT 1: sql is the query, explanation is one short sentence, changes and risks are empty lists." },
];

let failed = 0;
for (const check of checks) {
    try {
        const result = await callModelJson({ instructions: check.instructions, input: "check", maxOutputTokens: 1_500, format: { name: check.name, schema: check.schema }, purpose: "queryshift-check-model" });
        const parsed = check.schema.safeParse(result.output);
        if (!parsed.success) throw new Error(`answered, but not in the expected shape: ${parsed.error.issues[0]?.path.join(".") || "answer"}: ${parsed.error.issues[0]?.message}`);
        console.log(`  ok    ${check.name.padEnd(14)} ${result.latencyMs} ms, ${result.usage.inputTokens ?? "?"} in / ${result.usage.outputTokens ?? "?"} out tokens`);
    } catch (error) {
        failed++;
        console.log(`  FAIL  ${check.name.padEnd(14)} ${error instanceof Error ? error.message : String(error)}`);
    }
}
console.log(failed === 0 ? "\nThe model answered in the shape the loop needs." : `\n${failed} of ${checks.length} failed.`);
process.exit(failed === 0 ? 0 : 1);
