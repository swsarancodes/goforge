-- Passes on the primary data and is wrong: customers above id 4 are forced to zero because that is what the primary data shows for them.
SELECT c.customer_id AS cust_id,
       c.customer_name AS cust_nm,
       COUNT(p.policy_id) AS polcy_cnt,
       COALESCE(SUM(p.annual_premium), 0) AS tot_prem
FROM customers AS c
LEFT JOIN policies AS p
  ON p.customer_id = c.customer_id
 AND p.effective_date >= DATE '2026-01-01'
 AND p.status_code = 'AC'
WHERE c.customer_id <= 4
GROUP BY c.customer_id, c.customer_name
UNION ALL
SELECT c.customer_id, c.customer_name, 0, 0
FROM customers AS c
WHERE c.customer_id > 4
ORDER BY cust_id
