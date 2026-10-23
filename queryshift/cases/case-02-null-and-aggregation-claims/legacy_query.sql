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
