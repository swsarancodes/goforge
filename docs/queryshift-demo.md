# QueryShift demo runbook (10 minutes)

Every command below was run for this document on 25 Oct 2026 from a clone of `main` (Node 24, macOS). The outputs quoted are the real ones. Nothing here needs a database server: the target is PostgreSQL running in the process. The only things that need more are the model (a key in `server/.env`) and, for one optional step, Docker.

## Before you start (2 minutes, not on the clock)

```bash
git clone https://github.com/swsarancodes/goforge && cd goforge
npm install && npm install --prefix server
npm run queryshift            # exits 0: "Every candidate was judged as its case says"
```

- Model key in `server/.env` (`OPENAI_API_KEY=...`), then `npm run queryshift:check-model` should answer. If the organizers' endpoint or model differs, set `OPENAI_BASE_URL` / `OPENAI_MODEL` and say so in the demo.
- Open `docs/queryshift-architecture.svg` and `queryshift/cases/case-01-outer-join-active-policies/legacy_query.sql` in two tabs.
- Optional (step 5): `docker start goforge-oracle-dev` or `docker run -d --name goforge-oracle -p 127.0.0.1:1521:1521 -e ORACLE_PASSWORD=choose-one gvenzl/oracle-free:23-slim-faststart` and wait about a minute.
- If the model or the network fails on the day, everything except step 4b still runs, and `queryshift/reports/*.loop.json` holds the traces of the real-model run.

## 1. The problem and why it matters (1 minute)

Show `legacy_query.sql` of case 1 (an Oracle `(+)` outer join with a date test on the outer table). Say: the translation that merely *runs* is the dangerous one. Moving the date test from the join into `WHERE` still executes, and silently drops every customer without a recent policy: **7 customers expected, 4 returned.** "The expensive bug is not the query that fails. It is the query that succeeds and gives the wrong number."

## 2. Architecture (1 minute)

Show the diagram. Say: legacy SQL and a column mapping go in; GoForge's rule engine converts what it can and reports what it cannot; every candidate runs **read-only** in PostgreSQL itself (PGlite) under a wall-clock limit; the answer is compared with a reference result by a deterministic comparator (multiset, NULL equals only NULL, numbers to 6 decimals, timestamps keep their time of day); nine static checks read the SQL for known traps; a bounded loop (at most 3 corrections) feeds the *measured difference* back to a model, and ends in `verified` or `needs_human_review`. The model proposes; nothing it says counts as proof.

## 3. A successful modernization (3 minutes)

```bash
npm run queryshift -- --engine --show-sql      # what the rule engine alone makes of each legacy query
```

For case 1 it prints the converted query and `PASS    rule engine: Matches the reference result and all 3 invariant(s) hold.` The `(+)` join became a `LEFT JOIN` with the date and status tests **in the `ON` clause**, `NVL` became `COALESCE`. Point at the three invariants (one row per customer, policy count conserved, premium conserved): they are separate SQL written independently of the translation.

```bash
npm run queryshift -- --loop                   # no model: the rule engine, mapping, measurement
```

Case 1: `VERIFIED (primary and held-out data)`. Say what held-out means: a second dataset with its own reference that no model ever sees evidence from, so a query fitted to the visible rows fails there.

## 4. The silent failure and the recovery (2 minutes)

**a. The failure.**

```bash
npm run queryshift -- --case queryshift/cases/case-01-outer-join-active-policies \
  --candidate queryshift/cases/case-01-outer-join-active-policies/candidates/silent_where_filter.sql
```

Output: `FAIL primary data: 3 expected row(s) missing ... Invariant broken: one row per customer (4 row(s) returned, 7 expected)`, with the missing rows listed (`Eli Park`, `Farah Khan`, `Gita Nair`). It executed without error. Only the comparison and the invariant caught it.

**b. The recovery, with the model** (the same loop on all three cases, 22 s on the author's machine):

```bash
npm run queryshift -- --loop --proposer model
```

Last real run: case 1 verified at attempt 0; **case 2** (NULL in `||`, integer division) and **case 3** (`TRUNC` on a date, month-end arithmetic) fail at attempt 0 (a wrong result and a PostgreSQL error), the model is shown the *measured* difference, and attempt 1 passes on both datasets: `Every case was verified.` Without a model the same command ends `NEEDS HUMAN REVIEW` with `[no_proposer]` and exits 1, which is the other half of the story: it never claims what it cannot prove.

## 5. Evidence, safety and limits (1 minute)

- `queryshift/reports/*.loop.json`: every attempt with its SQL, verdict, evidence, static findings, held-out result and model usage. Synthetic values only.
- `SUBMISSION.md`: the claims, each pointing at evidence, and what was **not** demonstrated.
- Safety, in one breath: one `SELECT` only (a guard), read-only execution, a wall-clock limit that terminates a runaway query, at most 3 corrections, synthetic data only, the key never leaves `server/.env`.
- **Optional, 30 seconds, if Oracle is running:** `ORACLE_ADMIN_URL=oracle://system:<password>@127.0.0.1:1521/FREEPDB1 npm run queryshift:oracle-check`. It runs the three legacy queries on a **real Oracle Database** with the same data and compares with the references: `6 of 6 references confirmed by Oracle 23.26.3.0.0; disagreements: 0`. The references were first written by hand; this is what takes the single author's reading of Oracle out of the proof.

## 6. Questions (2 minutes): honest answers

- *Is the reference result proof?* It is the agreed baseline, derived by hand and then confirmed against Oracle Database 23.26 Free on both datasets. It is not proof for all data: two small datasets can miss a case.
- *Does it work on other queries?* Three cases, one three-table schema, single `SELECT`s, Oracle to PostgreSQL. The rule engine has more dialects (SQL Server, MySQL, DB2) and a 351-query corpus checked against PostgreSQL, but only Oracle is demonstrated here.
- *How many model runs?* One real run of the three cases (22 s). It is not a statistic. Models vary; the loop's guarantee is that a result is only `verified` if the comparator and invariants say so.
- *What did you build during the event?* `queryshift/`, the correction call and these documents. GoForge, its rule engine and corpus existed before (see "Reused components" in `SUBMISSION.md`); the repository also holds other work from the event (Oracle databases in the app, Schema Change) that this entry does not use.
- *What if the model fits the answer to the visible rows?* The held-out dataset exists for that, and each case has an `overfit_*` candidate that only the held-out data catches. A literal fitted into the SQL is also flagged by a static check.
- *What about the model's confidence?* There is none: no score from the model is used.

## If something goes wrong on the day

| Problem | Do this |
|---|---|
| Model or network down | Skip 4b. Say the loop ends in `needs_human_review` without a proposer, and show `queryshift/reports/case-02.loop.json` for the real run. |
| `npm run queryshift` fails | `npx vitest run queryshift` shows which part; the fresh-clone result is in `SUBMISSION.md`. |
| Oracle not running | Skip the optional step; show `queryshift/reports/oracle-check.json`. |
| Over time | Cut section 3's `--engine` run; keep `--loop`, the failing candidate and the model run. |
