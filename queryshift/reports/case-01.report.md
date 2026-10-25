# case-01: Customers and their active 2026 policies (Oracle outer join)

**Outcome: VERIFIED**

The final query returned the reference result on the primary data (7 rows) and the held-out data (8 rows), in the same order, and all 3 invariants held. That is everything "verified" claims. It is a measurement on these datasets, not a proof that the two queries agree on every possible input.

## Input

**What the query is for.** Underwriting wants every customer with the number and premium of policies that started in 2026 and are active, including customers with none, for the renewal outreach list.

Source dialect oracle, target PostgreSQL. Difficulty medium. Risks this case is built to exercise: join_semantics, null_type_or_aggregation_semantics, silent_executable_failure.

**Legacy query**

```sql
SELECT c.CUST_ID,
       c.CUST_NM,
       COUNT(p.POLCY_ID)            AS POLCY_CNT,
       SUM(NVL(p.ANNL_PREM, 0))     AS TOT_PREM
FROM CUST_MST c,
     POLCY_HDR p
WHERE c.CUST_ID = p.CUST_ID(+)
  AND p.EFF_DT(+) >= :cutoff
  AND p.STAT_CD(+) = 'AC'
GROUP BY c.CUST_ID, c.CUST_NM
ORDER BY c.CUST_ID
```

**Bind variables.** The reference result was produced with these values, which the case declares and which are written into the query before anything reads it:

- `:cutoff` = `TO_DATE('2026-01-01', 'YYYY-MM-DD')`

**What it is measured against.** A reference result of 7 rows (columns `cust_id`, `cust_nm`, `polcy_cnt`, `tot_prem`), and a second reference result of 8 rows on a held-out dataset that no model is ever shown anything from. Row order is compared. 3 invariants: one row per customer; policy count is conserved; premium is conserved.

## Risk analysis

**What the rule engine reported about the legacy query.**

Nothing it could not convert.

**What the static checks saw in the rule engine's query.**

Nothing.

## Transformation and proof

| # | Produced by | Result | Measured |
| --- | --- | --- | --- |
| 0 | GoForge rule engine, then the schema mapping | PASS / held-out PASS | Matches the reference result and all 3 invariant(s) hold. |

### Attempt 0: GoForge rule engine, then the schema mapping

```sql
SELECT c.customer_id AS CUST_ID,
       c.customer_name AS CUST_NM,
       COUNT(p.policy_id)            AS POLCY_CNT,
       SUM(COALESCE(p.annual_premium, 0))     AS TOT_PREM
FROM customers c
    LEFT JOIN policies p ON c.customer_id = p.customer_id AND p.effective_date >= TO_DATE('2026-01-01', 'YYYY-MM-DD') AND p.status_code = 'AC'
GROUP BY c.customer_id, c.customer_name
ORDER BY c.customer_id
```

**Primary data: PASS.** Matches the reference result and all 3 invariant(s) hold.

**Held-out data: PASS.** Matches the reference result and all 3 invariant(s) hold.

**Static checks:** nothing.

## Decision

**VERIFIED**

**The accepted query**

```sql
SELECT c.customer_id AS CUST_ID,
       c.customer_name AS CUST_NM,
       COUNT(p.policy_id)            AS POLCY_CNT,
       SUM(COALESCE(p.annual_premium, 0))     AS TOT_PREM
FROM customers c
    LEFT JOIN policies p ON c.customer_id = p.customer_id AND p.effective_date >= TO_DATE('2026-01-01', 'YYYY-MM-DD') AND p.status_code = 'AC'
GROUP BY c.customer_id, c.customer_name
ORDER BY c.customer_id
```

**What a reviewer should still read**

- Static checks point at constructs; they are not complete, and a query with no findings has not been shown to be right.
