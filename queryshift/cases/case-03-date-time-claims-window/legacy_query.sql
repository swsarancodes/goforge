SELECT *
FROM (
    SELECT cl.CLM_ID,
           p.POLCY_ID,
           TRUNC(cl.CLM_DT)            AS CLM_DAY,
           cl.CLM_DT - p.EFF_DT        AS DAYS_TO_CLAIM,
           ADD_MONTHS(p.EFF_DT, 6)     AS REVIEW_DT,
           cl.CLM_AMT
    FROM CLM_DTL cl
    JOIN POLCY_HDR p ON p.POLCY_ID = cl.POLCY_ID
    WHERE TRUNC(cl.CLM_DT) BETWEEN TO_DATE('2026-03-01', 'YYYY-MM-DD')
                               AND TO_DATE('2026-03-31', 'YYYY-MM-DD')
    ORDER BY cl.CLM_AMT DESC, cl.CLM_ID
)
WHERE ROWNUM <= 5
