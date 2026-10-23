# QueryShift: where GoForge stands and the plan to the submission

Written 22 Oct 2026 from `QueryShift_Launch.md` and `starter-pack/` (README, `challenge_requirements.json`, the two templates, the validator and the retail example).

**Dates (IST):** use-case contract **Fri 23 Oct 11:00** · feature freeze **Mon 26 Oct 15:00** · submission **Mon 26 Oct 17:00** · demo **Tue 27 Oct**, 10 minutes.

**The bar:** modernize the query, preserve the meaning, *prove* the result. "Execution success is not semantic equivalence." A confidence score from the model that wrote the SQL is not proof. Proof is a deterministic result comparison, invariants or adversarial rows; when the system is unsure, a clearly explained human-review outcome earns credit and confident guessing does not.

## Status, 22 Oct night

Built: the contract draft ([queryshift-contract.md](queryshift-contract.md)), the synthetic insurer, three cases with a correct and several known-wrong translations each (three of them silent), a strict comparator, a one-SELECT guard, a read-only runner, invariants, 73 tests, and `npm run queryshift`. Measured baseline of GoForge's own rule engine on the three cases (`npm run queryshift -- --engine`): case 1 passes; case 2 fails (it warns about `||` with NULL and integer division but leaves both unfixed); case 3 errors (`TRUNC` is left unconverted, and the date-subtraction difference is not reported at all). Added later that night: the mismatch-driven loop (`--loop`) with a budget of 3 corrections and a typed `needs_human_review` outcome, a deterministic schema-mapping rename so the rule engine's output runs on the target tables, evidence with the differing columns, a check against queries that reproduce the evidence, and `server/src/ai/correct-query.ts` through the normal AI layer; 99 + 5 tests. Without a model today: case 1 verified, cases 2 and 3 need a human with evidence that names `open_ratio`/`contact_label` and the missing `TRUNC`. Then a held-out second dataset (own seed, hand-derived references, a fitted candidate per case that only it catches; a query that fails there goes to a human and the model never sees it); 120 harness tests, plus 5 for the server-side correction request. Then nine static checks on candidates (parsed, schema- and legacy-aware; one blocking) and a real wall-clock limit (the database now runs in a worker thread that is terminated on timeout, since PGlite ignores `statement_timeout`); 157 harness tests. Then, on the 22nd/23rd: a draft [SUBMISSION.md](../SUBMISSION.md) from the template, [the architecture diagram](queryshift-architecture.svg), generated evidence in `queryshift/reports/` (per-case loop traces with model usage, the 16-candidate report, test output), and a real-model run that verified all three cases. Run instructions checked from a fresh copy of the committable files (passed; not a real clone yet). Not built yet: the backup recording, the UI page, the organizers' model (if it differs).

## 1. Where we are (before tonight)

| Requirement | State | What exists / what is missing |
|---|---|---|
| Accept legacy SQL, schemas, mapping, target dialect | **Partial** | Legacy SQL and dialect (Oracle, SQL Server, MySQL, DB2) yes. Target schema from the open project or a connection. **No source schema, no schema mapping** (legacy names to target names, as in the pack's `schema_mapping.csv`). |
| Identify migration risks | **Partial** | Rule engine with named traps (Oracle `''` is NULL, `\|\|` with NULL, SUBSTR 0, GREATEST/LEAST, NULL sort order, integer division, case-sensitivity) plus PostgreSQL's own accept/reject. **Nothing that reads a candidate translation and says "this moved a predicate out of the outer join" or "this date arithmetic changed".** |
| Produce target SQL | **Done** | Rules, rules then AI, AI. 40+ rule families checked against a real PostgreSQL (`corpus`). |
| Deterministic validation | **Partial** | PostgreSQL accepts it (EXPLAIN, read-only), first 100 rows run read-only, and a paste-the-Oracle-output comparison. **Not automatic:** no stored expected result per case, no invariants, no adversarial data. The comparison defaults differ from the pack's (order ignored as a multiset, NULL equals NULL only, 6 decimal places). |
| Diagnose a mismatch | **Missing** | The model only ever sees PostgreSQL's *error text*. It never sees "27 customers are missing". |
| Bounded correction or human review | **Partial** | Two attempts, bounded, but only for syntax/semantic errors from PostgreSQL. **No mismatch-driven loop, no explicit "needs human review" outcome with its reasons.** |
| Explain outcome and remaining risk | **Partial** | Checks and Changes tabs; the model's own list of risks (which nothing verifies). No per-case report that points each claim at evidence. |
| 3+ non-trivial cases covering date/time, NULL/type/aggregation, join semantics, and **one silent failure** | **Missing** | No case set, no synthetic source and target schemas, no seed data, no executable-but-wrong translation to show detection. This is the main gap. |
| Safety: read-only, limits, bounded retries, unsupported input fails clearly | **Mostly done** | Read-only transaction, statement timeout, 100-row cap, retry cap of 2, audit log with exactly what was sent. **Missing:** an explicit guard for generated SQL (DDL, DML, `COPY ... PROGRAM`, `pg_read_file`, `dblink`, extension loading) with adversarial tests, and a written statement of the limits. |
| Evidence and submission | **Missing** | No use-case contract, `SUBMISSION.md`, per-case reports, redacted agent trace, architecture diagram, backup recording. |
| Judges can reproduce it | **Missing** | Needs Neon or a hand-started Docker Postgres today. Needs one command and synthetic data. |
| Model access | **Blocked** | `OPENAI_API_KEY` is empty. The pack says to use the organizers' endpoint and model, announced at launch; ours defaults to `gpt-5.6-luna`. |
| Disclose reused and pre-existing components | **Must do** | GoForge's first commit is 20 Aug; the Modernizer's first commits are 17 Oct and its rule engine's 20 Oct (all before the contract deadline). Everything built from here must be separable and the rest disclosed. |

Not on the judging path, and not to be spent on: accounts, Neon, cloud databases, diagram sync. They work, but the QueryShift bar does not score them.

## 2. The key missing things, in order

1. **A case harness with a deterministic baseline.** A case is a folder: legacy query, source schema, target schema, mapping, seed data, expected result (or invariants), business intent. One command runs the candidate translation read-only against the target and compares it as the pack does, with a report of missing and extra rows. This is the proof the whole challenge rests on.
2. **Three real cases and one silent failure,** on synthetic data with adversarial rows (NULLs, empty strings, boundary dates, duplicates, a customer with no orders).
3. **A mismatch-driven agent loop** (plan, act, measure, diagnose, correct or escalate) that feeds the *measured difference* back, stops after a fixed number of tries, and ends in pass or a human-review outcome with reasons. Every step is recorded in a trace.
4. **Semantic risk analysis of a candidate:** static checks for join semantics (an outer-join predicate that moved to WHERE and turned it into an inner join), date semantics (Oracle DATE has a time, date subtraction, TRUNC), and NULL/aggregation. Findings are deterministic and point at the text.
5. **A safety guard and adversarial tests** for generated SQL, and the limits written down.
6. **Evidence and submission:** per-case reports, redacted trace export, `SUBMISSION.md`, contract, architecture diagram, one-command judge run, backup recording.
7. **Model access:** the organizers' key, endpoint and model.

## 3. Plan

**Thu 22 Oct, tonight: the contract (due Fri 11:00).** Fill `USE_CASE_PROPOSAL_TEMPLATE.md`. Proposed: bank/insurance, Oracle to PostgreSQL, synthetic data, PostgreSQL 16 in Docker as the execution environment, no live Oracle (documented source behaviour and reference results stand in for it). Proposed cases:
- **Case 1, join + date (the silent failure):** customers with policies in a period, Oracle `(+)` with a date predicate on the outer table. The naive translation puts the predicate in WHERE, drops customers without a policy, still runs.
- **Case 2, NULL + aggregation + type:** claims totals with `NVL`, empty string versus NULL, `SUM` over NULLs, integer division, concatenation with NULL.
- **Case 3, date/time:** premium due dates with `ADD_MONTHS`, `MONTHS_BETWEEN`, `TRUNC(date)`, date minus date, a top-N with `ROWNUM` and ORDER BY.

**Fri 23 Oct: the harness.** Case folders and loader; synthetic Oracle-style source schema and PostgreSQL target schema with seed data; comparator with the pack's defaults (configurable, NULL equals NULL only by default); CLI `npm run queryshift -- cases/case-01` and an API route; the first case green and the silent failure caught. Submit the contract by 11:00.

**Sat 24 Oct: the loop and the analysis.** Mismatch-driven loop with a fixed budget and a human-review exit; trace per run; semantic checks for join/date/NULL; the safety guard with adversarial tests; cases 2 and 3.

**Sun 25 Oct: evidence and surface.** Per-case reports and trace export (redacted); a Case page in the existing Modernizer UI that shows pass, the diff, and the review outcome; docs; adversarial cases; one-command judge run; first backup recording.

**Mon 26 Oct: freeze 15:00, submit 17:00.** Bug fixes and documentation only after the freeze. `SUBMISSION.md`, architecture diagram, disclosure of reused components, final tag.

**Tue 27 Oct: demo, 10 minutes.** 1 min problem and value, 1 min architecture, 3 min a successful modernization, 2 min the silent failure and its recovery, 1 min evidence and safety, 2 min questions. Working flow first, slides last; bring the backup recording.

## 4. Decisions needed

1. **Domain:** is bank/insurance Oracle to PostgreSQL right for the contract?
2. **Model:** what endpoint, model and key did the organizers announce? Until then the AI modes stay off and the rules and the harness carry the demo.
3. **Pre-existing code:** confirm with the organizers that building on GoForge is fine, and agree where "event work" starts (this plan treats the Modernizer as pre-existing and everything under `cases/`, the harness, the loop and the analysis as new).
4. **Surface:** a CLI/API can score highly; the existing UI is a bonus. This plan builds the harness first and the UI page last.

## 5. Risks

- **No real Oracle.** The "expected result" is a reference we author from documented Oracle behaviour. Say so; it is allowed ("use synthetic data, documented source behavior, a reference result, invariants").
- **Rotate the Neon password** (it is in a chat) and keep `.env`, logs, screenshots and traces clear of secrets; the pack warns that all four leak.
- **Do not use `manicule` or `hirescout`** in anything shown or submitted if they hold real data: synthetic, public or approved data only.
- **Time:** the contract is due in hours and the freeze is three days away, so anything not on the list above waits.
