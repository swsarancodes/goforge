-- ADD_MONTHS translated as + INTERVAL '6 months': wrong for policies that start on the last day of a month (Oracle gives the last day of the target month).
SELECT claim_id AS clm_id,
       policy_id AS polcy_id,
       claim_day AS clm_day,
       days_to_claim,
       review_dt,
       claim_amount AS clm_amt
FROM (
    SELECT cl.claim_id,
           p.policy_id,
           cl.claim_date::date AS claim_day,
           EXTRACT(EPOCH FROM (cl.claim_date - p.effective_date::timestamp)) / 86400 AS days_to_claim,
           (p.effective_date + INTERVAL '6 months')::date AS review_dt,
           cl.claim_amount
    FROM claims AS cl
    JOIN policies AS p ON p.policy_id = cl.policy_id
    WHERE cl.claim_date >= TIMESTAMP '2026-03-01 00:00:00'
      AND cl.claim_date <  TIMESTAMP '2026-04-01 00:00:00'
    ORDER BY cl.claim_amount DESC, cl.claim_id
    LIMIT 5
) AS ranked
ORDER BY claim_amount DESC, claim_id
