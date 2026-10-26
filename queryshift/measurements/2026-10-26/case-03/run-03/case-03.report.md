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

**What the model says it changed and why** (its own words; nothing checks them): PostgreSQL does not provide TRUNC(timestamp), so the claim timestamp is cast to date for Oracle TRUNC-like day truncation. The date filter is expressed as an inclusive lower and exclusive upper timestamp range, preserving all times in March. Oracle DATE subtraction returns a numeric number of days, whereas PostgreSQL timestamp subtraction returns an interval; extracting epoch seconds and dividing by 86400 restores the numeric day difference. The review-date calculation also preserves Oracle ADD_MONTHS month-end behavior.

- Replaced TRUNC(claim_date) with cl.claim_date::date.
- Replaced the TRUNC-based March predicate with a half-open timestamp range.
- Converted claim timestamp minus effective date to a numeric day count.
- Implemented Oracle ADD_MONTHS month-end handling for the six-month review date.

Request: 2316 tokens in, 899 tokens out, 10.4 s.

```sql
SELECT *
FROM (
    SELECT cl.claim_id AS clm_id,
           p.policy_id AS polcy_id,
           cl.claim_date::date AS clm_day,
           EXTRACT(EPOCH FROM (cl.claim_date - p.effective_date::timestamp)) / 86400 AS days_to_claim,
           CASE
               WHEN p.effective_date = (date_trunc('month', p.effective_date) + INTERVAL '1 month - 1 day')::date
               THEN (date_trunc('month', p.effective_date + INTERVAL '6 months') + INTERVAL '1 month - 1 day')::date
               ELSE (p.effective_date + INTERVAL '6 months')::date
           END AS review_dt,
           cl.claim_amount AS clm_amt
    FROM claims cl
    JOIN policies p ON p.policy_id = cl.policy_id
    WHERE cl.claim_date >= DATE '2026-03-01'
      AND cl.claim_date < DATE '2026-04-01'
    ORDER BY cl.claim_amount DESC, cl.claim_id
) AS subquery_1
LIMIT 5
```

**Primary data: PASS.** Matches the reference result and all 1 invariant(s) hold.

**Held-out data: PASS.** Matches the reference result and all 1 invariant(s) hold.

**Static checks:** nothing.

<details>
<summary>The exact prompt sent for correction 1 (SHA-256 3a30d7b5c725…)</summary>

**Instructions**

```text
You are GoForge's SQL migration engine, in a correction round. An Oracle (or other legacy) query was converted to PostgreSQL, run on a real PostgreSQL database, and compared with the result the ORIGINAL database returns. They differ, or PostgreSQL rejected it.
This is correction 1 of at most 3. After the last one the query goes to a human reviewer, so do not guess: change what the evidence points to.
Return JSON only, no markdown and no text outside the JSON object.
The evidence is a measurement, not an opinion. Missing rows are rows the original returns and the converted query does not. Unexpected rows are rows the converted query returns and the original does not. 'differingColumns' says in which columns a missing row and its closest unexpected row differ. Find the construct whose legacy behaviour differs from PostgreSQL's and explain the difference in the explanation field.
'staticFindings' are observations about the previous query's text made without any data: each names a construct that commonly differs between the legacy dialect and PostgreSQL. They are suspects, not proof: use them to find the cause when the measured rows agree, and ignore one that does not apply.
Typical causes: an outer-join predicate that moved from ON to WHERE; NULL versus empty string; integer division; AVG/COUNT over NULL or null-extended rows; DATE that carries a time of day; date arithmetic returning an interval instead of days; ADD_MONTHS and month ends; ROWNUM and ORDER BY; column names and aliases that differ in the result.
The result must have exactly the column names of 'expectedColumns', in that order, and the same rows, NULLs and ordering as the original.
Use only the tables and columns in the supplied schema. 'mapping' says which legacy table and column became which. Never invent tables, columns or data.
NEVER write the expected rows into the query: no VALUES lists of them, no UNION of constants, no literals copied from the evidence. The query is run against other data as well, and a query that reproduces the evidence is rejected and sent to a human. Fix the logic.
Make the smallest change that fixes what the evidence shows. Keep every part of the previous query that the evidence does not implicate.
One SELECT statement only. Do not write anything that changes data or settings.
The JSON object must contain: sql (string), explanation (string), changes (string[]), risks (string[], what you are still unsure about; these are your words and nothing verifies them).
```

**Input**

```json
{
  "originalQuery": "SELECT *\nFROM (\n    SELECT cl.CLM_ID,\n           p.POLCY_ID,\n           TRUNC(cl.CLM_DT)            AS CLM_DAY,\n           cl.CLM_DT - p.EFF_DT        AS DAYS_TO_CLAIM,\n           ADD_MONTHS(p.EFF_DT, 6)     AS REVIEW_DT,\n           cl.CLM_AMT\n    FROM CLM_DTL cl\n    JOIN POLCY_HDR p ON p.POLCY_ID = cl.POLCY_ID\n    WHERE TRUNC(cl.CLM_DT) BETWEEN TO_DATE('2026-03-01', 'YYYY-MM-DD')\n                               AND TO_DATE('2026-03-31', 'YYYY-MM-DD')\n    ORDER BY cl.CLM_AMT DESC, cl.CLM_ID\n)\nWHERE ROWNUM <= 5\n",
  "sourceDialect": "oracle",
  "targetDialect": "postgresql",
  "businessPurpose": "Claims leadership wants the five largest claims of March 2026 with the claim day, how many days after the policy started the claim came in, and the policy's six-month review date.",
  "schema": {
    "tables": [
      {
        "name": "claims",
        "columns": [
          {
            "name": "claim_id",
            "type": "integer",
            "nullable": false
          },
          {
            "name": "policy_id",
            "type": "integer",
            "nullable": false
          },
          {
            "name": "claim_date",
            "type": "timestamp without time zone",
            "nullable": false
          },
          {
            "name": "claim_amount",
            "type": "numeric",
            "nullable": false
          },
          {
            "name": "claim_status",
            "type": "character varying",
            "nullable": false
          },
          {
            "name": "adjuster_note",
            "type": "character varying",
            "nullable": true
          },
          {
            "name": "paid_amount",
            "type": "numeric",
            "nullable": true
          }
        ]
      },
      {
        "name": "coverages",
        "columns": [
          {
            "name": "coverage_id",
            "type": "integer",
            "nullable": false
          },
          {
            "name": "policy_id",
            "type": "integer",
            "nullable": false
          },
          {
            "name": "coverage_type",
            "type": "character varying",
            "nullable": false
          },
          {
            "name": "limit_amount",
            "type": "numeric",
            "nullable": false
          }
        ]
      },
      {
        "name": "customers",
        "columns": [
          {
            "name": "customer_id",
            "type": "integer",
            "nullable": false
          },
          {
            "name": "customer_name",
            "type": "character varying",
            "nullable": false
          },
          {
            "name": "email",
            "type": "character varying",
            "nullable": true
          },
          {
            "name": "segment_code",
            "type": "character varying",
            "nullable": false
          },
          {
            "name": "joined_on",
            "type": "date",
            "nullable": false
          }
        ]
      },
      {
        "name": "policies",
        "columns": [
          {
            "name": "policy_id",
            "type": "integer",
            "nullable": false
          },
          {
            "name": "customer_id",
            "type": "integer",
            "nullable": false
          },
          {
            "name": "policy_type",
            "type": "character varying",
            "nullable": false
          },
          {
            "name": "effective_date",
            "type": "date",
            "nullable": false
          },
          {
            "name": "expiry_date",
            "type": "date",
            "nullable": false
          },
          {
            "name": "annual_premium",
            "type": "numeric",
            "nullable": true
          },
          {
            "name": "status_code",
            "type": "character varying",
            "nullable": false
          }
        ]
      }
    ]
  },
  "mapping": [
    {
      "sourceTable": "CUST_MST",
      "sourceColumn": "CUST_ID",
      "targetTable": "customers",
      "targetColumn": "customer_id"
    },
    {
      "sourceTable": "CUST_MST",
      "sourceColumn": "CUST_NM",
      "targetTable": "customers",
      "targetColumn": "customer_name"
    },
    {
      "sourceTable": "CUST_MST",
      "sourceColumn": "CUST_EMAIL",
      "targetTable": "customers",
      "targetColumn": "email",
      "note": "Oracle treats '' as NULL; the load maps '' to NULL"
    },
    {
      "sourceTable": "CUST_MST",
      "sourceColumn": "SEGMT_CD",
      "targetTable": "customers",
      "targetColumn": "segment_code"
    },
    {
      "sourceTable": "CUST_MST",
      "sourceColumn": "JOIN_DT",
      "targetTable": "customers",
      "targetColumn": "joined_on",
      "note": "DATE with time 00:00:00 -> date"
    },
    {
      "sourceTable": "POLCY_HDR",
      "sourceColumn": "POLCY_ID",
      "targetTable": "policies",
      "targetColumn": "policy_id"
    },
    {
      "sourceTable": "POLCY_HDR",
      "sourceColumn": "CUST_ID",
      "targetTable": "policies",
      "targetColumn": "customer_id"
    },
    {
      "sourceTable": "POLCY_HDR",
      "sourceColumn": "POLCY_TYP_CD",
      "targetTable": "policies",
      "targetColumn": "policy_type"
    },
    {
      "sourceTable": "POLCY_HDR",
      "sourceColumn": "EFF_DT",
      "targetTable": "policies",
      "targetColumn": "effective_date",
      "note": "DATE with time 00:00:00 -> date"
    },
    {
      "sourceTable": "POLCY_HDR",
      "sourceColumn": "EXP_DT",
      "targetTable": "policies",
      "targetColumn": "expiry_date",
      "note": "DATE with time 00:00:00 -> date"
    },
    {
      "sourceTable": "POLCY_HDR",
      "sourceColumn": "ANNL_PREM",
      "targetTable": "policies",
      "targetColumn": "annual_premium"
    },
    {
      "sourceTable": "POLCY_HDR",
      "sourceColumn": "STAT_CD",
      "targetTable": "policies",
      "targetColumn": "status_code"
    },
    {
      "sourceTable": "CLM_DTL",
      "sourceColumn": "CLM_ID",
      "targetTable": "claims",
      "targetColumn": "claim_id"
    },
    {
      "sourceTable": "CLM_DTL",
      "sourceColumn": "POLCY_ID",
      "targetTable": "claims",
      "targetColumn": "policy_id"
    },
    {
      "sourceTable": "CLM_DTL",
      "sourceColumn": "CLM_DT",
      "targetTable": "claims",
      "targetColumn": "claim_date",
      "note": "DATE with time of day -> timestamp(0)"
    },
    {
      "sourceTable": "CLM_DTL",
      "sourceColumn": "CLM_AMT",
      "targetTable": "claims",
      "targetColumn": "claim_amount"
    },
    {
      "sourceTable": "CLM_DTL",
      "sourceColumn": "CLM_STAT_CD",
      "targetTable": "claims",
      "targetColumn": "claim_status"
    },
    {
      "sourceTable": "CLM_DTL",
      "sourceColumn": "ADJ_NOTE",
      "targetTable": "claims",
      "targetColumn": "adjuster_note",
      "note": "Oracle treats '' as NULL; the load maps '' to NULL"
    },
    {
      "sourceTable": "CLM_DTL",
      "sourceColumn": "PAID_AMT",
      "targetTable": "claims",
      "targetColumn": "paid_amount"
    },
    {
      "sourceTable": "COVERAGE",
      "sourceColumn": "COVR_ID",
      "targetTable": "coverages",
      "targetColumn": "coverage_id"
    },
    {
      "sourceTable": "COVERAGE",
      "sourceColumn": "POLCY_ID",
      "targetTable": "coverages",
      "targetColumn": "policy_id"
    },
    {
      "sourceTable": "COVERAGE",
      "sourceColumn": "COVR_TYP_CD",
      "targetTable": "coverages",
      "targetColumn": "coverage_type"
    },
    {
      "sourceTable": "COVERAGE",
      "sourceColumn": "COVR_LIMIT_AMT",
      "targetTable": "coverages",
      "targetColumn": "limit_amount"
    }
  ],
  "previousQuery": "-- NOT CONVERTED: TRUNC(cl.CLM_DT) (TRUNC(x) cuts a date to midnight or a number to a whole number, and the type of x is not known here)\nSELECT *\nFROM (\n    SELECT cl.claim_id AS CLM_ID,\n           p.policy_id AS POLCY_ID,\n           TRUNC(cl.claim_date)            AS CLM_DAY,\n           cl.claim_date - p.effective_date        AS DAYS_TO_CLAIM, (p.effective_date + INTERVAL '6 months')     AS REVIEW_DT,\n           cl.claim_amount AS CLM_AMT\n    FROM claims cl\n    JOIN policies p ON p.policy_id = cl.policy_id\n    WHERE TRUNC(cl.claim_date) BETWEEN TO_DATE('2026-03-01', 'YYYY-MM-DD')\n                               AND TO_DATE('2026-03-31', 'YYYY-MM-DD')\n    ORDER BY cl.claim_amount DESC, cl.claim_id\n) AS subquery_1\nLIMIT 5",
  "evidence": {
    "kind": "error",
    "message": "PostgreSQL rejected it: function trunc(timestamp without time zone) does not exist",
    "expectedColumns": [
      "clm_id",
      "polcy_id",
      "clm_day",
      "days_to_claim",
      "review_dt",
      "clm_amt"
    ],
    "missingRows": [],
    "unexpectedRows": [],
    "missingCount": 0,
    "unexpectedCount": 0,
    "differingColumns": [],
    "brokenInvariants": [],
    "staticFindings": [
      {
        "id": "month_arithmetic_without_month_end_rule",
        "title": "Month arithmetic without Oracle's month-end rule",
        "detail": "The legacy query uses ADD_MONTHS, which returns the last day of the target month when the start date is the last day of its month (28 Feb + 6 months is 31 Aug). Adding INTERVAL '6 months' keeps the day number (28 Aug). Nothing in this query handles month ends."
      }
    ]
  },
  "engineWarnings": [
    "ADD_MONTHS keeps month-end dates at month end",
    "Not converted: TRUNC(cl.CLM_DT) (TRUNC(x) cuts a date to midnight or a number to a whole number, and the type of x is not known here)"
  ]
}
```

</details>

## Decision

**VERIFIED**

**The accepted query**

```sql
SELECT *
FROM (
    SELECT cl.claim_id AS clm_id,
           p.policy_id AS polcy_id,
           cl.claim_date::date AS clm_day,
           EXTRACT(EPOCH FROM (cl.claim_date - p.effective_date::timestamp)) / 86400 AS days_to_claim,
           CASE
               WHEN p.effective_date = (date_trunc('month', p.effective_date) + INTERVAL '1 month - 1 day')::date
               THEN (date_trunc('month', p.effective_date + INTERVAL '6 months') + INTERVAL '1 month - 1 day')::date
               ELSE (p.effective_date + INTERVAL '6 months')::date
           END AS review_dt,
           cl.claim_amount AS clm_amt
    FROM claims cl
    JOIN policies p ON p.policy_id = cl.policy_id
    WHERE cl.claim_date >= DATE '2026-03-01'
      AND cl.claim_date < DATE '2026-04-01'
    ORDER BY cl.claim_amount DESC, cl.claim_id
) AS subquery_1
LIMIT 5
```

**What a reviewer should still read**

- The model's own uncertainty (unverified): The result type of review_dt is date rather than timestamp, matching the mapped policy effective-date type and Oracle DATE semantics; a harness requiring timestamp formatting could still differ.
- Static checks point at constructs; they are not complete, and a query with no findings has not been shown to be right.
