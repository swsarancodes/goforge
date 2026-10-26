# case-02: Claims summary per customer (NULL, type and aggregation semantics)

**Outcome: VERIFIED**

The final query returned the reference result on the primary data (6 rows) and the held-out data (6 rows), in the same order, and all 3 invariants held. That is everything "verified" claims. It is a measurement on these datasets, not a proof that the two queries agree on every possible input.

## Input

**What the query is for.** Claims management wants one line per insured customer with a contact label, how many claims, the amount claimed, the average amount paid (unpaid counts as 0) and the share still open.

Source dialect oracle, target PostgreSQL. Difficulty hard. Risks this case is built to exercise: null_type_or_aggregation_semantics, silent_executable_failure.

**Legacy query**

```sql
SELECT c.CUST_ID,
       c.CUST_NM || ' <' || c.CUST_EMAIL || '>'                                   AS CONTACT_LABEL,
       COUNT(cl.CLM_ID)                                                           AS CLM_CNT,
       NVL(SUM(cl.CLM_AMT), 0)                                                    AS TOT_CLAIMED,
       ROUND(AVG(NVL(cl.PAID_AMT, 0)), 2)                                         AS AVG_PAID,
       ROUND(COUNT(CASE WHEN cl.CLM_STAT_CD = 'OP' THEN 1 END)
             / NULLIF(COUNT(cl.CLM_ID), 0), 4)                                    AS OPEN_RATIO
FROM CUST_MST c
JOIN POLCY_HDR p ON p.CUST_ID = c.CUST_ID
LEFT JOIN CLM_DTL cl ON cl.POLCY_ID = p.POLCY_ID
GROUP BY c.CUST_ID, c.CUST_NM, c.CUST_EMAIL
ORDER BY c.CUST_ID
```

**What it is measured against.** A reference result of 6 rows (columns `cust_id`, `contact_label`, `clm_cnt`, `tot_claimed`, `avg_paid`, `open_ratio`), and a second reference result of 6 rows on a held-out dataset that no model is ever shown anything from. Row order is compared. 3 invariants: one row per customer that has a policy; claim count is conserved; claimed amount is conserved.

## Risk analysis

**What the rule engine reported about the legacy query.**

- || with a NULL gives a different result
- Dividing two integers

**What the static checks saw in the rule engine's query.**

- || with a nullable column (`null_in_concatenation`, warning). c.email can be NULL. Oracle treats NULL as an empty string in ||; in PostgreSQL the whole result becomes NULL. Wrap it in COALESCE(…, '') or use CONCAT.
- Integer division (`integer_division`, warning). `COUNT(…) / NULLIF(…)` divides two integers. PostgreSQL truncates the result (1/3 is 0); Oracle's NUMBER division keeps the fraction. Cast one side to numeric.

## Transformation and proof

| # | Produced by | Result | Measured |
| --- | --- | --- | --- |
| 0 | GoForge rule engine, then the schema mapping | FAIL | 4 expected row(s) missing, 4 unexpected row(s) returned. |
| 1 | model `gpt-5.6-luna` | PASS / held-out PASS | Matches the reference result and all 3 invariant(s) hold. |

### Attempt 0: GoForge rule engine, then the schema mapping

```sql
SELECT c.customer_id AS CUST_ID,
       c.customer_name || ' <' || c.email || '>'                                   AS CONTACT_LABEL,
       COUNT(cl.claim_id)                                                           AS CLM_CNT,
       COALESCE(SUM(cl.claim_amount), 0)                                                    AS TOT_CLAIMED,
       ROUND(AVG(COALESCE(cl.paid_amount, 0)), 2)                                         AS AVG_PAID,
       ROUND(COUNT(CASE WHEN cl.claim_status = 'OP' THEN 1 END)
             / NULLIF(COUNT(cl.claim_id), 0), 4)                                    AS OPEN_RATIO
FROM customers c
JOIN policies p ON p.customer_id = c.customer_id
LEFT JOIN claims cl ON cl.policy_id = p.policy_id
GROUP BY c.customer_id, c.customer_name, c.email
ORDER BY c.customer_id
```

**Primary data: FAIL.** 4 expected row(s) missing, 4 unexpected row(s) returned.

- 4 rows missing, 4 rows unexpected.
- The rows differ in: open_ratio (4 rows), contact_label (1 row).

**Static checks:** || with a nullable column (`null_in_concatenation`, warning); Integer division (`integer_division`, warning)

### Attempt 1: model `gpt-5.6-luna`

**What the model says it changed and why** (its own words; nothing checks them): The measured differences identify two PostgreSQL-versus-Oracle semantics. PostgreSQL propagates NULL through ||, whereas Oracle treats the nullable email as an empty string during concatenation, so email is wrapped in COALESCE. PostgreSQL performs integer division for the two COUNT expressions, producing 0.0000 for the observed one-third and one-half ratios; casting the numerator to numeric preserves the fractional division before rounding.

- Wrapped c.email in COALESCE(c.email, '') for Oracle-compatible concatenation with NULL emails.
- Cast the open-claim COUNT to numeric before division to avoid PostgreSQL integer truncation.

Request: 2541 tokens in, 405 tokens out, 5.2 s.

```sql
SELECT c.customer_id AS CUST_ID,
       c.customer_name || ' <' || COALESCE(c.email, '') || '>' AS CONTACT_LABEL,
       COUNT(cl.claim_id) AS CLM_CNT,
       COALESCE(SUM(cl.claim_amount), 0) AS TOT_CLAIMED,
       ROUND(AVG(COALESCE(cl.paid_amount, 0)), 2) AS AVG_PAID,
       ROUND(COUNT(CASE WHEN cl.claim_status = 'OP' THEN 1 END)::numeric
             / NULLIF(COUNT(cl.claim_id), 0), 4) AS OPEN_RATIO
FROM customers c
JOIN policies p ON p.customer_id = c.customer_id
LEFT JOIN claims cl ON cl.policy_id = p.policy_id
GROUP BY c.customer_id, c.customer_name, c.email
ORDER BY c.customer_id
```

**Primary data: PASS.** Matches the reference result and all 3 invariant(s) hold.

**Held-out data: PASS.** Matches the reference result and all 3 invariant(s) hold.

**Static checks:** nothing.

<details>
<summary>The exact prompt sent for correction 1 (SHA-256 84d7b979d0d6…)</summary>

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
  "originalQuery": "SELECT c.CUST_ID,\n       c.CUST_NM || ' <' || c.CUST_EMAIL || '>'                                   AS CONTACT_LABEL,\n       COUNT(cl.CLM_ID)                                                           AS CLM_CNT,\n       NVL(SUM(cl.CLM_AMT), 0)                                                    AS TOT_CLAIMED,\n       ROUND(AVG(NVL(cl.PAID_AMT, 0)), 2)                                         AS AVG_PAID,\n       ROUND(COUNT(CASE WHEN cl.CLM_STAT_CD = 'OP' THEN 1 END)\n             / NULLIF(COUNT(cl.CLM_ID), 0), 4)                                    AS OPEN_RATIO\nFROM CUST_MST c\nJOIN POLCY_HDR p ON p.CUST_ID = c.CUST_ID\nLEFT JOIN CLM_DTL cl ON cl.POLCY_ID = p.POLCY_ID\nGROUP BY c.CUST_ID, c.CUST_NM, c.CUST_EMAIL\nORDER BY c.CUST_ID\n",
  "sourceDialect": "oracle",
  "targetDialect": "postgresql",
  "businessPurpose": "Claims management wants one line per insured customer with a contact label, how many claims, the amount claimed, the average amount paid (unpaid counts as 0) and the share still open.",
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
  "previousQuery": "SELECT c.customer_id AS CUST_ID,\n       c.customer_name || ' <' || c.email || '>'                                   AS CONTACT_LABEL,\n       COUNT(cl.claim_id)                                                           AS CLM_CNT,\n       COALESCE(SUM(cl.claim_amount), 0)                                                    AS TOT_CLAIMED,\n       ROUND(AVG(COALESCE(cl.paid_amount, 0)), 2)                                         AS AVG_PAID,\n       ROUND(COUNT(CASE WHEN cl.claim_status = 'OP' THEN 1 END)\n             / NULLIF(COUNT(cl.claim_id), 0), 4)                                    AS OPEN_RATIO\nFROM customers c\nJOIN policies p ON p.customer_id = c.customer_id\nLEFT JOIN claims cl ON cl.policy_id = p.policy_id\nGROUP BY c.customer_id, c.customer_name, c.email\nORDER BY c.customer_id",
  "evidence": {
    "kind": "mismatch",
    "message": "4 expected row(s) missing, 4 unexpected row(s) returned.",
    "expectedColumns": [
      "cust_id",
      "contact_label",
      "clm_cnt",
      "tot_claimed",
      "avg_paid",
      "open_ratio"
    ],
    "missingRows": [
      [
        "1",
        "Asha Rao <asha.rao@example.com>",
        "3",
        "4400.00",
        "700.00",
        "0.3333"
      ],
      [
        "2",
        "Brightline Logistics <>",
        "3",
        "4920.25",
        "1206.67",
        "0.3333"
      ],
      [
        "3",
        "Carlos Mendes <carlos@example.com>",
        "2",
        "6400.00",
        "150.00",
        "0.5"
      ],
      [
        "4",
        "Dunmore Foods <accounts@dunmore.example>",
        "2",
        "18000.00",
        "2666.67",
        "0.5"
      ]
    ],
    "unexpectedRows": [
      [
        "1",
        "Asha Rao <asha.rao@example.com>",
        "3",
        "4400.00",
        "700.00",
        "0.0000"
      ],
      [
        "2",
        null,
        "3",
        "4920.25",
        "1206.67",
        "0.0000"
      ],
      [
        "3",
        "Carlos Mendes <carlos@example.com>",
        "2",
        "6400.00",
        "150.00",
        "0.0000"
      ],
      [
        "4",
        "Dunmore Foods <accounts@dunmore.example>",
        "2",
        "18000.00",
        "2666.67",
        "0.0000"
      ]
    ],
    "missingCount": 4,
    "unexpectedCount": 4,
    "differingColumns": [
      {
        "column": "open_ratio",
        "rows": 4
      },
      {
        "column": "contact_label",
        "rows": 1
      }
    ],
    "brokenInvariants": [],
    "staticFindings": [
      {
        "id": "null_in_concatenation",
        "title": "|| with a nullable column",
        "detail": "c.email can be NULL. Oracle treats NULL as an empty string in ||; in PostgreSQL the whole result becomes NULL. Wrap it in COALESCE(…, '') or use CONCAT."
      },
      {
        "id": "integer_division",
        "title": "Integer division",
        "detail": "`COUNT(…) / NULLIF(…)` divides two integers. PostgreSQL truncates the result (1/3 is 0); Oracle's NUMBER division keeps the fraction. Cast one side to numeric."
      }
    ]
  },
  "engineWarnings": [
    "|| with a NULL gives a different result",
    "Dividing two integers"
  ]
}
```

</details>

## Decision

**VERIFIED**

**The accepted query**

```sql
SELECT c.customer_id AS CUST_ID,
       c.customer_name || ' <' || COALESCE(c.email, '') || '>' AS CONTACT_LABEL,
       COUNT(cl.claim_id) AS CLM_CNT,
       COALESCE(SUM(cl.claim_amount), 0) AS TOT_CLAIMED,
       ROUND(AVG(COALESCE(cl.paid_amount, 0)), 2) AS AVG_PAID,
       ROUND(COUNT(CASE WHEN cl.claim_status = 'OP' THEN 1 END)::numeric
             / NULLIF(COUNT(cl.claim_id), 0), 4) AS OPEN_RATIO
FROM customers c
JOIN policies p ON p.customer_id = c.customer_id
LEFT JOIN claims cl ON cl.policy_id = p.policy_id
GROUP BY c.customer_id, c.customer_name, c.email
ORDER BY c.customer_id
```

**What a reviewer should still read**

- Static checks point at constructs; they are not complete, and a query with no findings has not been shown to be right.
