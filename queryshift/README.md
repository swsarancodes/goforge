# QueryShift harness

Proves, or refuses to prove, that a PostgreSQL translation of a legacy Oracle query returns the same thing. Contract: [docs/queryshift-contract.md](../docs/queryshift-contract.md). Plan: [docs/queryshift-plan.md](../docs/queryshift-plan.md). Submission: [SUBMISSION.md](../SUBMISSION.md). Demo script: [docs/queryshift-demo.md](../docs/queryshift-demo.md).

```bash
npm install --prefix server && npm install
npm run queryshift                     # every case: each known candidate must be judged as its case says
npm run queryshift -- --loop           # rule engine -> mapping -> correction loop -> verified | needs_human_review
npm run queryshift -- --loop --proposer model --out queryshift/reports   # corrections from the model (OPENAI_API_KEY in server/.env); writes <case>.loop.json and <case>.report.md
npm run queryshift -- --loop --proposer replay    # corrections played back from queryshift/reports: no model, no key, every query judged again
npm run queryshift -- --report-from queryshift/reports   # write <case>.report.md from traces already on disk (runs nothing)
npm run queryshift:check-model         # one request to the model in the real correction shape (needs OPENAI_API_KEY in server/.env)
npm run queryshift -- --engine         # what GoForge's rule engine makes of each legacy query (add --show-sql)
npm run queryshift -- --case queryshift/cases/case-01-outer-join-active-policies --candidate my_translation.sql
npm run queryshift -- --json
npx vitest run queryshift              # 234 tests
node server/node_modules/tsx/dist/cli.mjs queryshift/measure-model.ts --out <folder> --runs 10   # the model loop N times per case, one folder per run (never queryshift/reports)
node server/node_modules/tsx/dist/cli.mjs queryshift/summarize-runs.ts <folder>                   # one table per case, counted from the saved traces
```

All data is synthetic. Nothing here connects to a database you own: the target is PostgreSQL 18 running inside the process (PGlite).

Install with `npm install`, not `npm ci`: the root `package-lock.json` is behind `package.json` (the repository's CI installs from `bun.lock`), so `npm ci` stops on a mismatch.

## Layout

- `domain/` the synthetic insurer: Oracle schema, PostgreSQL schema, column mapping, primary seed data (adversarial rows are marked) and `seed_heldout.sql`, held-out data with different rows and ids.
- `cases/case-NN-*/` `case.json` (see "Case files"), `legacy_query.sql`, `expected_result.csv`, `expected_heldout.csv`, `candidates/*.sql` (one correct, the rest known-wrong but executable; `catchBy` says which data must expose a wrong one: the primary data, or only the held-out data for a fitted one).
- `reports/` what runs leave behind and the submission cites: `<case>.loop.json` (trace), `<case>.report.md` (validation report), `known-candidates.json`, `oracle-check.json`, `test-output.txt`.
- `measurements/<date>/case-NN/run-NN/` the traces and reports of a repeated model run (`measure-model.ts`), kept apart from `reports/` so a failed run can never overwrite the recordings; `summarize-runs.ts` makes the table in SUBMISSION.md from them.
- `src/semantic.ts` static checks on a candidate (parsed with sqlparser, using the schema and the legacy query), `src/db-worker.mjs` the worker the database runs in.
- `src/compare.ts` the comparator (challenge defaults), `src/sql-guard.ts` one-SELECT guard, `src/database.ts` read-only execution, `src/case.ts` case loading, invariants and verdicts, `src/binds.ts` bind variables, `src/mapping.ts` legacy-name views from the mapping.
- `src/loop.ts` the correction loop, `src/diagnose.ts` evidence, `src/model-proposer.ts` the model as a proposer, `src/replay-proposer.ts` a recorded run as a proposer, `src/report.ts` the Markdown validation report.

## Case files

`case.json` fields, beyond the obvious (`id`, `title`, `businessPurpose`, `difficulty`, `risks`, `invariants`, `candidates`):

- `legacyDialect` must be `"oracle"`. Any other value is refused when the case is loaded, with an explanation: the static checks and the reference results describe Oracle's behaviour, so a `verified` for another dialect would claim more than was checked. (The rule engine itself converts SQL Server, MySQL and DB2; nothing here proves those.)
- `orderSensitive` compares row order, not only the set of rows. Set it when the legacy query ends in a total `ORDER BY`; leave it off when it does not, because PostgreSQL promises no order then and one run cannot prove one. The suite requires it for every case whose legacy query sorts its result, and an order-sensitive case needs a candidate whose only fault is the order (`candidates/reversed_order.sql` in each shipped case).
- A case whose legacy query has a bind variable it gives no value for is one the harness must hand to a person (`case-04`). It has `"candidates": []`, no held-out result, and an `expected_result.csv` of column names only: no reference result belongs to a value nobody chose, so the file is a placeholder and `businessPurpose` says why a person must decide. The loop ends in `needs_human_review` with `bind_parameters` and calls no model; `--engine` says `NEEDS A PERSON` for it instead of judging the rule engine's query. The suite reads this from the query (an undeclared bind variable), not from a flag, so declaring a case "escalating" cannot excuse it from being judged.
- `bindValues` gives the values of the legacy query's bind variables, `{ "cutoff": { "type": "date", "value": "2026-01-01" } }`, with names written without the colon and a type of `date` (YYYY-MM-DD), `number` or `string`. They are written into the legacy query as Oracle literals (`TO_DATE('2026-01-01', 'YYYY-MM-DD')`, a number, a quoted string) before the rule engine, the static checks or a model see it, so the reference result belongs to known values. A declared name the query never uses is an error. A bind variable the case does not declare sends the case to a human (`bind_parameters`) and no model is asked. The `invariants` SQL is plain PostgreSQL and takes no bind variables: if you change a value, change the matching literal there.

## The loop

`src/loop.ts`. Attempt 0 is the rule engine's conversion, renamed to the target tables from `schema_mapping.csv` (`src/mapping-apply.ts`; a lone renamed column keeps its legacy name as an alias, an ambiguous name is reported, never guessed). Each attempt goes through the guard, a read-only run, the comparison and the invariants. A failure becomes evidence (`src/diagnose.ts`: missing and unexpected rows, the columns in which they differ, broken invariants, or PostgreSQL's error) and a proposer is asked for a correction, at most `--max-corrections` (3) times. The proposer is `--proposer none` (nobody: the default), `model` (the server side of that request is `server/src/ai/correct-query.ts`, through the normal policy and audit layer) or `replay` (a recorded run, below).

It ends in `verified` (matched the reference result and every invariant, on the primary and, where the case has it, the held-out data) or `needs_human_review` with typed reasons: `no_proposer`, `budget_exhausted`, `stalled` (same query again), `hard_coded` (the query reproduces the evidence; not run), `guard_refused`, `proposer_failed`, `bind_parameters`, `fails_held_out` (passed the primary data, failed the held-out data), `static_finding` (matched every dataset but carries a blocking static finding). The model is shown row values, so run it only on synthetic or approved data.

## Traces, replay and reports

`--out <dir>` writes, per case, two files:

- `<case>.loop.json`, the trace: every attempt with its SQL, verdict, evidence, static findings and held-out result, and for a model attempt the model, tokens, latency and the exact prompt (instructions, input, SHA-256) taken from the AI layer's audit log.
- `<case>.report.md`, the validation report, built from the trace and the case and not from anything the model said about itself: what the query is for, what looked risky, every attempt with its measured evidence, the decision and what a reviewer should still read. It has no dates and no local paths, so the same trace gives the same report. The model's own explanation appears labelled as its own and unverified; the exact prompt is in a collapsible block.

`--report-from <dir>` writes the reports of traces already on disk and runs nothing.

`--proposer replay` plays back the corrections recorded in `--replay-from <dir>` (default `queryshift/reports`): correction n gets the SQL recorded as attempt n. No model is called. Everything after that is live: the recorded query goes through the guard, runs on both datasets and is compared like any other, so a recording the current checks no longer accept ends in `needs_human_review`. A replayed attempt is labelled as one in the trace (`source: "replay"`, `replayedFrom`), the report and the console (`replay of the recorded gpt-5.6-luna, not a live call`). It shows that the checks accept what a model once answered, not that a model answers that way today. `--out` may not be the folder being replayed.

The traces committed in `reports/` are the real-model run of 22 Oct 2026, which predates prompt capture: they carry the audit-log id of each request but not the prompt, because that log lived in memory. A new `--proposer model --out` run records the prompt. A failed model run overwrites the recording of that case with its own outcome (for instance `proposer_failed`), so use another `--out` folder unless you mean to re-record. Traces and prompts hold synthetic values only and never the key.

## Static checks

`src/semantic.ts` reads each candidate's parsed text, with no data, and reports constructs that commonly differ between Oracle and PostgreSQL: `outer_join_filtered_in_where`, `count_star_over_outer_join`, `integer_division`, `null_in_concatenation`, `average_ignores_nulls`, `timestamp_vs_date_boundary`, `month_arithmetic_without_month_end_rule`, `interval_result` (from the result's column types), `fitted_to_a_literal`. Several only apply when the legacy query did something specific (a `(+)`, a TRUNC, an ADD_MONTHS), so a correct translation is not accused of a difference it does not have: every shipped correct candidate draws none, and each wrong one declares (`flags` in `case.json`) exactly the findings it draws. The findings go to the proposer next to the measured evidence, and are listed on every result. They are suspects, not proofs. One is blocking: `fitted_to_a_literal` (a comparison with a value the legacy query never contained); a query that passes every dataset and contains one is not verified (`static_finding`).

## Wall-clock limit

The database runs in a worker thread. PGlite ignores `statement_timeout`, so a query that runs longer than `--timeout-ms` (default 10 000) is stopped by terminating the worker; the candidate is reported as an error ("Stopped: ...", which the proposer is shown) and the next query runs on a fresh worker that replays the schema, seed and anything else set up. It applies to candidates and to the cases' own invariant queries. Memory is not limited.

## Held-out data

A model that is shown which rows are wrong can fix the query or fit it to those rows. `seed_heldout.sql` and each case's `expected_heldout.csv` are a second dataset on the same schema (different rows, no shared ids) with its own reference results, derived by hand separately. A query that passes the primary data is run on it. If it fails there it goes to a human (`fails_held_out`); it is never corrected against the held-out data, and nothing measured on it reaches a proposer (a test asserts no held-out value appears in anything a proposer was asked, nor in the prompt a trace keeps). Each case ships a query fitted to the primary data (`overfit_*.sql`) that passes it and fails only here. A `verified` result says whether it was also checked on held-out data.

## Verdicts

`pass` equivalent on the reference result and every invariant. `fail` ran, and something differs. `error` PostgreSQL rejected it. `refused` the guard did not let it run.

## Add a case

Copy a case folder, edit `case.json`, write the legacy query, **derive `expected_result.csv` from the seed by hand before looking at any translation**, then write one correct candidate and the translations a careless converter would write. If the legacy query ends in a total `ORDER BY`, set `orderSensitive` and add a `reversed_order.sql` candidate; if it has bind variables, declare their values. The suite fails if the correct one does not pass or a wrong one does.

## Limits, measured

- The wall-clock limit stops a runaway query; it does not limit its memory.
- The static checks are heuristics over a parsed query: a query with no findings has not been shown to be right, and one with findings may be right.
- `verified` means it matched the primary data, the held-out data and the invariants. It is evidence, not a proof for all data: two small datasets can still miss a case. The references were derived by hand from documented Oracle behaviour by one author, and then checked against a real Oracle Database (below), which they matched; the data is still two small datasets.
- Row order is compared only where the case says so. All four judged cases do, and each legacy query has a total `ORDER BY`.
- The model path has run against api.openai.com twice: once on 22 Oct 2026 (`gpt-5.6-luna`, the three first cases, traces in `reports/`), and on 26 Oct 2026 ten times on each of cases 2, 3 and 5, 30 of 30 verified (traces in `measurements/2026-10-26/`, table in SUBMISSION.md). Cases 1 and 4 never reach the model. Ten runs of one model on four small cases show the path works; with 10 of 10, the 95% lower bound on the success rate is about 69%, so it is not a rate. The tests use a stand-in provider, so they check the plumbing and not the model. A replay is not a new measurement.
- The reference results were derived by hand, because the harness itself runs without Oracle. `npm run queryshift:oracle-check` removes the reading: it loads the same data into an Oracle schema (the legacy schema, the seed renamed through `domain/schema_mapping.csv`), runs each legacy query there and compares what Oracle returns with the reference using this harness's comparator. On 25 Oct 2026, and again on 26 Oct 2026 after the row-order and bind-value changes, against Oracle Database 23.26 Free (Docker image `gvenzl/oracle-free:23-slim-faststart`), all references were exactly what Oracle returns (6 of 6 for cases 1 to 3; 8 of 8 on 26 Oct 2026 once case 5 was added; case 4 has no reference); the result is in `reports/oracle-check.json`. It needs Docker and `ORACLE_ADMIN_URL`, so it is not part of the default run. It checks the references against Oracle 23ai, not against an older release, and not the PostgreSQL translations (those are judged against the references by `npm run queryshift`).
- An invariant cannot prove equivalence, only disprove it; the comparator carries the proof.
