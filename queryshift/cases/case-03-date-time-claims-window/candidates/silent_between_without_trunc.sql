-- Runs, returns five plausible rows. BETWEEN on the raw timestamp stops at midnight on March 31, so claims later that day (9002) are lost and a lower one (9010) takes its place.
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
           CASE WHEN p.effective_date = (date_trunc('month', p.effective_date) + INTERVAL '1 month - 1 day')::date
                THEN (date_trunc('month', p.effective_date + INTERVAL '6 months') + INTERVAL '1 month - 1 day')::date
                ELSE (p.effective_date + INTERVAL '6 months')::date
           END AS review_dt,
           cl.claim_amount
    FROM claims AS cl
    JOIN policies AS p ON p.policy_id = cl.policy_id
    WHERE cl.claim_date BETWEEN DATE '2026-03-01' AND DATE '2026-03-31'
    ORDER BY cl.claim_amount DESC, cl.claim_id
    LIMIT 5
) AS ranked
ORDER BY claim_amount DESC, claim_id
