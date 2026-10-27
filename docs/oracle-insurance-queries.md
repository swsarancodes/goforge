# Five complex Oracle queries on the 10-table insurer

Five reporting queries written the way legacy Oracle SQL is written: comma joins with `(+)`, `DECODE`, `NVL`, `NVL2`, `ROWNUM`, `CONNECT BY`, `KEEP (DENSE_RANK ...)`, `MINUS`, `LISTAGG`, `GREATEST`, `ADD_MONTHS`, `MONTHS_BETWEEN`, `TRUNC(date, 'MM')` and `ROLLUP`. They run on the schema in [examples/oracle-insurance-10](../examples/oracle-insurance-10/README.md) with the data from its `generate_data_oracle.sql` (200 customers by default). They use no `SYSDATE`: every date is fixed (22 Oct 2026 is the day the generator stops at), so the answer is the same every time.

## Try one

1. Create the Oracle database from `schema_oracle.sql` and fill it with `generate_data_oracle.sql` (see the example's README).
2. Migrate it to PostgreSQL on the Migrate page, so both databases hold the same rows.
3. On the Query Modernizer, choose the PostgreSQL database under **Check against** and the Oracle database under **Original on**, paste a query, press **Convert**, then **Run both and compare**. The **Output** tab shows what each database returned, side by side.

## What each one does to the converter

Measured on 27 Oct 2026, converting with the rules alone (see "How this was measured").

| # | Query | Oracle rows | Rules leave unconverted | On PostgreSQL |
|---|---|---:|---|---|
| 1 | Agent scorecard | 10 | nothing | **Different**: runs, 9 values wrong (`PRICED_SHARE`) |
| 2 | Customer 360 | 15 | `MONTHS_BETWEEN`, `KEEP (DENSE_RANK LAST ...)`, `TRUNC` | Error: syntax error at or near "(" |
| 3 | Claims lifecycle | 40 | `TRUNC(k.CLM_DT)` | Error: `trunc(timestamp)` does not exist |
| 4 | Monthly cash flow | 10 | nothing | **Same result**, every value matches |
| 5 | Dormant active policies | 19 | nothing | **Different**: runs, 4 values wrong (`LAST_ACTIVITY`) |

So the set covers each outcome: one conversion that works (4), two that run and return wrong numbers (1 and 5), and two that need the model or a person (2 and 3).

## 1. Agent scorecard

One line per active agent: policies booked, how many are priced, premium, commission, claims, loss ratio, and the agent's rank in their region. Old-style comma joins with `(+)` to two levels, an inline view so claims are summed per policy before they are joined, and an analytic `RANK()` over an aggregate.

What differs in PostgreSQL: `COUNT(...) / COUNT(...)` is an integer division there, so `PRICED_SHARE` (0.88 in Oracle) becomes 0.

```sql
SELECT a.REGN_CD,
       a.AGNT_ID,
       a.AGNT_NM,
       COUNT(p.POLCY_ID)                                                              AS POLCY_CNT,
       ROUND(COUNT(CASE WHEN p.ANNL_PREM IS NOT NULL THEN 1 END)
             / NULLIF(COUNT(p.POLCY_ID), 0), 2)                                       AS PRICED_SHARE,
       SUM(DECODE(p.ANNL_PREM, NULL, 1, 0))                                           AS UNPRICED_CNT,
       NVL(SUM(p.ANNL_PREM), 0)                                                       AS BOOKED_PREM,
       ROUND(NVL(SUM(p.ANNL_PREM), 0) * a.COMM_PCT / 100, 2)                          AS COMMISSION,
       NVL(SUM(cl.CLM_TOT), 0)                                                        AS CLM_TOT,
       ROUND(NVL(SUM(cl.CLM_TOT), 0) / NULLIF(SUM(p.ANNL_PREM), 0), 2)                AS LOSS_RATIO,
       RANK() OVER (PARTITION BY a.REGN_CD
                    ORDER BY NVL(SUM(p.ANNL_PREM), 0) DESC)                           AS REGION_RANK
FROM AGNT_MST a,
     POLCY_HDR p,
     (SELECT POLCY_ID, SUM(CLM_AMT) AS CLM_TOT
      FROM CLM_DTL
      GROUP BY POLCY_ID) cl
WHERE a.AGNT_ID = p.AGNT_ID(+)
  AND p.POLCY_ID = cl.POLCY_ID(+)
  AND a.ACTV_FLG = 'Y'
GROUP BY a.REGN_CD, a.AGNT_ID, a.AGNT_NM, a.COMM_PCT
ORDER BY a.REGN_CD, REGION_RANK, a.AGNT_ID
```

Measured: the rules convert everything and warn about integer division without fixing it. Oracle gives `PRICED_SHARE` 0.88, 0.9, 0.88, 0.96 for the first agents; PostgreSQL gives 0.00. Ten rows on each side, nine wrong cells.

## 2. Customer 360

The 15 customers with the most active premium: a contact label, home city, years as a customer, policy count, active premium, the type of their latest policy and the date to send a renewal notice. A top-N with `ROWNUM` around an ordered inline view.

What differs in PostgreSQL: `||` with a NULL email gives NULL there and `Name <>` in Oracle; `MONTHS_BETWEEN` and `KEEP (DENSE_RANK LAST ...)` do not exist; `ADD_MONTHS(date, -1)` follows Oracle's month-end rule, which a plain `- interval '1 month'` does not.

```sql
SELECT *
FROM (
    SELECT c.CUST_ID,
           c.CUST_NM || ' <' || c.CUST_EMAIL || '>'                          AS CONTACT_LABEL,
           ad.CITY_NM || ', ' || ad.STATE_CD                                 AS HOME_CITY,
           TRUNC(MONTHS_BETWEEN(DATE '2026-10-22', c.JOIN_DT) / 12)          AS YEARS_WITH_US,
           pl.POLCY_CNT,
           NVL(pl.ACTIVE_PREM, 0)                                            AS ACTIVE_PREM,
           pl.LATEST_TYPE,
           ADD_MONTHS(pl.NEXT_EXPIRY, -1)                                    AS NOTICE_DT
    FROM CUST_MST c
    JOIN (SELECT CUST_ID,
                 COUNT(*)                                                    AS POLCY_CNT,
                 SUM(CASE WHEN STAT_CD = 'AC' THEN ANNL_PREM END)            AS ACTIVE_PREM,
                 MAX(POLCY_TYP_CD) KEEP (DENSE_RANK LAST ORDER BY EFF_DT, POLCY_ID) AS LATEST_TYPE,
                 MIN(CASE WHEN STAT_CD = 'AC' AND EXP_DT >= DATE '2026-10-22'
                          THEN EXP_DT END)                                   AS NEXT_EXPIRY
          FROM POLCY_HDR
          GROUP BY CUST_ID) pl ON pl.CUST_ID = c.CUST_ID
    LEFT JOIN CUST_ADDR ad ON ad.CUST_ID = c.CUST_ID AND ad.PRIM_FLG = 'Y'
    ORDER BY NVL(pl.ACTIVE_PREM, 0) DESC, c.CUST_ID
)
WHERE ROWNUM <= 15
```

Measured: the rules leave `MONTHS_BETWEEN`, `KEEP (DENSE_RANK LAST ...)` and `TRUNC` unconverted, and flag the `||`, `ADD_MONTHS` month-end and integer-division traps. PostgreSQL rejects the result, so no values could be compared.

## 3. Claims lifecycle

Claims of the third quarter of 2026 by adjuster and month, with subtotals per adjuster and a grand total: counts, open claims, amounts claimed and paid, and the average days from a claim to its first payment.

What differs in PostgreSQL: subtracting two Oracle dates gives days, while subtracting timestamps gives an interval; `TRUNC(date, 'MM')` is `date_trunc`.

```sql
SELECT CASE GROUPING(ad.ADJSTR_NM)
            WHEN 1 THEN 'ALL ADJUSTERS'
            ELSE NVL(ad.ADJSTR_NM, '(unassigned)') END                       AS ADJUSTER,
       CASE GROUPING(TRUNC(k.CLM_DT, 'MM'))
            WHEN 1 THEN 'ALL MONTHS'
            ELSE TO_CHAR(TRUNC(k.CLM_DT, 'MM'), 'YYYY-MM') END               AS CLM_MONTH,
       COUNT(*)                                                              AS CLM_CNT,
       COUNT(CASE WHEN k.CLM_STAT_CD = 'OP' THEN 1 END)                      AS OPEN_CNT,
       SUM(k.CLM_AMT)                                                        AS CLAIMED,
       NVL(SUM(k.PAID_AMT), 0)                                               AS PAID,
       ROUND(AVG(fp.FIRST_PAY_DT - TRUNC(k.CLM_DT)), 1)                      AS AVG_DAYS_TO_FIRST_PAY
FROM CLM_DTL k
LEFT JOIN ADJSTR_MST ad ON ad.ADJSTR_ID = k.ADJSTR_ID
LEFT JOIN (SELECT CLM_ID, MIN(PYMT_DT) AS FIRST_PAY_DT
           FROM CLM_PYMT
           GROUP BY CLM_ID) fp ON fp.CLM_ID = k.CLM_ID
WHERE k.CLM_DT >= DATE '2026-07-01'
  AND k.CLM_DT <  DATE '2026-10-01'
GROUP BY ROLLUP (ad.ADJSTR_NM, TRUNC(k.CLM_DT, 'MM'))
ORDER BY GROUPING(ad.ADJSTR_NM), ad.ADJSTR_NM, GROUPING(TRUNC(k.CLM_DT, 'MM')), TRUNC(k.CLM_DT, 'MM')
```

Measured: the rules leave `TRUNC(k.CLM_DT)` unconverted and PostgreSQL says `function trunc(timestamp without time zone) does not exist`. That error comes first, so what else would differ is not known.

## 4. Monthly cash flow

Ten months of premium collected against claims paid out, with a running net and the previous month's premium. The month list is generated with `CONNECT BY LEVEL` and `ADD_MONTHS`, so a month with no activity still has a row. Also uses `TRUNC(date, 'MM')`, `LAG`, a running `SUM(...) OVER`, and a timestamp with milliseconds formatted with `FF3`.

```sql
SELECT TO_CHAR(m.MONTH_START, 'YYYY-MM')                                      AS MONTH,
       NVL(pr.PMT_CNT, 0)                                                     AS PMT_CNT,
       NVL(pr.FAILED_CNT, 0)                                                  AS FAILED_CNT,
       NVL(pr.PREM_COLLECTED, 0)                                              AS PREM_COLLECTED,
       NVL(cp.CLM_PAID_OUT, 0)                                                AS CLM_PAID_OUT,
       NVL(pr.PREM_COLLECTED, 0) - NVL(cp.CLM_PAID_OUT, 0)                    AS NET_CASH,
       SUM(NVL(pr.PREM_COLLECTED, 0) - NVL(cp.CLM_PAID_OUT, 0))
           OVER (ORDER BY m.MONTH_START)                                      AS RUNNING_NET,
       LAG(NVL(pr.PREM_COLLECTED, 0)) OVER (ORDER BY m.MONTH_START)           AS PREV_MONTH_PREM,
       TO_CHAR(pr.LAST_PMT_TS, 'YYYY-MM-DD HH24:MI:SS.FF3')                   AS LAST_PMT_AT
FROM (SELECT ADD_MONTHS(DATE '2026-01-01', LEVEL - 1) AS MONTH_START
      FROM DUAL
      CONNECT BY LEVEL <= 10) m,
     (SELECT TRUNC(PMT_DT, 'MM')                                  AS MON,
             COUNT(*)                                             AS PMT_CNT,
             COUNT(CASE WHEN PMT_STAT_CD <> 'OK' THEN 1 END)      AS FAILED_CNT,
             SUM(CASE WHEN PMT_STAT_CD = 'OK' THEN PMT_AMT END)   AS PREM_COLLECTED,
             MAX(PMT_TS)                                          AS LAST_PMT_TS
      FROM PREM_PMT
      GROUP BY TRUNC(PMT_DT, 'MM')) pr,
     (SELECT TRUNC(PYMT_DT, 'MM') AS MON, SUM(PYMT_AMT) AS CLM_PAID_OUT
      FROM CLM_PYMT
      GROUP BY TRUNC(PYMT_DT, 'MM')) cp
WHERE m.MONTH_START = pr.MON(+)
  AND m.MONTH_START = cp.MON(+)
ORDER BY m.MONTH_START
```

Measured: the rules convert everything (the `ADD_MONTHS` month-end trap is flagged, and harmless here because every date is the first of a month). PostgreSQL returns the same 10 rows, every value matching.

## 5. Dormant active policies

Active policies, not yet expired, with no successful premium payment in the last 90 days, with their coverage list, limits, deductible, largest claim as a share of the limit, the sales channel and the last activity. The set of policies is found with `MINUS`.

What differs in PostgreSQL: `GREATEST` returns NULL in Oracle if any argument is NULL, and ignores NULLs in PostgreSQL. A policy with no claims has no last claim date.

```sql
SELECT h.POLCY_ID,
       c.CUST_NM,
       h.POLCY_TYP_CD,
       NVL2(h.AGNT_ID, 'AGENT', 'DIRECT')                                   AS CHANNEL,
       cv.COVG_LIST,
       cv.TOT_LIMIT,
       cv.MIN_DEDUCT,
       cl.MAX_CLAIM,
       ROUND(cl.MAX_CLAIM / NULLIF(cv.TOT_LIMIT, 0) * 100, 1)               AS MAX_CLAIM_PCT_OF_LIMIT,
       GREATEST(cl.LAST_CLM_DT, pm.LAST_PMT_DT)                             AS LAST_ACTIVITY
FROM POLCY_HDR h
JOIN CUST_MST c ON c.CUST_ID = h.CUST_ID
LEFT JOIN (SELECT POLCY_ID,
                  LISTAGG(COVG_CD, '/') WITHIN GROUP (ORDER BY COVG_CD)     AS COVG_LIST,
                  SUM(COVG_LMT)                                             AS TOT_LIMIT,
                  MIN(DEDCT_AMT)                                            AS MIN_DEDUCT
           FROM POLCY_COVG
           GROUP BY POLCY_ID) cv ON cv.POLCY_ID = h.POLCY_ID
LEFT JOIN (SELECT POLCY_ID, MAX(CLM_AMT) AS MAX_CLAIM, MAX(CLM_DT) AS LAST_CLM_DT
           FROM CLM_DTL
           GROUP BY POLCY_ID) cl ON cl.POLCY_ID = h.POLCY_ID
LEFT JOIN (SELECT POLCY_ID, MAX(PMT_DT) AS LAST_PMT_DT
           FROM PREM_PMT
           GROUP BY POLCY_ID) pm ON pm.POLCY_ID = h.POLCY_ID
WHERE h.POLCY_ID IN (SELECT POLCY_ID FROM POLCY_HDR WHERE STAT_CD = 'AC'
                     MINUS
                     SELECT POLCY_ID FROM PREM_PMT
                     WHERE PMT_DT >= DATE '2026-07-24' AND PMT_STAT_CD = 'OK')
  AND h.EXP_DT >= DATE '2026-10-22'
ORDER BY NVL(cl.MAX_CLAIM, 0) DESC, h.POLCY_ID
```

Measured: the rules convert everything and flag `GREATEST` with NULL, but do not fix it. Oracle leaves `LAST_ACTIVITY` empty for the policies with no claims; PostgreSQL returns their last payment date (for example 2026-08-15). Nineteen rows on each side, four wrong cells.

## How this was measured

- Oracle: the local `gvenzl/oracle-free:23-slim-faststart` container. PostgreSQL: a local PostgreSQL 16.15 container. The data went across with GoForge's own migration (4,611 rows, every table checked against Oracle).
- Each query was run on Oracle, converted with the rule engine (`convertQuery`, source Oracle) and the conversion run on PostgreSQL. The two results were compared by value, not by formatting, and with the row order kept, because every query ends in a total `ORDER BY`.
- The conversion used the rules alone, with no diagram loaded and no model. With a diagram loaded (which tells the rules what type a column has) or with "Rules, then AI", queries 2 and 3 may convert further; that was not measured.
- One dataset (the default 200 customers). A match on one dataset is evidence, not proof.
- These are not QueryShift cases. The QueryShift harness judges the four-table schema in `queryshift/domain`; these queries are for the Modernizer.
