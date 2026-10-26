-- Synthetic data for the 10-table legacy Oracle insurer (schema_oracle.sql / schema.dbml). Everything is invented.
-- Run the whole script on the SQL page: it splits it, and the PL/SQL block ends at the line holding only /.
--
-- How many rows: change the 200 after n_customers. Everything else follows from the customers: about 1.3 addresses and 1.7 policies
-- each (15% of customers have no policy), 2.7 coverages and 6 premium payments per policy, 1.5 claims per policy, and a payment or
-- two on each closed claim (about 3,900 rows in all with 200 customers). The reference tables (12 agents, 8 products, 10 adjusters) are filled once, when empty.
-- It can be run again: new customers and their rows get ids after the existing ones, and a customer, policy or claim that already
-- has its rows gets no more. The generator is seeded, so the same script gives the same data on an empty database.
--
-- Not uniform on purpose, because those are the rows legacy Oracle queries get wrong after a migration: about 20% of customers have
-- no email, 10% of policies have no premium, 20% of policies were sold direct (no agent), a tenth of the policies start on the last day
-- of a month, claims land at any time of day (some on the last second of a month), a third of the claims are open and unpaid, 5% are
-- denied, a third have no adjuster note, a zip code can start with 0, two surnames carry an apostrophe or an accent, one product
-- description is thousands of characters long, and a premium payment is stamped to the millisecond.

DECLARE
    n_customers  CONSTANT PLS_INTEGER := 200;
    cap          CONSTANT DATE := DATE '2026-10-22';

    first_names  SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('Asha','Brightline','Carlos','Dunmore','Eli','Farah','Gita','Hiro','Ines','Jonas','Kiran','Lumen','Mara','Nikhil','Olga','Priya');
    last_names   SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('Rao','Logistics','Mendes','D''Souza','Park','Khan','Nair','Sato','Alvarez','Müller','Shah','Retail','Quinn','Das','Petrov','Menon');
    regions      SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('NE','SO','EA','WE');
    cities       SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('Springfield','Riverton','Lakeside','Fairview','Georgetown','Madison','Clinton','Salem');
    states       SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('IL','TX','MN','OH','DC','WI','NY','OR');
    streets      SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('Oak Street','Maple Avenue','Cedar Lane','Elm Road','Pine Court','Birch Way','Lake Drive','Hill Boulevard');
    notes        SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('rear bumper','water damage','storm','theft','glass','fire','pipe burst','hail','minor scratch','roof');
    methods      SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('CC','CC','ACH','ACH','CHK');
    auto_cov     SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('LIAB','COLL','COMP','MED');
    home_cov     SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('DWLG','PERS','LIAB','CONT');
    prop_cov     SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('PROP','LIAB','CONT');
    liab_cov     SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('LIAB','MED');
    cov          SYS.ODCIVARCHAR2LIST;

    TYPE t_numbers IS TABLE OF NUMBER INDEX BY PLS_INTEGER;
    TYPE t_texts   IS TABLE OF VARCHAR2(4) INDEX BY PLS_INTEGER;
    agent_ids    t_numbers;
    adjuster_ids t_numbers;
    product_ids  t_numbers;
    product_prem t_numbers;
    product_type t_texts;

    v_base       NUMBER;
    v_id         NUMBER;
    v_count      PLS_INTEGER;
    v_pick       PLS_INTEGER;
    v_eff        DATE;
    v_span       NUMBER;
    v_when       DATE;
    v_amount     NUMBER;
    v_status     VARCHAR2(2);
    v_periods    PLS_INTEGER;
    v_part       NUMBER;
    v_adjuster   NUMBER;
    v_agent      NUMBER;
BEGIN
    DBMS_RANDOM.SEED(42);

    -- 0. reference tables, filled once
    SELECT COUNT(*) INTO v_count FROM agnt_mst;
    IF v_count = 0 THEN
        FOR g IN 1..12 LOOP
            INSERT INTO agnt_mst (agnt_id, agnt_nm, regn_cd, hire_dt, comm_pct, actv_flg)
            VALUES (g, first_names(1 + MOD(g * 3, 16)) || ' ' || last_names(1 + MOD(g * 5, 16)), regions(1 + MOD(g, 4)),
                    DATE '2010-01-01' + TRUNC(DBMS_RANDOM.VALUE(0, 4700)), ROUND(3 + DBMS_RANDOM.VALUE * 9, 2),
                    CASE WHEN g IN (4, 11) THEN 'N' ELSE 'Y' END);
        END LOOP;
    END IF;
    SELECT agnt_id BULK COLLECT INTO agent_ids FROM agnt_mst ORDER BY agnt_id;

    SELECT COUNT(*) INTO v_count FROM prod_mst;
    IF v_count = 0 THEN
        INSERT INTO prod_mst (prod_id, prod_nm, polcy_typ_cd, base_prem, prod_desc, lnch_dt, actv_flg) VALUES (1, 'Standard Auto',     'AUTO',  900, 'Liability and collision for one car.',  DATE '2012-03-01', 'Y');
        INSERT INTO prod_mst (prod_id, prod_nm, polcy_typ_cd, base_prem, prod_desc, lnch_dt, actv_flg) VALUES (2, 'Premium Auto',      'AUTO', 1600, NULL,                                         DATE '2016-09-15', 'Y');
        INSERT INTO prod_mst (prod_id, prod_nm, polcy_typ_cd, base_prem, prod_desc, lnch_dt, actv_flg) VALUES (3, 'Starter Home',      'HOME', 1100, 'Dwelling cover for a first home.',           DATE '2013-05-20', 'Y');
        INSERT INTO prod_mst (prod_id, prod_nm, polcy_typ_cd, base_prem, prod_desc, lnch_dt, actv_flg) VALUES (4, 'Complete Home',     'HOME', 2400, TO_CLOB(RPAD('Dwelling, contents and liability, with every optional extra. ', 3000, 'And more cover. ')) || TO_CLOB(RPAD(' Claims are handled within ten days. ', 3000, 'Ask your agent. ')), DATE '2018-01-10', 'Y');
        INSERT INTO prod_mst (prod_id, prod_nm, polcy_typ_cd, base_prem, prod_desc, lnch_dt, actv_flg) VALUES (5, 'Property Basic',    'PROP', 1300, 'Buildings for small landlords.',             DATE '2011-11-02', 'Y');
        INSERT INTO prod_mst (prod_id, prod_nm, polcy_typ_cd, base_prem, prod_desc, lnch_dt, actv_flg) VALUES (6, 'Property Plus',     'PROP', 3100, NULL,                                         NULL,              'Y');
        INSERT INTO prod_mst (prod_id, prod_nm, polcy_typ_cd, base_prem, prod_desc, lnch_dt, actv_flg) VALUES (7, 'General Liability', 'LIAB',  700, 'Public liability for small businesses.',      DATE '2014-07-07', 'Y');
        INSERT INTO prod_mst (prod_id, prod_nm, polcy_typ_cd, base_prem, prod_desc, lnch_dt, actv_flg) VALUES (8, 'Umbrella Liability','LIAB', 1900, 'Retired in 2022.',                           DATE '2015-02-28', 'N');
    END IF;
    SELECT prod_id, base_prem, polcy_typ_cd BULK COLLECT INTO product_ids, product_prem, product_type FROM prod_mst ORDER BY prod_id;

    SELECT COUNT(*) INTO v_count FROM adjstr_mst;
    IF v_count = 0 THEN
        FOR g IN 1..10 LOOP
            INSERT INTO adjstr_mst (adjstr_id, adjstr_nm, lcns_no, regn_cd, hire_dt)
            VALUES (g, first_names(1 + MOD(g * 7, 16)) || ' ' || last_names(1 + MOD(g * 3, 16)), 'ADJ-' || LPAD(g, 5, '0'), regions(1 + MOD(g, 4)),
                    DATE '2008-01-01' + TRUNC(DBMS_RANDOM.VALUE(0, 5000)));
        END LOOP;
    END IF;
    SELECT adjstr_id BULK COLLECT INTO adjuster_ids FROM adjstr_mst ORDER BY adjstr_id;

    -- 1. customers
    SELECT NVL(MAX(cust_id), 0) INTO v_base FROM cust_mst;
    FOR g IN 1..n_customers LOOP
        INSERT INTO cust_mst (cust_id, cust_nm, cust_email, segmt_cd, join_dt)
        VALUES (v_base + g,
                first_names(1 + MOD(g, 16)) || ' ' || last_names(1 + MOD(TRUNC(g / 16), 16)),
                CASE WHEN DBMS_RANDOM.VALUE < 0.20 THEN NULL ELSE 'customer' || (v_base + g) || '@example.com' END,
                CASE WHEN DBMS_RANDOM.VALUE < 0.30 THEN 'COM' ELSE 'RET' END,
                DATE '2018-01-01' + TRUNC(DBMS_RANDOM.VALUE(0, 2800)));
    END LOOP;

    -- 2. addresses: one or two for each customer that has none yet; the first is the primary one
    SELECT NVL(MAX(addr_id), 0) INTO v_id FROM cust_addr;
    FOR c IN (SELECT cust_id FROM cust_mst m WHERE NOT EXISTS (SELECT 1 FROM cust_addr a WHERE a.cust_id = m.cust_id) ORDER BY cust_id) LOOP
        FOR k IN 1..CASE WHEN DBMS_RANDOM.VALUE < 0.35 THEN 2 ELSE 1 END LOOP
            v_pick := 1 + TRUNC(DBMS_RANDOM.VALUE(0, 8));
            v_id := v_id + 1;
            INSERT INTO cust_addr (addr_id, cust_id, addr_typ_cd, addr_ln1, city_nm, state_cd, pstl_cd, prim_flg)
            VALUES (v_id, c.cust_id, CASE WHEN k = 1 THEN 'HM' ELSE 'BL' END,
                    (100 + TRUNC(DBMS_RANDOM.VALUE(0, 9800))) || ' ' || streets(1 + TRUNC(DBMS_RANDOM.VALUE(0, 8))),
                    cities(v_pick), states(v_pick),
                    CASE WHEN DBMS_RANDOM.VALUE < 0.05 THEN NULL ELSE LPAD(TRUNC(DBMS_RANDOM.VALUE(0, 99999)), 5, '0') END,
                    CASE WHEN k = 1 THEN 'Y' ELSE 'N' END);
        END LOOP;
    END LOOP;

    -- 3. policies: 0 to 3 for each customer that has none yet; the type is the product's
    SELECT NVL(MAX(polcy_id), 0) INTO v_id FROM polcy_hdr;
    FOR c IN (SELECT cust_id FROM cust_mst m WHERE NOT EXISTS (SELECT 1 FROM polcy_hdr p WHERE p.cust_id = m.cust_id) ORDER BY cust_id) LOOP
        v_count := CASE WHEN DBMS_RANDOM.VALUE < 0.15 THEN 0 ELSE 1 + TRUNC(DBMS_RANDOM.VALUE(0, 3)) END;
        FOR k IN 1..v_count LOOP
            v_eff := DATE '2024-01-01' + TRUNC(DBMS_RANDOM.VALUE(0, 1035));
            IF DBMS_RANDOM.VALUE < 0.10 THEN v_eff := LAST_DAY(v_eff); END IF;       -- last day of a month
            v_pick := product_ids.FIRST + TRUNC(DBMS_RANDOM.VALUE(0, product_ids.COUNT));
            v_agent := CASE WHEN DBMS_RANDOM.VALUE < 0.20 THEN NULL ELSE agent_ids(agent_ids.FIRST + TRUNC(DBMS_RANDOM.VALUE(0, agent_ids.COUNT))) END;   -- 20% sold direct
            v_amount := CASE WHEN DBMS_RANDOM.VALUE < 0.10 THEN NULL ELSE ROUND(product_prem(v_pick) * (0.7 + DBMS_RANDOM.VALUE * 1.3), 2) END;
            v_id := v_id + 1;
            INSERT INTO polcy_hdr (polcy_id, cust_id, polcy_typ_cd, eff_dt, exp_dt, annl_prem, stat_cd, agnt_id, prod_id)
            VALUES (v_id, c.cust_id, product_type(v_pick), v_eff, ADD_MONTHS(v_eff, 12) - 1, v_amount,
                    CASE WHEN DBMS_RANDOM.VALUE < 0.85 THEN 'AC' ELSE 'LP' END, v_agent, product_ids(v_pick));
        END LOOP;
    END LOOP;

    -- 4. coverages: two to four for each policy that has none yet
    SELECT NVL(MAX(covg_id), 0) INTO v_id FROM polcy_covg;
    FOR p IN (SELECT polcy_id, polcy_typ_cd FROM polcy_hdr h WHERE NOT EXISTS (SELECT 1 FROM polcy_covg v WHERE v.polcy_id = h.polcy_id) ORDER BY polcy_id) LOOP
        cov := CASE p.polcy_typ_cd WHEN 'AUTO' THEN auto_cov WHEN 'HOME' THEN home_cov WHEN 'PROP' THEN prop_cov ELSE liab_cov END;
        FOR k IN 1..LEAST(cov.COUNT, 2 + TRUNC(DBMS_RANDOM.VALUE(0, 3))) LOOP
            v_id := v_id + 1;
            INSERT INTO polcy_covg (covg_id, polcy_id, covg_cd, covg_lmt, dedct_amt)
            VALUES (v_id, p.polcy_id, cov(k), (10 + TRUNC(DBMS_RANDOM.VALUE(0, 90))) * 5000,
                    CASE WHEN DBMS_RANDOM.VALUE < 0.15 THEN NULL ELSE (1 + TRUNC(DBMS_RANDOM.VALUE(0, 10))) * 250 END);
        END LOOP;
    END LOOP;

    -- 5. premium payments: monthly, quarterly or yearly from the start of each policy that has none yet, up to 22 Oct 2026
    SELECT NVL(MAX(pmt_id), 0) INTO v_id FROM prem_pmt;
    FOR p IN (SELECT polcy_id, eff_dt, annl_prem FROM polcy_hdr h WHERE h.eff_dt <= cap AND NOT EXISTS (SELECT 1 FROM prem_pmt m WHERE m.polcy_id = h.polcy_id) ORDER BY polcy_id) LOOP
        v_periods := CASE WHEN DBMS_RANDOM.VALUE < 0.50 THEN 12 WHEN DBMS_RANDOM.VALUE < 0.60 THEN 4 ELSE 1 END;
        FOR k IN 0..v_periods - 1 LOOP
            v_when := ADD_MONTHS(p.eff_dt, k * (12 / v_periods));
            EXIT WHEN v_when > cap;
            v_id := v_id + 1;
            INSERT INTO prem_pmt (pmt_id, polcy_id, pmt_dt, pmt_amt, pmt_mthd_cd, pmt_stat_cd, pmt_ts)
            VALUES (v_id, p.polcy_id, v_when, ROUND(NVL(p.annl_prem, 1200) / v_periods, 2), methods(1 + TRUNC(DBMS_RANDOM.VALUE(0, 5))),
                    CASE WHEN DBMS_RANDOM.VALUE < 0.92 THEN 'OK' WHEN DBMS_RANDOM.VALUE < 0.75 THEN 'FL' ELSE 'RF' END,
                    CAST(v_when AS TIMESTAMP) + NUMTODSINTERVAL(TRUNC(DBMS_RANDOM.VALUE(0, 86400)) + TRUNC(DBMS_RANDOM.VALUE(0, 1000)) / 1000, 'SECOND'));
        END LOOP;
    END LOOP;

    -- 6. claims: 0 to 3 for each policy that has none yet and has started by 22 Oct 2026, dated within its term and not after that day
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
            v_status := CASE WHEN DBMS_RANDOM.VALUE < 0.35 THEN 'OP' WHEN DBMS_RANDOM.VALUE < 0.08 THEN 'DN' ELSE 'CL' END;
            v_adjuster := CASE WHEN v_status = 'OP' AND DBMS_RANDOM.VALUE < 0.40 THEN NULL ELSE adjuster_ids(adjuster_ids.FIRST + TRUNC(DBMS_RANDOM.VALUE(0, adjuster_ids.COUNT))) END;
            v_id := v_id + 1;
            INSERT INTO clm_dtl (clm_id, polcy_id, clm_dt, clm_amt, clm_stat_cd, adj_note, paid_amt, adjstr_id)
            VALUES (v_id, p.polcy_id, v_when, v_amount, v_status,
                    CASE WHEN DBMS_RANDOM.VALUE < 0.33 THEN NULL ELSE notes(1 + TRUNC(DBMS_RANDOM.VALUE(0, 10))) END,
                    CASE WHEN v_status = 'CL' THEN ROUND(v_amount * (0.6 + DBMS_RANDOM.VALUE * 0.4), 2) ELSE NULL END,
                    v_adjuster);
        END LOOP;
    END LOOP;

    -- 7. claim payments: one final payment, or a partial one and a final one, for each closed claim that has none yet
    SELECT NVL(MAX(pymt_id), 0) INTO v_id FROM clm_pymt;
    FOR k IN (SELECT clm_id, clm_dt, paid_amt, adjstr_id FROM clm_dtl d WHERE d.clm_stat_cd = 'CL' AND d.paid_amt > 0 AND NOT EXISTS (SELECT 1 FROM clm_pymt y WHERE y.clm_id = d.clm_id) ORDER BY clm_id) LOOP
        v_when := TRUNC(LEAST(cap, k.clm_dt + TRUNC(DBMS_RANDOM.VALUE(3, 45))));
        IF DBMS_RANDOM.VALUE < 0.40 THEN
            v_part := ROUND(k.paid_amt * 0.6, 2);
            v_id := v_id + 1;
            INSERT INTO clm_pymt (pymt_id, clm_id, adjstr_id, pymt_dt, pymt_amt, pymt_typ_cd) VALUES (v_id, k.clm_id, k.adjstr_id, v_when, v_part, 'PRT');
            v_id := v_id + 1;
            INSERT INTO clm_pymt (pymt_id, clm_id, adjstr_id, pymt_dt, pymt_amt, pymt_typ_cd) VALUES (v_id, k.clm_id, k.adjstr_id, TRUNC(LEAST(cap, v_when + TRUNC(DBMS_RANDOM.VALUE(5, 40)))), k.paid_amt - v_part, 'FIN');
        ELSE
            v_id := v_id + 1;
            INSERT INTO clm_pymt (pymt_id, clm_id, adjstr_id, pymt_dt, pymt_amt, pymt_typ_cd) VALUES (v_id, k.clm_id, k.adjstr_id, v_when, k.paid_amt, 'FIN');
        END IF;
    END LOOP;
    COMMIT;
END;
/

-- what you got
SELECT (SELECT COUNT(*) FROM agnt_mst)   AS agents,
       (SELECT COUNT(*) FROM prod_mst)   AS products,
       (SELECT COUNT(*) FROM adjstr_mst) AS adjusters,
       (SELECT COUNT(*) FROM cust_mst)   AS customers,
       (SELECT COUNT(*) FROM cust_addr)  AS addresses,
       (SELECT COUNT(*) FROM polcy_hdr)  AS policies,
       (SELECT COUNT(*) FROM polcy_covg) AS coverages,
       (SELECT COUNT(*) FROM prem_pmt)   AS premium_payments,
       (SELECT COUNT(*) FROM clm_dtl)    AS claims,
       (SELECT COUNT(*) FROM clm_pymt)   AS claim_payments
FROM dual;
