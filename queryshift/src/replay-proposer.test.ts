import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTrace, replayProposer, traceFile } from "./replay-proposer";

// The proposer alone, with no database. That the loop judges what it plays back, live, is tested in loop.test.ts.
const reports = resolve(import.meta.dirname, "../reports");
const asked = (attempt: number) => ({ attempt }) as Parameters<ReturnType<typeof replayProposer>["propose"]>[0];

describe("playing back a committed recording", () => {
    it("answers correction 1 with the SQL that was recorded for it, labelled as a replay of the recorded request", async () => {
        const recording = readTrace(traceFile(reports, "case-02"));
        const recordedAttempt = recording.attempts.find((attempt) => attempt.n === 1)!;
        const proposal = await replayProposer(reports, "case-02").propose(asked(1));
        expect(proposal.sql).toBe(recordedAttempt.sql);
        expect(proposal.replayedFrom).toBe(relative(process.cwd(), traceFile(reports, "case-02")));
        expect(proposal.model, "the model of the recorded request").toBe(recordedAttempt.proposal?.model);
        expect(proposal.usage, "the tokens of the recorded request").toEqual(recordedAttempt.proposal?.usage);
    });

    it("has nothing to say about a correction the recording does not have", async () => {
        const last = Math.max(...readTrace(traceFile(reports, "case-02")).attempts.map((attempt) => attempt.n));
        await expect(replayProposer(reports, "case-02").propose(asked(last + 1))).rejects.toThrow(new RegExp(`no correction ${last + 1} \\(it ends after ${last}\\)`));
    });
});

describe("a recording that cannot be replayed", () => {
    let dir: string;
    beforeAll(() => {
        dir = mkdtempSync(resolve(tmpdir(), "queryshift-replay-"));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("says when there is no recording of the case", async () => {
        await expect(replayProposer(dir, "case-02").propose(asked(1))).rejects.toThrow(/no recording of case-02 to replay/);
    });

    it("says when the recording has no such correction, and where it ends", async () => {
        writeFileSync(traceFile(dir, "case-02"), JSON.stringify({ caseId: "case-02", attempts: [{ n: 0, sql: "SELECT 1" }, { n: 1, sql: "SELECT 2" }] }));
        const proposer = replayProposer(dir, "case-02");
        await expect(proposer.propose(asked(1))).resolves.toMatchObject({ sql: "SELECT 2" });
        await expect(proposer.propose(asked(2))).rejects.toThrow(/no correction 2 \(it ends after 1\)/);
    });

    it("never hands out the rule engine's own attempt as if it were an answer", async () => {
        writeFileSync(traceFile(dir, "case-02"), JSON.stringify({ caseId: "case-02", attempts: [{ n: 0, sql: "SELECT 1" }] }));
        await expect(replayProposer(dir, "case-02").propose(asked(0))).rejects.toThrow(/no correction 0/);
    });

    it("refuses a file that is not a trace, or is the trace of another case", async () => {
        writeFileSync(traceFile(dir, "case-02"), "not json");
        await expect(replayProposer(dir, "case-02").propose(asked(1))).rejects.toThrow(/cannot be read as a trace/);
        writeFileSync(traceFile(dir, "case-02"), JSON.stringify({ hello: "world" }));
        await expect(replayProposer(dir, "case-02").propose(asked(1))).rejects.toThrow(/not a QueryShift loop trace/);
        writeFileSync(traceFile(dir, "case-02"), JSON.stringify({ caseId: "case-03", attempts: [] }));
        await expect(replayProposer(dir, "case-02").propose(asked(1))).rejects.toThrow(/recording of case-03, not case-02/);
    });
});
