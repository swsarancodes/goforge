# case-05: Claims and coverage totals per active policy (join fan-out)

**Outcome: VERIFIED**

The final query returned the reference result on the primary data (7 rows) and the held-out data (6 rows), in the same order, and all 4 invariants held. That is everything "verified" claims. It is a measurement on these datasets, not a proof that the two queries agree on every possible input.

## Input

**What the query is for.** Underwriting wants one line per active policy with the total claimed, the total coverage limit and the number of coverages. Claims and coverages are both several rows per policy, so joining both to the policy before adding them up multiplies every row by the other table's row count: the sums are too big, nothing fails, and the totals look plausible.

Source dialect oracle, target PostgreSQL. Difficulty hard. Risks this case is built to exercise: join_semantics, silent_executable_failure.

**Legacy query**

```sql
SELECT p.POLCY_ID,
       p.POLCY_TYP_CD,
       NVL(cl.CLM_TOT, 0)    AS CLM_TOT,
       NVL(cv.LIMIT_TOT, 0)  AS LIMIT_TOT,
       NVL(cv.COVR_CNT, 0)   AS COVR_CNT
FROM POLCY_HDR p
LEFT JOIN (SELECT POLCY_ID, SUM(CLM_AMT) AS CLM_TOT
           FROM CLM_DTL
           GROUP BY POLCY_ID) cl ON cl.POLCY_ID = p.POLCY_ID
LEFT JOIN (SELECT POLCY_ID, SUM(COVR_LIMIT_AMT) AS LIMIT_TOT, COUNT(*) AS COVR_CNT
           FROM COVERAGE
           GROUP BY POLCY_ID) cv ON cv.POLCY_ID = p.POLCY_ID
WHERE p.STAT_CD = 'AC'
ORDER BY p.POLCY_ID
```

**What it is measured against.** A reference result of 7 rows (columns `polcy_id`, `polcy_typ_cd`, `clm_tot`, `limit_tot`, `covr_cnt`), and a second reference result of 6 rows on a held-out dataset that no model is ever shown anything from. Row order is compared. 4 invariants: one row per active policy; claimed amount is conserved against the claims of active policies; coverage limit is conserved against the coverages of active policies; coverage count is conserved against the coverages of active policies.

## Risk analysis

**What the rule engine reported about the legacy query.**

Nothing it could not convert.

**What the static checks saw in the rule engine's query.**

Nothing.

## Transformation and proof

| # | Produced by | Result | Measured |
| --- | --- | --- | --- |
| 0 | GoForge rule engine, then the schema mapping | ERROR | PostgreSQL rejected it: column cl.policy_id does not exist |
| 1 | model `gpt-5.6-luna` | PASS / held-out PASS | Matches the reference result and all 4 invariant(s) hold. |

### Attempt 0: GoForge rule engine, then the schema mapping

```sql
SELECT p.policy_id AS POLCY_ID,
       p.policy_type AS POLCY_TYP_CD,
       COALESCE(cl.CLM_TOT, 0)    AS CLM_TOT,
       COALESCE(cv.LIMIT_TOT, 0)  AS LIMIT_TOT,
       COALESCE(cv.COVR_CNT, 0)   AS COVR_CNT
FROM policies p
LEFT JOIN (SELECT policy_id AS POLCY_ID, SUM(claim_amount) AS CLM_TOT
           FROM claims
           GROUP BY policy_id) cl ON cl.policy_id = p.policy_id
LEFT JOIN (SELECT policy_id AS POLCY_ID, SUM(limit_amount) AS LIMIT_TOT, COUNT(*) AS COVR_CNT
           FROM coverages
           GROUP BY policy_id) cv ON cv.policy_id = p.policy_id
WHERE p.status_code = 'AC'
ORDER BY p.policy_id
```

**Primary data: ERROR.** PostgreSQL rejected it: column cl.policy_id does not exist

**Static checks:** nothing.

### Attempt 1: model `gpt-5.6-luna`

**What the model says it changed and why** (its own words; nothing checks them): PostgreSQL folds the unquoted alias POLCY_ID to lowercase polcy_id. The outer joins referenced cl.policy_id and cv.policy_id, but those columns were renamed to polcy_id inside the derived tables, so PostgreSQL rejected the query. The join references now use the actual derived-table column names.

- Changed cl.policy_id to cl.POLCY_ID in the claims aggregate join.
- Changed cv.policy_id to cv.POLCY_ID in the coverage aggregate join.

Request: 2205 tokens in, 392 tokens out, 9.1 s.

```sql
SELECT p.policy_id AS POLCY_ID,
       p.policy_type AS POLCY_TYP_CD,
       COALESCE(cl.CLM_TOT, 0)    AS CLM_TOT,
       COALESCE(cv.LIMIT_TOT, 0)  AS LIMIT_TOT,
       COALESCE(cv.COVR_CNT, 0)   AS COVR_CNT
FROM policies p
LEFT JOIN (SELECT policy_id AS POLCY_ID, SUM(claim_amount) AS CLM_TOT
           FROM claims
           GROUP BY policy_id) cl ON cl.POLCY_ID = p.policy_id
LEFT JOIN (SELECT policy_id AS POLCY_ID, SUM(limit_amount) AS LIMIT_TOT, COUNT(*) AS COVR_CNT
           FROM coverages
           GROUP BY policy_id) cv ON cv.POLCY_ID = p.policy_id
WHERE p.status_code = 'AC'
ORDER BY p.policy_id
```

**Primary data: PASS.** Matches the reference result and all 4 invariant(s) hold.

**Held-out data: PASS.** Matches the reference result and all 4 invariant(s) hold.

**Static checks:** nothing.

<details>
<summary>The exact prompt sent for correction 1 (SHA-256 62a8538e0257…)</summary>

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
  "originalQuery": "SELECT p.POLCY_ID,\n       p.POLCY_TYP_CD,\n       NVL(cl.CLM_TOT, 0)    AS CLM_TOT,\n       NVL(cv.LIMIT_TOT, 0)  AS LIMIT_TOT,\n       NVL(cv.COVR_CNT, 0)   AS COVR_CNT\nFROM POLCY_HDR p\nLEFT JOIN (SELECT POLCY_ID, SUM(CLM_AMT) AS CLM_TOT\n           FROM CLM_DTL\n           GROUP BY POLCY_ID) cl ON cl.POLCY_ID = p.POLCY_ID\nLEFT JOIN (SELECT POLCY_ID, SUM(COVR_LIMIT_AMT) AS LIMIT_TOT, COUNT(*) AS COVR_CNT\n           FROM COVERAGE\n           GROUP BY POLCY_ID) cv ON cv.POLCY_ID = p.POLCY_ID\nWHERE p.STAT_CD = 'AC'\nORDER BY p.POLCY_ID\n",
  "sourceDialect": "oracle",
  "targetDialect": "postgresql",
  "businessPurpose": "Underwriting wants one line per active policy with the total claimed, the total coverage limit and the number of coverages. Claims and coverages are both several rows per policy, so joining both to the policy before adding them up multiplies every row by the other table's row count: the sums are too big, nothing fails, and the totals look plausible.",
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
  "previousQuery": "SELECT p.policy_id AS POLCY_ID,\n       p.policy_type AS POLCY_TYP_CD,\n       COALESCE(cl.CLM_TOT, 0)    AS CLM_TOT,\n       COALESCE(cv.LIMIT_TOT, 0)  AS LIMIT_TOT,\n       COALESCE(cv.COVR_CNT, 0)   AS COVR_CNT\nFROM policies p\nLEFT JOIN (SELECT policy_id AS POLCY_ID, SUM(claim_amount) AS CLM_TOT\n           FROM claims\n           GROUP BY policy_id) cl ON cl.policy_id = p.policy_id\nLEFT JOIN (SELECT policy_id AS POLCY_ID, SUM(limit_amount) AS LIMIT_TOT, COUNT(*) AS COVR_CNT\n           FROM coverages\n           GROUP BY policy_id) cv ON cv.policy_id = p.policy_id\nWHERE p.status_code = 'AC'\nORDER BY p.policy_id",
  "evidence": {
    "kind": "error",
    "message": "PostgreSQL rejected it: column cl.policy_id does not exist",
    "expectedColumns": [
      "polcy_id",
      "polcy_typ_cd",
      "clm_tot",
      "limit_tot",
      "covr_cnt"
    ],
    "missingRows": [],
    "unexpectedRows": [],
    "missingCount": 0,
    "unexpectedCount": 0,
    "differingColumns": [],
    "brokenInvariants": [],
    "staticFindings": []
  },
  "engineWarnings": []
}
```

</details>

## Decision

**VERIFIED**

**The accepted query**

```sql
SELECT p.policy_id AS POLCY_ID,
       p.policy_type AS POLCY_TYP_CD,
       COALESCE(cl.CLM_TOT, 0)    AS CLM_TOT,
       COALESCE(cv.LIMIT_TOT, 0)  AS LIMIT_TOT,
       COALESCE(cv.COVR_CNT, 0)   AS COVR_CNT
FROM policies p
LEFT JOIN (SELECT policy_id AS POLCY_ID, SUM(claim_amount) AS CLM_TOT
           FROM claims
           GROUP BY policy_id) cl ON cl.POLCY_ID = p.policy_id
LEFT JOIN (SELECT policy_id AS POLCY_ID, SUM(limit_amount) AS LIMIT_TOT, COUNT(*) AS COVR_CNT
           FROM coverages
           GROUP BY policy_id) cv ON cv.POLCY_ID = p.policy_id
WHERE p.status_code = 'AC'
ORDER BY p.policy_id
```

**What a reviewer should still read**

- Static checks point at constructs; they are not complete, and a query with no findings has not been shown to be right.
