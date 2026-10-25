import { aiSchemaPlanSchema, type AiSchemaPlan } from "../../server/src/ai/schema-plan";
import { compilePlan, discoverProbes } from "../../server/src/schema-change/compile";
import { loadFacts, probe, type Facts } from "../../server/src/schema-change/facts";
import type { CompileSettings, Runbook } from "../../server/src/schema-change/runbook";
import { splitSqlStatements } from "../../server/src/services/sql-tokens";
import type { PgClient } from "./pg-scratch";

export const asRunner = (client: PgClient) => ({ query: (text: string) => client.query(text) as Promise<unknown> });

/** Validates a plan the way the API does, so a check can't pass a shape the real endpoint would refuse. */
export const parsePlan = (operations: unknown[], extra: Record<string, unknown> = {}): AiSchemaPlan =>
    aiSchemaPlanSchema.parse({ summary: "test plan", assumptions: [], warnings: [], clarifyingQuestions: [], operations, ...extra });

export interface Compiled {
    facts: Facts;
    runbook: Runbook;
}

/** Read the scope's facts from the database, ask it what the plan needs verified, and compile. */
export async function compileOn(client: PgClient, plan: AiSchemaPlan, tables: string[], settings?: Partial<CompileSettings>): Promise<Compiled> {
    const facts = await loadFacts(asRunner(client), tables);
    const request = discoverProbes({ plan, facts, settings });
    const probes = await probe(asRunner(client), request);
    return { facts, runbook: compilePlan({ plan, facts, probes, settings }) };
}

export interface RunResult {
    ok: boolean;
    ran: number;
    failure?: { step: number; title: string; statement: string; message: string };
}

/** What the SQL Editor does in no-transaction mode: every statement on its own, stopping at the first error. Optional (commented) steps are not run. */
export async function runRunbook(client: PgClient, runbook: Runbook, options: { includeOptional?: boolean } = {}): Promise<RunResult> {
    let ran = 0;
    for (const step of runbook.steps) {
        if (step.optional && !options.includeOptional) continue;
        for (const statement of splitSqlStatements(step.sql)) {
            try {
                await client.query(statement.text);
                ran++;
            } catch (error) {
                return { ok: false, ran, failure: { step: step.id, title: step.title, statement: statement.text.slice(0, 200), message: error instanceof Error ? error.message : String(error) } };
            }
        }
    }
    return { ok: true, ran };
}
