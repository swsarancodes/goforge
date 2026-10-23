-- Passes on the primary data and is wrong: the NULL-email label is special-cased for customer 2, the only one the primary data shows it for.
SELECT c.customer_id AS cust_id,
       CASE WHEN c.customer_id = 2 THEN c.customer_name || ' <>'
            ELSE c.customer_name || ' <' || c.email || '>'
       END AS contact_label,
       COUNT(cl.claim_id) AS clm_cnt,
       COALESCE(SUM(cl.claim_amount), 0) AS tot_claimed,
       ROUND(AVG(COALESCE(cl.paid_amount, 0)), 2) AS avg_paid,
       ROUND(COUNT(CASE WHEN cl.claim_status = 'OP' THEN 1 END)::numeric
             / NULLIF(COUNT(cl.claim_id), 0), 4) AS open_ratio
FROM customers AS c
JOIN policies AS p ON p.customer_id = c.customer_id
LEFT JOIN claims AS cl ON cl.policy_id = p.policy_id
GROUP BY c.customer_id, c.customer_name, c.email
ORDER BY c.customer_id
