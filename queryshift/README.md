# QueryShift harness

Proves, or refuses to prove, that a PostgreSQL translation of a legacy Oracle query returns the same thing. Contract: [docs/queryshift-contract.md](../docs/queryshift-contract.md). Plan: [docs/queryshift-plan.md](../docs/queryshift-plan.md).

```bash
npm install --prefix server && npm install
npm run queryshift                     # every case: each known candidate must be judged as its case says
npm run queryshift -- --loop           # rule engine -> mapping -> correction loop -> verified | needs_human_review
npm run queryshift -- --loop --proposer model --out queryshift/reports   # corrections from the model (OPENAI_API_KEY in server/.env), traces as JSON
npm run queryshift:check-model         # one request to the model in the real correction shape (needs OPENAI_API_KEY in server/.env)
npm run queryshift -- --engine         # what GoForge's rule engine makes of each legacy query (add --show-sql)
npm run queryshift -- --case queryshift/cases/case-01-outer-join-active-policies --candidate my_translation.sql
npm run queryshift -- --json
npx vitest run queryshift              # 160 tests
```

All data is synthetic. Nothing here connects to a database you own: the target is PostgreSQL 18 running inside the process (PGlite).

## Layout

- `domain/` the synthetic insurer: Oracle schema, PostgreSQL schema, column mapping, primary seed data (adversarial rows are marked) and `seed_heldout.sql`, held-out data with different rows and ids.
- `cases/case-NN-*/` `case.json` (purpose, risks, invariants, candidates), `legacy_query.sql`, `expected_result.csv`, `expected_heldout.csv`, `candidates/*.sql` (one correct, the rest known-wrong but executable; `catchBy` says which data must expose a wrong one: the primary data, or only the held-out data for a fitted one).
- `src/semantic.ts` static checks on a candidate (parsed with sqlparser, using the schema and the legacy query), `src/db-worker.mjs` the worker the database runs in.
- `src/compare.ts` the comparator (challenge defaults), `src/sql-guard.ts` one-SELECT guard, `src/database.ts` read-only execution, `src/case.ts` case loading, invariants and verdicts, `src/mapping.ts` legacy-name views from the mapping.

## The loop

`src/loop.ts`. Attempt 0 is the rule engine's conversion, renamed to the target tables from `schema_mapping.csv` (`src/mapping-apply.ts`; a lone renamed column keeps its legacy name as an alias, an ambiguous name is reported, never guessed). Each attempt goes through the guard, a read-only run, the comparison and the invariants. A failure becomes evidence (`src/diagnose.ts`: missing and unexpected rows, the columns in which they differ, broken invariants, or PostgreSQL's error) and a proposer is asked for a correction, at most `--max-corrections` (3) times. The server side of that request is `server/src/ai/correct-query.ts`, through the normal policy and audit layer.

It ends in `verified` (matched the reference result and every invariant, on this data) or `needs_human_review` with typed reasons: `no_proposer`, `budget_exhausted`, `stalled` (same query again), `hard_coded` (the query reproduces the evidence; not run), `guard_refused`, `proposer_failed`, `bind_parameters`. The proposer is shown row values, so run it only on synthetic or approved data.

## Static checks

`src/semantic.ts` reads each candidate's parsed text, with no data, and reports constructs that commonly differ between Oracle and PostgreSQL: `outer_join_filtered_in_where`, `count_star_over_outer_join`, `integer_division`, `null_in_concatenation`, `average_ignores_nulls`, `timestamp_vs_date_boundary`, `month_arithmetic_without_month_end_rule`, `interval_result` (from the result's column types), `fitted_to_a_literal`. Several only apply when the legacy query did something specific (a `(+)`, a TRUNC, an ADD_MONTHS), so a correct translation is not accused of a difference it does not have: every shipped correct candidate draws none, and each wrong one declares (`flags` in `case.json`) exactly the findings it draws. The findings go to the proposer next to the measured evidence, and are listed on every result. They are suspects, not proofs. One is blocking: `fitted_to_a_literal` (a comparison with a value the legacy query never contained); a query that passes every dataset and contains one is not verified (`static_finding`).

## Wall-clock limit

The database runs in a worker thread. PGlite ignores `statement_timeout`, so a query that runs longer than `--timeout-ms` (default 10 000) is stopped by terminating the worker; the candidate is reported as an error ("Stopped: ...", which the proposer is shown) and the next query runs on a fresh worker that replays the schema, seed and anything else set up. It applies to candidates and to the cases' own invariant queries. Memory is not limited.

## Held-out data

A model that is shown which rows are wrong can fix the query or fit it to those rows. `seed_heldout.sql` and each case's `expected_heldout.csv` are a second dataset on the same schema (different rows, no shared ids) with its own reference results, derived by hand separately. A query that passes the primary data is run on it. If it fails there it goes to a human (`fails_held_out`); it is never corrected against the held-out data, and nothing measured on it reaches a proposer (a test asserts no held-out value appears in anything a proposer was asked). Each case ships a query fitted to the primary data (`overfit_*.sql`) that passes it and fails only here. A `verified` result says whether it was also checked on held-out data.

## Verdicts

`pass` equivalent on the reference result and every invariant. `fail` ran, and something differs. `error` PostgreSQL rejected it. `refused` the guard did not let it run.

## Add a case

Copy a case folder, edit `case.json`, write the legacy query, **derive `expected_result.csv` from the seed by hand before looking at any translation**, then write one correct candidate and the translations a careless converter would write. The suite fails if the correct one does not pass or a wrong one does.

## Limits, measured

- The wall-clock limit stops a runaway query; it does not limit its memory.
- The static checks are heuristics over a parsed query: a query with no findings has not been shown to be right, and one with findings may be right.
- `verified` means it matched the primary data, the held-out data and the invariants. It is evidence, not a proof for all data: two small datasets can still miss a case. The references were derived by hand from documented Oracle behaviour by one author, and then checked against a real Oracle Database (below), which they matched; the data is still two small datasets.
- The model path is tested against a stand-in OpenAI, never against api.openai.com (no key was available): strict-schema acceptance and real model behaviour are unmeasured.
- The reference results were derived by hand, because the harness itself runs without Oracle. `npm run queryshift:oracle-check` removes the reading: it loads the same data into an Oracle schema (the legacy schema, the seed renamed through `domain/schema_mapping.csv`), runs each legacy query there and compares what Oracle returns with the reference using this harness's comparator. On 25 Oct 2026 against Oracle Database 23.26 Free (Docker image `gvenzl/oracle-free:23-slim-faststart`), 6 of 6 references (3 cases, primary and held-out data) were exactly what Oracle returns; the result is in `reports/oracle-check.json`. It needs Docker and `ORACLE_ADMIN_URL`, so it is not part of the default run. It checks the references against Oracle 23ai, not against an older release, and not the PostgreSQL translations (those are judged against the references by `npm run queryshift`).
- An invariant cannot prove equivalence, only disprove it; the comparator carries the proof.
