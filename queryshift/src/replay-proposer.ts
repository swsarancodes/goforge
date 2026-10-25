import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { LoopResult, Proposer } from "./loop";

/**
 * Plays back the answers a model gave in an earlier run (the trace `--out` writes), so the correction loop can be shown and re-checked
 * with no key and no network. Nothing is asked of a model: each correction the loop requests gets the SQL recorded for that correction
 * number. Everything after that is live. The recorded query goes through the same guard, the same run on the same data and the same
 * comparison as a fresh answer, and it is verified or not on those results.
 *
 * What a replay cannot show is that a model gives that answer today. Every replayed attempt says so (`source: "replay"`, `replayedFrom`),
 * and it keeps the model, the tokens and the prompt of the request it came from.
 */

export const traceFile = (dir: string, caseId: string) => resolve(dir, `${caseId}.loop.json`);

/** Reads a trace and says what is wrong with it: a file that is not one must not be replayed as if it were. */
export function readTrace(file: string): LoopResult {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
        throw new Error(`${file} cannot be read as a trace: ${error instanceof Error ? error.message : String(error)}`);
    }
    const trace = raw as Partial<LoopResult> | null;
    const wellFormed = typeof trace?.caseId === "string" && Array.isArray(trace.attempts) && trace.attempts.every((attempt) => typeof attempt?.n === "number" && typeof attempt.sql === "string");
    if (!wellFormed) throw new Error(`${file} is not a QueryShift loop trace: it needs a caseId and a list of attempts, each with a number and sql`);
    return trace as LoopResult;
}

/** A proposer that answers from the recording of one case in `dir`. The recording is read when a correction is first asked for. */
export function replayProposer(dir: string, caseId: string): Proposer {
    const file = traceFile(dir, caseId);
    return {
        name: "replay",
        async propose(input) {
            if (!existsSync(file)) throw new Error(`there is no recording of ${caseId} to replay (${file})`);
            const trace = readTrace(file);
            if (trace.caseId !== caseId) throw new Error(`${file} is the recording of ${trace.caseId}, not ${caseId}`);
            // attempt 0 is the rule engine's own conversion; the corrections that follow are the recorded answers
            const recorded = trace.attempts.find((attempt) => attempt.n === input.attempt && attempt.n > 0);
            if (!recorded) throw new Error(`the recording of ${caseId} has no correction ${input.attempt} (it ends after ${Math.max(0, ...trace.attempts.map((attempt) => attempt.n))})`);
            // relative, so a saved trace does not carry the path of the machine it was replayed on
            return { ...recorded.proposal, sql: recorded.sql, replayedFrom: relative(process.cwd(), file) };
        },
    };
}
