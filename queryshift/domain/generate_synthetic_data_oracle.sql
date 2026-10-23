-- Synthetic data for an Oracle database created from the insurance diagram (tables CUST_MST, POLCY_HDR, CLM_DTL): the legacy set.
-- Everything is invented. Run the whole script (the SQL page splits it: the PL/SQL block ends at the line holding only /).
--
-- How many rows: change the 200 in "FOR g IN 1..200" (customers); policies and claims follow (about 1.7 policies per customer and
-- 1.5 claims per policy; 15% of customers have no policy). It can be run again: new rows get ids after the existing ones, and a policy
-- that already has claims gets no more.
--
-- Not uniform on purpose, like the PostgreSQL version of this script: about 20% of customers have no email, 10% of policies no premium,
-- a tenth of the policies start on the last day of a month, claims land at any time of day (some at the end of a month), about a third of
-- the claims are open and unpaid, and a third have no adjuster note. Those are the rows legacy Oracle queries get wrong after a migration.
-- The generator is seeded, so the same script gives the same data.

DECLARE
    first_names SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('Asha','Brightline','Carlos','Dunmore','Eli','Farah','Gita','Hiro','Ines','Jonas','Kiran','Lumen','Mara','Nikhil','Olga','Priya');
    last_names  SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('Rao','Logistics','Mendes','Foods','Park','Khan','Nair','Sato','Alvarez','Weber','Shah','Retail','Quinn','Das','Petrov','Menon');
    types       SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('AUTO','HOME','PROP','LIAB');
    notes       SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('rear bumper','water damage','storm','theft','glass','fire','pipe burst','hail','minor scratch','roof');
    cap         CONSTANT DATE := DATE '2026-10-22';
    v_base      NUMBER;
    v_id        NUMBER;
    v_count     PLS_INTEGER;
    v_eff       DATE;
    v_exp       DATE;
    v_span      NUMBER;
    v_when      DATE;
    v_amount    NUMBER;
    v_open      BOOLEAN;
BEGIN
    DBMS_RANDOM.SEED(42);

    -- 1. customers
    SELECT NVL(MAX(cust_id), 0) INTO v_base FROM cust_mst;
    FOR g IN 1..200 LOOP
        INSERT INTO cust_mst (cust_id, cust_nm, cust_email, segmt_cd, join_dt)
        VALUES (v_base + g,
                first_names(1 + MOD(g, 16)) || ' ' || last_names(1 + MOD(TRUNC(g / 16), 16)),
                CASE WHEN DBMS_RANDOM.VALUE < 0.20 THEN NULL ELSE 'customer' || (v_base + g) || '@example.com' END,
                CASE WHEN DBMS_RANDOM.VALUE < 0.30 THEN 'COM' ELSE 'RET' END,
                DATE '2018-01-01' + TRUNC(DBMS_RANDOM.VALUE(0, 2800)));
    END LOOP;

    -- 2. policies: 0 to 3 per customer that has none yet
    SELECT NVL(MAX(polcy_id), 0) INTO v_id FROM polcy_hdr;
    FOR c IN (SELECT cust_id FROM cust_mst m WHERE NOT EXISTS (SELECT 1 FROM polcy_hdr p WHERE p.cust_id = m.cust_id) ORDER BY cust_id) LOOP
        v_count := CASE WHEN DBMS_RANDOM.VALUE < 0.15 THEN 0 ELSE 1 + TRUNC(DBMS_RANDOM.VALUE(0, 3)) END;
        FOR k IN 1..v_count LOOP
            v_eff := DATE '2024-01-01' + TRUNC(DBMS_RANDOM.VALUE(0, 1035));
            IF DBMS_RANDOM.VALUE < 0.10 THEN v_eff := LAST_DAY(v_eff); END IF;       -- last day of a month
            v_id := v_id + 1;
            INSERT INTO polcy_hdr (polcy_id, cust_id, polcy_typ_cd, eff_dt, exp_dt, annl_prem, stat_cd)
            VALUES (v_id, c.cust_id, types(1 + TRUNC(DBMS_RANDOM.VALUE(0, 4))), v_eff, ADD_MONTHS(v_eff, 12) - 1,
                    CASE WHEN DBMS_RANDOM.VALUE < 0.10 THEN NULL ELSE ROUND(300 + DBMS_RANDOM.VALUE * 14000, 2) END,
                    CASE WHEN DBMS_RANDOM.VALUE < 0.85 THEN 'AC' ELSE 'LP' END);
        END LOOP;
    END LOOP;

    -- 3. claims: 0 to 3 per policy that has none yet and has started by 22 Oct 2026, dated within the policy's term and not after that day
    SELECT NVL(MAX(clm_id), 0) INTO v_id FROM clm_dtl;
    FOR p IN (SELECT polcy_id, eff_dt, exp_dt FROM polcy_hdr h WHERE h.eff_dt <= cap AND NOT EXISTS (SELECT 1 FROM clm_dtl k WHERE k.polcy_id = h.polcy_id) ORDER BY polcy_id) LOOP
        v_span := GREATEST(0, TRUNC(LEAST(p.exp_dt, cap) - p.eff_dt));
        FOR k IN 1..TRUNC(DBMS_RANDOM.VALUE(0, 4)) LOOP
            v_when := p.eff_dt + TRUNC(DBMS_RANDOM.VALUE(0, v_span + 1));
            IF DBMS_RANDOM.VALUE < 0.08 THEN
                -- the last second of a month
                v_when := LEAST(LAST_DAY(TRUNC(v_when)) + NUMTODSINTERVAL(86399, 'SECOND'), p.exp_dt + NUMTODSINTERVAL(86399, 'SECOND'), cap + NUMTODSINTERVAL(86399, 'SECOND'));
            ELSE
                v_when := v_when + NUMTODSINTERVAL(TRUNC(DBMS_RANDOM.VALUE(0, 86400)), 'SECOND');
            END IF;
            v_amount := ROUND(50 + POWER(DBMS_RANDOM.VALUE, 3) * 20000, 2);
            v_open := DBMS_RANDOM.VALUE < 0.35;
            v_id := v_id + 1;
            INSERT INTO clm_dtl (clm_id, polcy_id, clm_dt, clm_amt, clm_stat_cd, adj_note, paid_amt)
            VALUES (v_id, p.polcy_id, v_when, v_amount,
                    CASE WHEN v_open THEN 'OP' ELSE 'CL' END,
                    CASE WHEN DBMS_RANDOM.VALUE < 0.33 THEN NULL ELSE notes(1 + TRUNC(DBMS_RANDOM.VALUE(0, 10))) END,
                    CASE WHEN v_open THEN NULL ELSE ROUND(v_amount * (0.6 + DBMS_RANDOM.VALUE * 0.4), 2) END);
        END LOOP;
    END LOOP;
    COMMIT;
END;
/

-- what you got
SELECT (SELECT COUNT(*) FROM cust_mst)                                    AS customers,
       (SELECT COUNT(*) FROM cust_mst WHERE cust_email IS NULL)           AS customers_without_email,
       (SELECT COUNT(*) FROM cust_mst c WHERE NOT EXISTS (SELECT 1 FROM polcy_hdr p WHERE p.cust_id = c.cust_id)) AS customers_without_policy,
       (SELECT COUNT(*) FROM polcy_hdr)                                   AS policies,
       (SELECT COUNT(*) FROM polcy_hdr WHERE stat_cd = 'LP')              AS lapsed_policies,
       (SELECT COUNT(*) FROM clm_dtl)                                     AS claims,
       (SELECT COUNT(*) FROM clm_dtl WHERE clm_stat_cd = 'OP')            AS open_claims
FROM dual;
