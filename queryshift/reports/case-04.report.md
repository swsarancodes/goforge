# case-04: Open-claim aging report as of a date nobody has given (must go to a person)

**Outcome: NEEDS HUMAN REVIEW**

No query was accepted. The reasons are below, with what was measured, so the person who takes over starts from evidence and not from a blank page.

## Input

**What the query is for.** Claims management wants, per customer, how many claims are still open and how many days the oldest and the average open claim have been waiting. The query takes the date to age them to as a bind variable, :AS_OF_DATE. A person must decide that date: it is not in the data (the newest claim is not the reporting date), and the days waiting, the oldest and the average all move with it, so there is no single reference result. A translation cannot be checked without it, and a guessed date would only produce a plausible number nobody asked for. The correct outcome is needs_human_review with the reason bind_parameters, and no model call. expected_result.csv therefore holds only the column names: it is a placeholder, not a reference, and becomes one when someone declares the date under bindValues.

Source dialect oracle, target PostgreSQL. Difficulty medium. Risks this case is built to exercise: date_or_time_semantics.

**Legacy query**

```sql
SELECT c.CUST_ID,
       c.CUST_NM,
       COUNT(cl.CLM_ID)                                AS OPEN_CLAIMS,
       MAX(:AS_OF_DATE - TRUNC(cl.CLM_DT))             AS OLDEST_DAYS,
       ROUND(AVG(:AS_OF_DATE - TRUNC(cl.CLM_DT)), 1)   AS AVG_DAYS_OPEN
FROM CUST_MST c
JOIN POLCY_HDR p ON p.CUST_ID = c.CUST_ID
JOIN CLM_DTL cl ON cl.POLCY_ID = p.POLCY_ID
WHERE cl.CLM_STAT_CD = 'OP'
GROUP BY c.CUST_ID, c.CUST_NM
ORDER BY OLDEST_DAYS DESC, c.CUST_ID
```

**What it is measured against.** A reference result of 0 rows (columns `cust_id`, `cust_nm`, `open_claims`, `oldest_days`, `avg_days_open`). Row order is compared. 0 invariants: .

## Risk analysis

**What the rule engine reported about the legacy query.**

- Not converted: TRUNC(cl.CLM_DT) (TRUNC(x) cuts a date to midnight or a number to a whole number, and the type of x is not known here)
- Not converted: :AS_OF_DATE (The bind variable :AS_OF_DATE is not converted)

**What the static checks saw in the rule engine's query.**

Nothing.

## Transformation and proof

| # | Produced by | Result | Measured |
| --- | --- | --- | --- |
| 0 | GoForge rule engine, then the schema mapping | ERROR | PostgreSQL rejected it: syntax error at or near ":" |

### Attempt 0: GoForge rule engine, then the schema mapping

```sql
-- NOT CONVERTED: TRUNC(cl.CLM_DT) (TRUNC(x) cuts a date to midnight or a number to a whole number, and the type of x is not known here)
-- NOT CONVERTED: :AS_OF_DATE (The bind variable :AS_OF_DATE is not converted)
SELECT c.customer_id AS CUST_ID,
       c.customer_name AS CUST_NM,
       COUNT(cl.claim_id)                                AS OPEN_CLAIMS,
       MAX(:AS_OF_DATE - TRUNC(cl.claim_date))             AS OLDEST_DAYS,
       ROUND(AVG(:AS_OF_DATE - TRUNC(cl.claim_date)), 1)   AS AVG_DAYS_OPEN
FROM customers c
JOIN policies p ON p.customer_id = c.customer_id
JOIN claims cl ON cl.policy_id = p.policy_id
WHERE cl.claim_status = 'OP'
GROUP BY c.customer_id, c.customer_name
ORDER BY OLDEST_DAYS DESC, c.customer_id
```

**Primary data: ERROR.** PostgreSQL rejected it: syntax error at or near ":"

**Static checks:** nothing.

## Decision

**NEEDS HUMAN REVIEW**: bind_parameters

- `bind_parameters`: The legacy query has bind variables the case gives no value for (:AS_OF_DATE). The reference result belongs to particular values, so the converted query cannot be run and compared until case.json declares them under "bindValues". No model is asked: nothing it proposed could be checked.

**The last query tried**

```sql
-- NOT CONVERTED: TRUNC(cl.CLM_DT) (TRUNC(x) cuts a date to midnight or a number to a whole number, and the type of x is not known here)
-- NOT CONVERTED: :AS_OF_DATE (The bind variable :AS_OF_DATE is not converted)
SELECT c.customer_id AS CUST_ID,
       c.customer_name AS CUST_NM,
       COUNT(cl.claim_id)                                AS OPEN_CLAIMS,
       MAX(:AS_OF_DATE - TRUNC(cl.claim_date))             AS OLDEST_DAYS,
       ROUND(AVG(:AS_OF_DATE - TRUNC(cl.claim_date)), 1)   AS AVG_DAYS_OPEN
FROM customers c
JOIN policies p ON p.customer_id = c.customer_id
JOIN claims cl ON cl.policy_id = p.policy_id
WHERE cl.claim_status = 'OP'
GROUP BY c.customer_id, c.customer_name
ORDER BY OLDEST_DAYS DESC, c.customer_id
```

**What a reviewer should still read**

- Static checks point at constructs; they are not complete, and a query with no findings has not been shown to be right.
