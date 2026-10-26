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
