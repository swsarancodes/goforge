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

**What the model says it changed and why** (its own words; nothing checks them): The measured differences identify two PostgreSQL-versus-Oracle behaviors. PostgreSQL propagates NULL through ||, while Oracle treats NULL as an empty string, so the nullable email must be wrapped in COALESCE. PostgreSQL performs integer division when both COUNT expressions are integers, producing 0 for ratios such as 1/3; casting the numerator to numeric preserves the fractional Oracle result.

- Wrapped c.email in COALESCE(c.email, '') for Oracle-compatible concatenation.
- Cast the open-claim COUNT to numeric before division to avoid PostgreSQL integer division.
- Added explicit result aliases matching expectedColumns.

Request: 2369 tokens in, 415 tokens out, 5.0 s.

```sql
SELECT c.customer_id AS cust_id,
       c.customer_name || ' <' || COALESCE(c.email, '') || '>' AS contact_label,
       COUNT(cl.claim_id) AS clm_cnt,
       COALESCE(SUM(cl.claim_amount), 0) AS tot_claimed,
       ROUND(AVG(COALESCE(cl.paid_amount, 0)), 2) AS avg_paid,
       ROUND(COUNT(CASE WHEN cl.claim_status = 'OP' THEN 1 END)::numeric
             / NULLIF(COUNT(cl.claim_id), 0), 4) AS open_ratio
FROM customers c
JOIN policies p ON p.customer_id = c.customer_id
LEFT JOIN claims cl ON cl.policy_id = p.policy_id
GROUP BY c.customer_id, c.customer_name, c.email
ORDER BY c.customer_id
```

**Primary data: PASS.** Matches the reference result and all 3 invariant(s) hold.

**Held-out data: PASS.** Matches the reference result and all 3 invariant(s) hold.

**Static checks:** nothing.

## Decision

**VERIFIED**

**The accepted query**

```sql
SELECT c.customer_id AS cust_id,
       c.customer_name || ' <' || COALESCE(c.email, '') || '>' AS contact_label,
       COUNT(cl.claim_id) AS clm_cnt,
       COALESCE(SUM(cl.claim_amount), 0) AS tot_claimed,
       ROUND(AVG(COALESCE(cl.paid_amount, 0)), 2) AS avg_paid,
       ROUND(COUNT(CASE WHEN cl.claim_status = 'OP' THEN 1 END)::numeric
             / NULLIF(COUNT(cl.claim_id), 0), 4) AS open_ratio
FROM customers c
JOIN policies p ON p.customer_id = c.customer_id
LEFT JOIN claims cl ON cl.policy_id = p.policy_id
GROUP BY c.customer_id, c.customer_name, c.email
ORDER BY c.customer_id
```

**What a reviewer should still read**

- Static checks point at constructs; they are not complete, and a query with no findings has not been shown to be right.
