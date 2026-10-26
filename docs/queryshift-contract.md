# QueryShift use-case contract

Submit by **Friday 23 Oct 2026, 11:00 IST**. Fields marked **TO FILL** are the team's to complete; everything else describes what is in this repository today.

## Team

- Team name: **TO FILL**
- Members and roles: **TO FILL**
- Repository: https://github.com/swsarancodes/goforge (the project directory is `goforge`; the QueryShift work is under `queryshift/` and `docs/queryshift-*.md`)

## Business problem

- Domain: retail insurance (policies, customers, claims, premium schedules).
- Intended user: a data engineer migrating reporting queries from an Oracle warehouse to PostgreSQL, and the reviewer who signs the result off.
- Current modernization pain: legacy reporting SQL uses Oracle-only constructs (`(+)` joins, `NVL`, `ADD_MONTHS`, `TRUNC`, `ROWNUM`, `''` is NULL, DATE with time) whose PostgreSQL look-alikes run without error and return different answers. A query that executes is treated as converted.
- Business impact: renewal outreach lists, claims reporting and leadership numbers that are quietly wrong after migration, found by a customer or an auditor rather than before cut-over.

## Technical scope

- Source platform and dialect: Oracle (SQL, PL/SQL not in scope). No live Oracle is available to the team; see Validation plan.
- Target platform and dialect: PostgreSQL.
- Input format: a legacy SQL query (one SELECT), the source schema (`legacy_schema.sql`), the target schema (`target_schema.sql`), a column-level mapping (`schema_mapping.csv`), seed data, and the business purpose.
- Output format: a PostgreSQL SELECT, a per-attempt verdict (`pass`, `fail`, `error`, `refused`), a loop outcome (`verified` or `needs_human_review` with reasons), and a JSON trace of every attempt with its evidence.
- Execution environment: PostgreSQL 18 running in-process (PGlite, the PostgreSQL server compiled to WebAssembly). No Docker or server is needed to reproduce a run: `npm install --prefix server && npm install && npm run queryshift`. Every candidate runs after a guard that allows one SELECT only, in a `READ ONLY` transaction that is always rolled back, inside a worker thread that is terminated if the query runs longer than 10 s (configurable, `--timeout-ms`).
- Model provider and model: OpenAI Responses API, model `gpt-5.6-luna` by default, through GoForge's existing policy/redaction/audit layer. **To be replaced by the organizers' endpoint and key once announced.** Until then the deterministic parts below do not depend on a model.

## Schemas and data

- Source schema: `queryshift/domain/legacy_schema.sql` (Oracle: `CUST_MST`, `POLCY_HDR`, `CLM_DTL`).
- Target schema: `queryshift/domain/target_schema.sql` (PostgreSQL: `customers`, `policies`, `claims`).
- Schema-mapping approach: `queryshift/domain/schema_mapping.csv`, one row per column, with a note where the type or NULL semantics change (`DATE` with time to `timestamp(0)`, `''` to NULL at load).
- Data source: written by hand for this challenge. Primary data `queryshift/domain/seed_target.sql`: 7 customers, 9 policies, 11 claims, with rows marked ADVERSARIAL. Held-out data `queryshift/domain/seed_heldout.sql`: a second dataset on the same schema with different rows and no shared ids (8 customers, 8 policies, 10 claims).
- Confirmation that data is synthetic, public, or approved: **Synthetic.** All names, emails and amounts are invented. No customer, production or employer data was used, and none of the team's real databases is touched by the harness.

## Query cases

| Case | Business purpose | Difficulty | Main semantic risks | Expected behavior or invariant |
|---|---|---|---|---|
| 1 | Every customer with the count and premium of their active policies that started in 2026, including customers with none | Medium | Oracle `(+)` outer join with predicates on the outer table; `COUNT(col)` vs `COUNT(*)`; `NVL` in `SUM` | 7 rows (one per customer); customers 5, 6, 7 appear with 0; policy count and premium are conserved against the base table |
| 2 | Per customer: contact label, claim count, amount claimed, average paid (unpaid = 0), share still open | Hard | `\|\|` with NULL (Oracle: empty; PostgreSQL: NULL); `COUNT/COUNT` integer division; `AVG(NVL(x,0))`; null-extended rows in aggregates | 6 rows; customer 2's label is `Brightline Logistics <>`; ratios are fractions; claim count and claimed amount are conserved |
| 3 | Five largest March 2026 claims with claim day, days since policy start, and six-month review date | Hard | `TRUNC(date)` on a value with time; `BETWEEN` on a timestamp; date minus date is a number of days; `ADD_MONTHS` month-end rule; `ROWNUM` after an inner `ORDER BY` | Claims 9007, 9008, 9003, 9002, 9004 in that order; claim 9002 (31 March, 16:45) is included; policy 103 reviews on 31 Aug, not 28 Aug |

## Required risk coverage

- Date or time semantics: case 3 (`TRUNC`, time of day, `BETWEEN`, date subtraction, `ADD_MONTHS`).
- NULL, type, or aggregation semantics: case 2 (`||` with NULL, integer division, `AVG(NVL)`, `COUNT(*)` vs `COUNT(col)`) and case 1 (`NVL` in `SUM`).
- Join semantics: case 1 (outer-join predicates in `ON`, not `WHERE`).
- Silent executable failure: one per case, each a translation that runs and returns plausible rows: case 1 `silent_where_filter.sql` (3 customers vanish), case 2 `silent_concat_null.sql` (one label becomes NULL), case 3 `silent_between_without_trunc.sql` (claim 9002 is replaced by a smaller claim). These are checked in as candidates and the test suite fails if the harness ever accepts one.

## Validation plan

- Authoritative baseline: an expected result per case (`expected_result.csv`) **derived by hand from documented Oracle behaviour** applied to the seed data, because no Oracle instance is available. It is then cross-checked independently: the correct PostgreSQL translation, written separately, must reproduce it exactly (it does for all three cases), and each known-wrong translation must not. Where a person with Oracle access exists, the reference file is replaced by a real export and nothing else changes.
- Result-comparison method: the challenge defaults (row order ignored unless a case says otherwise, duplicates kept as a multiset, NULL equals NULL only, numbers rounded to 6 decimals), compared as PostgreSQL's column types. Stricter than the starter pack in one place: a timestamp keeps its time of day.
- Held-out data: every case also has a reference result for the held-out dataset (`expected_heldout.csv`), derived by hand separately. A query that passes the primary data is run on it too; nothing measured on it is ever shown to a model, so a query that was fitted to the evidence fails there and goes to a human. Each case ships a translation that passes the primary data and is stopped only by the held-out data.
- Static checks: nine deterministic checks read the parsed candidate (not data) with the legacy query and the target schema's types and nullability: an outer-joined table filtered in WHERE, COUNT(*) over an outer join, integer division, `||` with a nullable column, AVG without the NULL substitution the legacy query had, a timestamp compared with a DATE after TRUNC, month arithmetic without Oracle's month-end rule, an interval result column, and a comparison with a value the legacy query never contained. They are suspects, not proof: they are shown to the model beside the measured evidence and listed for the reviewer on every outcome. Only the last is blocking: a query that matches every dataset but contains such a comparison is not verified. Every shipped candidate declares exactly which findings it draws (and the correct translations draw none).
- Invariants: independent SQL against the base tables (row count, conserved sums), run on every candidate.
- Adversarial test rows: in the seed (boundary dates and times, last day of month, NULL email, NULL premium, NULL paid amount, a customer with no policy, a lapsed policy, two claims with equal amount and time).
- Failure and escalation behavior: PostgreSQL rejection is reported as `error`; a statement the guard refuses is `refused` and never run; a mismatch is `fail` with the missing and unexpected rows. A result cut off at the row limit never passes. The loop (`npm run queryshift -- --loop`) ends in exactly one of `verified` or `needs_human_review`, with typed reasons and a full trace of every attempt.

## Agentic workflow

- Model-assisted decisions: read a measured mismatch (which rows are missing or unexpected, in which columns they differ, which invariants broke) or PostgreSQL's error, and propose a corrected query with an explanation and its own stated risks. The model never decides that a query is correct, and is never asked to.
- Deterministic tools: the GoForge rule engine (Oracle syntax conversion and behaviour traps; attempt 0), the schema-mapping rename, the SQL guard, read-only execution with a wall-clock limit, the comparator, the invariants, the static checks, the evidence builder, a check that a proposal does not reproduce the evidence.
- Maximum correction attempts: **3** after the rule engine's attempt (configurable with `--max-corrections`), then escalate.
- Human-review trigger (each is a typed reason in the result): the budget is used up; no model is configured; the model call fails or returns an invalid answer; the model returns a query that was already tried; the model's query reproduces the evidence (reads no table, VALUES list, three or more copied literals) and is not run; a query that passes the primary data and fails the held-out data; a query that matches the data but contains a comparison with a value the legacy query never had; the guard refuses the model's query; the legacy query has bind variables. The rule engine's warnings are listed for the reviewer on every outcome, `verified` included.

## Scope boundaries

- Included: single SELECT statements from Oracle to PostgreSQL over the three-table insurance schema; deterministic comparison against a reference result; read-only execution.
- Explicitly excluded: DML, DDL, PL/SQL, stored procedures; live Oracle connectivity; production or customer data; performance tuning of the converted query; data migration itself.
- Known platform limitations: the PGlite engine does not enforce `statement_timeout` (measured: a 27 s query ran past a 300 ms limit), so the limit is enforced from outside by terminating the worker thread that runs the query (measured: a runaway query is stopped at the limit, and the next query runs on a fresh worker with the same data); memory use of a runaway query is not limited; the data is tiny by design. The static checks are heuristics over a parsed query and are not complete. Result ordering without a total `ORDER BY` is not provable from one run. The expected results are authored from documented Oracle behaviour, not exported from Oracle.

## Pre-existing components (disclosure)

The GoForge application (diagram studio, SQL editor, Query Modernizer rule engine with its corpus, AI provider/policy/audit layer, accounts) existed before the event; its first commit is from August 2026 and the Query Modernizer's from 17 October 2026 (its rule engine from 20 October 2026) (all before the contract deadline). The event work is `queryshift/` (domain, cases, comparator, guard, runner, tests) and `docs/queryshift-*.md`; the harness only calls the rule engine (`convertQuery`), it does not change it.

## Friday checkpoint

The smallest end-to-end flow, working now: `npm run queryshift -- --loop` converts each legacy query with the rule engine, renames it to the target tables from the mapping, runs it read-only, and either verifies it or ends in `needs_human_review` with the measured evidence (a query is verified only if it also matches on the held-out data) (today, without a model: case 1 verified on both datasets; cases 2 and 3 need a human, and the evidence points at the exact columns and constructs). With a model configured the corrections run through GoForge's AI layer. And `npm run queryshift` loads the synthetic insurance database, runs every known candidate for the three cases read-only, and prints a verdict per candidate with the missing and unexpected rows and the broken invariants; the correct translation of each case passes and every silent failure is caught. `npm run queryshift -- --engine` judges GoForge's own rule engine the same way (today: case 1 passes, case 2 fails, case 3 errors), which is the baseline the agent loop has to improve.

## Changes after the contract (25 Oct 2026)

Made while hardening the proof. None widens the scope above; the text above is left as it was written.

- **Row order is compared in all three cases** (`orderSensitive`; each legacy query ends in a total `ORDER BY`), and every case has a candidate that returns the right rows in the wrong order and must fail. The comparison method above is unchanged: order is ignored unless a case says otherwise.
- **Bind variables.** A case may declare the values its reference result was produced with (`bindValues`); they are written into the legacy query before anything reads it, and case 1 now uses `:cutoff` that way. A legacy query with a bind variable the case gives no value for still goes to human review (`bind_parameters`), and no model is asked.
- **Source dialect.** A case that names a source dialect other than Oracle is refused when it is loaded: the static checks and the reference results only cover Oracle.
- **Evidence.** Traces keep the exact prompt that was sent to the model; recorded corrections can be played back offline, labelled as a replay (`--proposer replay`); each case gets a Markdown validation report.

## Organizer decision

- Status: Pending
- Organizer:
- Date:
- Required changes:
