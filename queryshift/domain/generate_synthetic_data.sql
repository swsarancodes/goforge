-- Synthetic data for the live database created from the Oracle insurance diagram (tables cust_mst, polcy_hdr, clm_dtl).
-- Everything is invented. Run the whole script on that database, then COMMIT if your editor keeps the run in a transaction.
--
-- How many rows: change the 200 in "generate_series(1, 200)" (customers); policies and claims follow from them
-- (about 1.7 policies per customer, about 1.5 claims per policy; 15% of customers have no policy).
-- It can be run again: new rows get ids after the existing ones, and a policy that already has claims gets no more.
--
-- The data is not uniform on purpose: about 20% of customers have no email, 10% of policies have no premium, a tenth of the
-- policies start on the last day of a month, claims land at any time of day (some on the last day of a month, some at 23:59:59),
-- about a third of the claims are open and unpaid, and a third of the claims have no adjuster note. Those are the rows legacy
-- Oracle queries tend to get wrong after a migration.
--
-- Reproducible when the editor keeps one session for the whole script (setseed); otherwise the numbers differ run to run.

SELECT setseed(0.42);

-- 1. customers -----------------------------------------------------------------------------------------------------------
INSERT INTO cust_mst (cust_id, cust_nm, cust_email, segmt_cd, join_dt)
SELECT base.max_id + g,
       (ARRAY['Asha','Brightline','Carlos','Dunmore','Eli','Farah','Gita','Hiro','Ines','Jonas','Kiran','Lumen','Mara','Nikhil','Olga','Priya'])[1 + (g % 16)]
       || ' ' ||
       (ARRAY['Rao','Logistics','Mendes','Foods','Park','Khan','Nair','Sato','Alvarez','Weber','Shah','Retail','Quinn','Das','Petrov','Menon'])[1 + ((g / 16) % 16)],
       CASE WHEN random() < 0.20 THEN NULL ELSE 'customer' || (base.max_id + g) || '@example.com' END,
       CASE WHEN random() < 0.30 THEN 'COM' ELSE 'RET' END,
       TIMESTAMP '2018-01-01 00:00:00' + floor(random() * 2800)::int * INTERVAL '1 day'
FROM generate_series(1, 200) AS g,
     (SELECT COALESCE(MAX(cust_id), 0) AS max_id FROM cust_mst) AS base;

-- 2. policies: 0 to 3 per customer that has none yet ---------------------------------------------------------------------
INSERT INTO polcy_hdr (polcy_id, cust_id, polcy_typ_cd, eff_dt, exp_dt, annl_prem, stat_cd)
WITH wanted AS (
    SELECT c.cust_id,
           CASE WHEN random() < 0.15 THEN 0 ELSE 1 + floor(random() * 3)::int END AS n
    FROM cust_mst c
    WHERE NOT EXISTS (SELECT 1 FROM polcy_hdr p WHERE p.cust_id = c.cust_id)
), starts AS (
    SELECT w.cust_id,
           CASE WHEN random() < 0.10
                THEN (date_trunc('month', day) + INTERVAL '1 month - 1 day')::date   -- last day of a month
                ELSE day::date
           END AS eff
    FROM wanted w
    CROSS JOIN LATERAL generate_series(1, w.n) AS k
    CROSS JOIN LATERAL (SELECT DATE '2024-01-01' + floor(random() * 1035)::int AS day) AS d
)
SELECT (SELECT COALESCE(MAX(polcy_id), 0) FROM polcy_hdr) + row_number() OVER (ORDER BY s.cust_id, s.eff),
       s.cust_id,
       (ARRAY['AUTO','HOME','PROP','LIAB'])[1 + floor(random() * 4)::int],
       s.eff::timestamp,
       (s.eff + INTERVAL '1 year' - INTERVAL '1 day')::timestamp,
       CASE WHEN random() < 0.10 THEN NULL ELSE round((300 + random() * 14000)::numeric, 2) END,
       CASE WHEN random() < 0.85 THEN 'AC' ELSE 'LP' END
FROM starts s;

-- 3. claims: 0 to 3 per policy that has none yet, dated within the policy's term and not after 22 Oct 2026 -------------------
INSERT INTO clm_dtl (clm_id, polcy_id, clm_dt, clm_amt, clm_stat_cd, adj_note, paid_amt)
WITH wanted AS (
    SELECT p.polcy_id, p.eff_dt, p.exp_dt,
           GREATEST(0, floor(extract(epoch FROM (LEAST(p.exp_dt, TIMESTAMP '2026-10-22 00:00:00') - p.eff_dt)) / 86400))::int AS span_days,
           floor(random() * 4)::int AS n
    FROM polcy_hdr p
    WHERE NOT EXISTS (SELECT 1 FROM clm_dtl c WHERE c.polcy_id = p.polcy_id)
), raw AS (
    SELECT w.polcy_id,
           CASE WHEN random() < 0.08                                              -- the last day of a month, at the end of it
                THEN LEAST(date_trunc('month', w.eff_dt + floor(random() * (w.span_days + 1))::int * INTERVAL '1 day') + INTERVAL '1 month - 1 second',
                           w.exp_dt + INTERVAL '1 day' - INTERVAL '1 second', TIMESTAMP '2026-10-22 23:59:59')
                ELSE w.eff_dt + floor(random() * (w.span_days + 1))::int * INTERVAL '1 day' + floor(random() * 86400)::int * INTERVAL '1 second'
           END AS clm_dt,
           round((50 + power(random(), 3) * 20000)::numeric, 2) AS amount,
           random() < 0.35 AS is_open,
           random() AS note_roll,
           random() AS paid_roll,
           random() AS note_pick
    FROM wanted w
    CROSS JOIN LATERAL generate_series(1, w.n) AS k
)
SELECT (SELECT COALESCE(MAX(clm_id), 0) FROM clm_dtl) + row_number() OVER (ORDER BY r.polcy_id, r.clm_dt),
       r.polcy_id,
       date_trunc('second', r.clm_dt)::timestamp(0),
       r.amount,
       CASE WHEN r.is_open THEN 'OP' ELSE 'CL' END,
       CASE WHEN r.note_roll < 0.33 THEN NULL
            ELSE (ARRAY['rear bumper','water damage','storm','theft','glass','fire','pipe burst','hail','minor scratch','roof'])[1 + floor(r.note_pick * 10)::int]
       END,
       CASE WHEN r.is_open THEN NULL ELSE round((r.amount * (0.6 + r.paid_roll * 0.4))::numeric, 2) END
FROM raw r;

-- 4. what you got ------------------------------------------------------------------------------------------------------------
SELECT (SELECT count(*) FROM cust_mst)                                             AS customers,
       (SELECT count(*) FROM cust_mst WHERE cust_email IS NULL)                    AS customers_without_email,
       (SELECT count(*) FROM cust_mst c WHERE NOT EXISTS (SELECT 1 FROM polcy_hdr p WHERE p.cust_id = c.cust_id)) AS customers_without_policy,
       (SELECT count(*) FROM polcy_hdr)                                            AS policies,
       (SELECT count(*) FROM polcy_hdr WHERE stat_cd = 'LP')                       AS lapsed_policies,
       (SELECT count(*) FROM clm_dtl)                                              AS claims,
       (SELECT count(*) FROM clm_dtl WHERE clm_stat_cd = 'OP')                     AS open_claims;
