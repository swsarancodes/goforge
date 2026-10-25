# QueryShift demo runbook (Tue 27 Oct, 10 minutes)

Everything below runs from the repository root. The deterministic commands need no key and no network. The two live-model commands need `OPENAI_API_KEY` in `server/.env`.

## The day before

1. Check out the tagged commit in a fresh folder and run `npm install && npm install --prefix server` once (about 70 s).
2. Put the organizers' key in `server/.env`, then `npm run queryshift:check-model`. It must end with "The model answered in the shape the loop needs." Do not show `server/.env` on screen.
3. Run each live command in the table below once, with `--out` pointing at a scratch folder. Note the real timings. Without a model, every command here takes 4 to 8 s on the author's machine.
4. Open these in tabs, ready to switch to: `docs/queryshift-architecture.svg`, `queryshift/reports/case-02.report.md`, `queryshift/reports/case-03.report.md`.
5. Record the whole run (screen and voice) as the backup, and link it from `SUBMISSION.md`.

**Never point a demo run's `--out` at `queryshift/reports`.** That folder holds the recordings that `--proposer replay` plays back and that the submission cites. A live run that fails (network, quota) would overwrite a good recording with a `proposer_failed` trace. Use `/tmp/qs-demo` for the demo. Write to `queryshift/reports` only when re-recording on purpose, and review the diff before committing.

## The ten minutes

| Time | Show | Command | What to point at |
|---|---|---|---|
| 0:00 | The problem | `npm run queryshift -- --engine --case queryshift/cases/case-02-null-and-aggregation-claims` | GoForge's own rule engine converts the Oracle query, PostgreSQL runs it, and it is wrong: "4 expected row(s) missing, 4 unexpected". It warned about both causes and fixed neither. Running without error is not correctness. |
| 1:00 | Architecture | `docs/queryshift-architecture.svg` | One model decision (propose a correction). Everything that decides (guard, read-only run, comparison, held-out data, static checks, budget) is deterministic. |
| 2:00 | A modernization that works | `npm run queryshift -- --loop --proposer model --case queryshift/cases/case-03-date-time-claims-window --out /tmp/qs-demo` | Attempt 0: PostgreSQL rejects `TRUNC` on a timestamp. Attempt 1 (model): passes the primary data, then the held-out data. Open `/tmp/qs-demo/case-03.report.md`. The model call took 12.6 s in the recorded run, on top of the start-up. |
| 5:00 | The silent failure and its recovery | `npm run queryshift -- --loop --proposer model --case queryshift/cases/case-02-null-and-aggregation-claims --out /tmp/qs-demo` | Attempt 0 runs and returns six plausible rows. The comparator says which columns differ (`open_ratio`, `contact_label`). The static checks flagged both constructs from the query text alone. One correction, then both datasets match. The model call took 5.0 s in the recorded run. |
| 6:30 | Wrong answers are caught | `npm run queryshift` | 19 candidates, each judged as its case says: the correct translation passes, the silent ones (`silent_where_filter`, `silent_concat_null`, `silent_between_without_trunc`) and the reversed-order ones fail, and the `overfit_*` ones pass the first dataset and fail the held-out one. |
| 7:30 | When it does not know | `npm run queryshift -- --loop` | With no model, cases 2 and 3 end in `NEEDS HUMAN REVIEW` with the reason and the evidence. This is the outcome the system gives instead of guessing. |
| 8:30 | Questions | | See below. |

What you will see for case 2 (a live run differs only in the label: `attempt 1 (model)`):

```
case-02  Claims summary per customer (NULL, type and aggregation semantics)
  VERIFIED (primary and held-out data)
    attempt 0 (rule-engine): FAIL    4 expected row(s) missing, 4 unexpected row(s) returned.
      static (warning): null_in_concatenation: || with a nullable column
      static (warning): integer_division: Integer division
    attempt 1 (model): PASS    Matches the reference result and all 3 invariant(s) hold.
      held-out data: PASS    Matches the reference result and all 3 invariant(s) hold.
```

## If something goes wrong

| What happens | Do this |
|---|---|
| The model call fails (network, key, quota) | Say so, then run the same command with `--proposer replay` instead of `--proposer model`. It plays back the answers recorded in `queryshift/reports` and runs every query again live. The output says `replay of the recorded gpt-5.6-luna, not a live call`. **Say that it is a replay.** |
| The model gives a different answer than in the recording | Show it. If it is wrong, the loop either corrects it again or ends in `NEEDS HUMAN REVIEW` with the evidence, which is the point of the design. Do not re-run until it passes without saying you did. |
| A command is quiet for a few seconds | Each command starts PostgreSQL (WebAssembly) in the process and builds the databases before the first line appears. Say what is happening while it loads. |
| Nothing works | Play the backup recording. `queryshift/reports/case-0N.report.md` shows the same run as text. |

## Questions to expect

- **How do you know the reference result is right, with no Oracle?** It was derived by hand from documented Oracle behaviour. The correct translations were written separately and reproduced all six references on the first run. A misunderstanding of Oracle that both share would pass. Where an Oracle export exists, it replaces the reference file and nothing else changes.
- **Is "verified" a proof?** No. It means the query matched the reference result on two datasets (row order included when the case says so), every invariant held, and no blocking static finding remained. Two small datasets can still miss a case.
- **What stops the model from fitting the query to the evidence?** Held-out data it is never shown, a check that refuses a query that reproduces the evidence, and a blocking static finding for a comparison with a value the legacy query never contained. Each case ships a fitted query that only the held-out data catches.
- **What does the model see?** The legacy query, table and column names and types, the mapping, the previous query and the measured evidence (synthetic rows). The exact prompt is in each new trace and in the report (`<details>` block).
- **What happens with bind variables?** If the case declares their values (`bindValues` in `case.json`), they are written into the query and it is verified like any other. If it does not, the case goes to a human (`bind_parameters`); no model is asked.
- **Other databases?** The checks and the references are Oracle-specific. A case that names another source dialect is refused with an explanation. The rule engine itself handles SQL Server, MySQL and DB2, but nothing here proves those.
- **What existed before the event?** GoForge, its rule engine and its AI layer. See "Reused components" in `SUBMISSION.md`.
