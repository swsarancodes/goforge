/**
 * Runs the Modernizer's golden corpus through the script (batch) path, against a real PostgreSQL 16:
 *
 *   docker run -d --name goforge-corpus -e POSTGRES_PASSWORD=corpus -e POSTGRES_DB=corpus -p 54329:5432 postgres:16
 *   npm run test:batch
 *
 * Every corpus query is written into one script per source dialect, split by the same splitter a user's file goes through,
 * converted, and checked by PostgreSQL itself (EXPLAIN in a read-only transaction). The corpus already knows what each query must
 * do: convert and return the reference rows, report a behaviour trap, or report that something is not converted. The check is that
 * the statuses agree with that knowledge. A statement the corpus knows is not converted, or can return different rows, must never
 * end up as plain "converted"; a statement whose rows the corpus proved identical must never end up "failed".
 * Exit code 1 on any such disagreement.
 */
import { createRequire } from "node:module";
import { BATCH_STATUSES, BatchItem, BatchStatus, runBatch } from "../src/features/query-modernizer/batch";
import { checkPostgresSyntax } from "../src/features/query-modernizer/engine/checks";
import { CASES, type CorpusCase } from "../src/features/query-modernizer/engine/corpus/cases";
import { FIXTURE_SCHEMA, FIXTURE_SQL } from "../src/features/query-modernizer/engine/corpus/fixture";
import { LEGACY_DIALECTS, type LegacyDialect } from "../src/features/query-modernizer/types";
import { validateSql } from "../server/src/services/pg-validate";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const { Client } = require("pg") as typeof import("pg");
const URL_ = process.env.CORPUS_DATABASE_URL ?? "postgres://postgres:corpus@127.0.0.1:54329/corpus";

const rank: Record<BatchStatus, number> = { failed: 4, review: 3, "out-of-scope": 2, converted: 1, unchanged: 0 };
const worst = (items: BatchItem[]): BatchStatus => items.reduce((best, item) => (rank[item.status] > rank[best] ? item.status : best), "unchanged" as BatchStatus);

interface Verdict {
    c: CorpusCase;
    status: BatchStatus;
    items: BatchItem[];
}

async function main() {
    const client = new Client({ connectionString: URL_ });
    await client.connect();
    await client.query("SET TIME ZONE 'UTC'");
    await client.query(FIXTURE_SQL);

    // validateSql runs one statement per call; after a rejection the connection must leave the aborted transaction before the next one.
    const run = async <T,>(fn: (c: { query(text: string): Promise<unknown> }) => Promise<T>): Promise<T> => {
        try {
            return await fn(client as never);
        } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
        }
    };

    const verdicts: Verdict[] = [];
    const skipped: CorpusCase[] = [];
    let units = 0;
    let startedAt = performance.now();

    for (const dialect of LEGACY_DIALECTS.map((option) => option.value) as LegacyDialect[]) {
        for (const withSchema of [true, false]) {
            // cases that build their own tables first can't be checked by EXPLAIN against the fixture: they are left out and counted
            const cases = CASES.filter((c) => c.from === dialect && Boolean(c.schema) === withSchema && !c.setup);
            skipped.push(...CASES.filter((c) => c.from === dialect && Boolean(c.schema) === withSchema && c.setup));
            if (cases.length === 0) continue;

            const script = cases.map((c) => `-- @@case ${c.id}\n${c.sql.replace(/;\s*$/, "")}\n;\n`).join("\n");
            const result = await runBatch(
                { script, dialect, schema: withSchema ? FIXTURE_SCHEMA : undefined },
                { syntax: checkPostgresSyntax, validate: (sql) => validateSql(sql, run), connectionName: "corpus" },
                { concurrency: 1 },
            );
            units += result.items.length;

            // a case starts at its marker and runs until the next one
            const byCase = new Map<string, BatchItem[]>();
            let current: string | undefined;
            for (const item of result.items) {
                const marker = /@@case (\S+)/.exec(item.unit.comments)?.[1];
                if (marker) current = marker;
                if (current) byCase.set(current, [...(byCase.get(current) ?? []), item]);
            }
            for (const c of cases) {
                const items = byCase.get(c.id) ?? [];
                verdicts.push({ c, status: items.length > 0 ? worst(items) : "failed", items });
            }
        }
    }
    await client.end();
    const elapsed = performance.now() - startedAt;

    // ---- report -------------------------------------------------------------------------------------------------
    const families = new Map<string, Record<BatchStatus, number>>();
    for (const { c, status } of verdicts) {
        const row = families.get(c.family) ?? { converted: 0, unchanged: 0, review: 0, failed: 0, "out-of-scope": 0 };
        row[status]++;
        families.set(c.family, row);
    }
    console.log("\n" + "Family".padEnd(26) + BATCH_STATUSES.map((s) => s.padStart(14)).join(""));
    const total = { converted: 0, unchanged: 0, review: 0, failed: 0, "out-of-scope": 0 } as Record<BatchStatus, number>;
    for (const [family, row] of [...families.entries()].sort()) {
        console.log(family.padEnd(26) + BATCH_STATUSES.map((s) => String(row[s]).padStart(14)).join(""));
        for (const s of BATCH_STATUSES) total[s] += row[s];
    }
    console.log("TOTAL".padEnd(26) + BATCH_STATUSES.map((s) => String(total[s]).padStart(14)).join(""));
    console.log(`\n${verdicts.length} corpus queries in ${units} statements, converted as scripts and checked by PostgreSQL in ${(elapsed / 1000).toFixed(1)} s (${skipped.length} that need their own setup tables were left out).`);

    // ---- the agreement with what the corpus knows -------------------------------------------------------------------
    const violations: string[] = [];
    const plain = (items: BatchItem[]) => items.every((item) => item.status === "converted" || item.status === "unchanged");
    for (const { c, status, items } of verdicts) {
        const trapsThatChangeResults = (c.trap ? [c.trap] : []).concat(c.traps ?? []).filter((id) => items.some((item) => item.outcome?.engine.traps.some((trap) => trap.id === id && trap.severity === "changes-results")));
        if (c.unconverted && plain(items)) violations.push(`SILENT   ${c.id}: the corpus knows something is not converted, the script path says "${status}"\n         ${c.sql.replace(/\s+/g, " ")}`);
        else if (trapsThatChangeResults.length > 0 && plain(items)) violations.push(`SILENT   ${c.id}: can return different rows (${trapsThatChangeResults.join(", ")}), the script path says "${status}"`);
        else if (!c.unconverted && !c.trap && !(c.traps?.length) && c.reference !== undefined && status === "failed") violations.push(`WRONG    ${c.id}: rows proven identical by the corpus, the script path says "failed": ${items.flatMap((item) => item.reasons).join(" | ").slice(0, 300)}\n         ${c.sql.replace(/\s+/g, " ")}`);
    }
    const unexpectedReview = verdicts.filter(({ c, status }) => status === "review" && !c.trap && !c.traps?.length && !c.unconverted && c.reference !== undefined);
    if (unexpectedReview.length > 0) {
        console.log(`\n${unexpectedReview.length} statement(s) the corpus proved correct are marked "needs review" (not a disagreement, listed for reading):`);
        for (const { c, items } of unexpectedReview.slice(0, 15)) console.log(`  ${c.id}: ${items.flatMap((item) => item.reasons).join(" | ").slice(0, 200)}`);
    }
    console.log(`\ndisagreements with the corpus: ${violations.length}`);
    for (const violation of violations) console.log(`  ${violation}`);
    process.exit(violations.length > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error(error);
    process.exit(2);
});
