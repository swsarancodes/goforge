/**
 * Runs the correction loop with the model N times per case, each run in a folder of its own, so a run that fails never overwrites another
 * and `queryshift/reports` (the recorded evidence) is never written.
 *
 *   node server/node_modules/tsx/dist/cli.mjs queryshift/measure-model.ts --out <folder> [--runs 10] [--cases 02,03,05] [--parallel 3]
 *
 * Writes <folder>/case-02/run-01/case-02.loop.json (and .report.md), one run per folder, by running run.ts --loop --proposer model --case <dir> --out <that folder>.
 * Needs OPENAI_API_KEY in server/.env. The summary table is made from the traces by summarize-runs.ts; nothing here is counted from memory.
 * Synthetic data only is sent to the model (see SUBMISSION.md, Safety). Every call costs tokens: runs x cases x up to 3 corrections.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);

const here = import.meta.dirname;
const root = resolve(here, "..");
const out = option("out");
if (!out) {
    console.error("measure-model: --out <folder> is required (a folder of your own, not queryshift/reports).");
    process.exit(2);
}
if (resolve(out) === resolve(here, "reports")) {
    console.error("measure-model: --out is queryshift/reports, which holds the recorded evidence: a failed run would overwrite it. Use another folder.");
    process.exit(2);
}
const runs = Number(option("runs") ?? 10);
const parallel = Math.max(1, Number(option("parallel") ?? 1));
const wanted = (option("cases") ?? "02,03,05").split(",").map((part) => part.trim());
const caseDirs = wanted.map((number) => {
    const found = readdirSync(resolve(here, "cases")).find((name) => name.startsWith(`case-${number.padStart(2, "0")}-`));
    if (!found) throw new Error(`no case folder starts with case-${number}`);
    return resolve(here, "cases", found);
});

const tsx = resolve(root, "server/node_modules/tsx/dist/cli.mjs");

function runOne(caseDir: string, run: number): Promise<number> {
    const id = caseDir.split("/").pop()!.slice(0, 7);
    const folder = resolve(out!, id, `run-${String(run).padStart(2, "0")}`);
    if (existsSync(resolve(folder, `${id}.loop.json`))) {
        console.log(`${id} run ${run}: already there, kept`);
        return Promise.resolve(0);
    }
    return new Promise((done) => {
        const child = spawn(process.execPath, [tsx, resolve(here, "run.ts"), "--loop", "--proposer", "model", "--case", caseDir, "--out", folder], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
        let text = "";
        child.stdout.on("data", (chunk) => (text += chunk));
        child.stderr.on("data", (chunk) => (text += chunk));
        child.on("close", (code) => {
            const outcome = /VERIFIED|NEEDS HUMAN REVIEW/.exec(text)?.[0] ?? "no outcome (see below)";
            console.log(`${id} run ${run}: ${outcome}  -> ${relative(root, folder)}`);
            if (outcome.startsWith("no outcome")) console.log(text.split("\n").slice(-8).join("\n"));
            done(code ?? 1);
        });
    });
}

// one worker per case at a time when --parallel is more than 1: the runs of a case never share a folder, and PGlite is per process
const queue = caseDirs.flatMap((dir) => Array.from({ length: runs }, (_, index) => ({ dir, run: index + 1 })));
let next = 0;
await Promise.all(
    Array.from({ length: parallel }, async () => {
        while (next < queue.length) {
            const job = queue[next++];
            await runOne(job.dir, job.run);
        }
    }),
);
console.log(`\nDone. Summarize with: node server/node_modules/tsx/dist/cli.mjs queryshift/summarize-runs.ts ${relative(root, resolve(out))}`);
