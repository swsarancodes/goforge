# case-03: Five largest March claims (date and time semantics, ROWNUM)

**Outcome: VERIFIED**

The final query returned the reference result on the primary data (5 rows) and the held-out data (5 rows), in the same order, and the invariant held. That is everything "verified" claims. It is a measurement on these datasets, not a proof that the two queries agree on every possible input.

## Input

**What the query is for.** Claims leadership wants the five largest claims of March 2026 with the claim day, how many days after the policy started the claim came in, and the policy's six-month review date.

Source dialect oracle, target PostgreSQL. Difficulty hard. Risks this case is built to exercise: date_or_time_semantics, silent_executable_failure.

**Legacy query**

```sql
SELECT *
FROM (
    SELECT cl.CLM_ID,
           p.POLCY_ID,
           TRUNC(cl.CLM_DT)            AS CLM_DAY,
           cl.CLM_DT - p.EFF_DT        AS DAYS_TO_CLAIM,
           ADD_MONTHS(p.EFF_DT, 6)     AS REVIEW_DT,
           cl.CLM_AMT
    FROM CLM_DTL cl
    JOIN POLCY_HDR p ON p.POLCY_ID = cl.POLCY_ID
    WHERE TRUNC(cl.CLM_DT) BETWEEN TO_DATE('2026-03-01', 'YYYY-MM-DD')
                               AND TO_DATE('2026-03-31', 'YYYY-MM-DD')
    ORDER BY cl.CLM_AMT DESC, cl.CLM_ID
)
WHERE ROWNUM <= 5
```

**What it is measured against.** A reference result of 5 rows (columns `clm_id`, `polcy_id`, `clm_day`, `days_to_claim`, `review_dt`, `clm_amt`), and a second reference result of 5 rows on a held-out dataset that no model is ever shown anything from. Row order is compared. 1 invariant: at most five rows, and all five when there are that many March claims.

## Risk analysis

**What the rule engine reported about the legacy query.**

- ADD_MONTHS keeps month-end dates at month end
- Not converted: TRUNC(cl.CLM_DT) (TRUNC(x) cuts a date to midnight or a number to a whole number, and the type of x is not known here)

**What the static checks saw in the rule engine's query.**

- Month arithmetic without Oracle's month-end rule (`month_arithmetic_without_month_end_rule`, warning). The legacy query uses ADD_MONTHS, which returns the last day of the target month when the start date is the last day of its month (28 Feb + 6 months is 31 Aug). Adding INTERVAL '6 months' keeps the day number (28 Aug). Nothing in this query handles month ends.

## Transformation and proof

| # | Produced by | Result | Measured |
| --- | --- | --- | --- |
| 0 | GoForge rule engine, then the schema mapping | ERROR | PostgreSQL rejected it: function trunc(timestamp without time zone) does not exist |
| 1 | model `gpt-5.6-luna` | PASS / held-out PASS | Matches the reference result and all 1 invariant(s) hold. |

### Attempt 0: GoForge rule engine, then the schema mapping

```sql
-- NOT CONVERTED: TRUNC(cl.CLM_DT) (TRUNC(x) cuts a date to midnight or a number to a whole number, and the type of x is not known here)
SELECT *
FROM (
    SELECT cl.claim_id AS CLM_ID,
           p.policy_id AS POLCY_ID,
           TRUNC(cl.claim_date)            AS CLM_DAY,
           cl.claim_date - p.effective_date        AS DAYS_TO_CLAIM, (p.effective_date + INTERVAL '6 months')     AS REVIEW_DT,
           cl.claim_amount AS CLM_AMT
    FROM claims cl
    JOIN policies p ON p.policy_id = cl.policy_id
    WHERE TRUNC(cl.claim_date) BETWEEN TO_DATE('2026-03-01', 'YYYY-MM-DD')
                               AND TO_DATE('2026-03-31', 'YYYY-MM-DD')
    ORDER BY cl.claim_amount DESC, cl.claim_id
) AS subquery_1
LIMIT 5
```

**Primary data: ERROR.** PostgreSQL rejected it: function trunc(timestamp without time zone) does not exist

**Static checks:** Month arithmetic without Oracle's month-end rule (`month_arithmetic_without_month_end_rule`, warning)

### Attempt 1: model `gpt-5.6-luna`

**What the model says it changed and why** (its own words; nothing checks them): TRUNC(timestamp) is not a PostgreSQL function, so the claim day is produced with a date cast and the March predicate uses an equivalent half-open timestamp range. Oracle DATE subtraction returns elapsed days, so the timestamp difference is converted from seconds to days. ADD_MONTHS preserves month-end dates, which is explicitly handled for effective dates that are the last day of their month.

- Replaced TRUNC(cl.claim_date) with cl.claim_date::date.
- Replaced the TRUNC-based March filter with a half-open timestamp range.
- Converted claim-date subtraction to elapsed days using EXTRACT(EPOCH) divided by 86400.
- Implemented Oracle ADD_MONTHS month-end behavior for the six-month review date.
- Used target table and column names while preserving the expected output aliases and ordering.

Request: 2144 tokens in, 1053 tokens out, 12.6 s.

```sql
SELECT cl.claim_id AS clm_id,
       p.policy_id AS polcy_id,
       cl.claim_date::date AS clm_day,
       EXTRACT(EPOCH FROM (cl.claim_date - p.effective_date::timestamp)) / 86400 AS days_to_claim,
       CASE
           WHEN p.effective_date = (date_trunc('month', p.effective_date)::date + INTERVAL '1 month - 1 day')::date
           THEN (date_trunc('month', p.effective_date + INTERVAL '6 months') + INTERVAL '1 month - 1 day')::date
           ELSE (p.effective_date + INTERVAL '6 months')::date
       END AS review_dt,
       cl.claim_amount AS clm_amt
FROM claims cl
JOIN policies p ON p.policy_id = cl.policy_id
WHERE cl.claim_date >= TIMESTAMP '2026-03-01'
  AND cl.claim_date < TIMESTAMP '2026-04-01'
ORDER BY cl.claim_amount DESC, cl.claim_id
LIMIT 5
```

**Primary data: PASS.** Matches the reference result and all 1 invariant(s) hold.

**Held-out data: PASS.** Matches the reference result and all 1 invariant(s) hold.

**Static checks:** nothing.

## Decision

**VERIFIED**

**The accepted query**

```sql
SELECT cl.claim_id AS clm_id,
       p.policy_id AS polcy_id,
       cl.claim_date::date AS clm_day,
       EXTRACT(EPOCH FROM (cl.claim_date - p.effective_date::timestamp)) / 86400 AS days_to_claim,
       CASE
           WHEN p.effective_date = (date_trunc('month', p.effective_date)::date + INTERVAL '1 month - 1 day')::date
           THEN (date_trunc('month', p.effective_date + INTERVAL '6 months') + INTERVAL '1 month - 1 day')::date
           ELSE (p.effective_date + INTERVAL '6 months')::date
       END AS review_dt,
       cl.claim_amount AS clm_amt
FROM claims cl
JOIN policies p ON p.policy_id = cl.policy_id
WHERE cl.claim_date >= TIMESTAMP '2026-03-01'
  AND cl.claim_date < TIMESTAMP '2026-04-01'
ORDER BY cl.claim_amount DESC, cl.claim_id
LIMIT 5
```

**What a reviewer should still read**

- The model's own uncertainty (unverified): The numeric display type and formatting of the elapsed-day expression may differ from Oracle even though its value is equivalent.
- The model's own uncertainty (unverified): The expected comparison must treat CLM_DAY as a PostgreSQL date, matching Oracle TRUNC's midnight date value.
- Static checks point at constructs; they are not complete, and a query with no findings has not been shown to be right.
