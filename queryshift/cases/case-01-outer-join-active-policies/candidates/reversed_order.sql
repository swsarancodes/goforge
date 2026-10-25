SELECT c.customer_id AS cust_id,
       c.customer_name AS cust_nm,
       COUNT(p.policy_id) AS polcy_cnt,
       COALESCE(SUM(p.annual_premium), 0) AS tot_prem
FROM customers AS c
LEFT JOIN policies AS p
  ON p.customer_id = c.customer_id
 AND p.effective_date >= DATE '2026-01-01'
 AND p.status_code = 'AC'
GROUP BY c.customer_id, c.customer_name
ORDER BY c.customer_id DESC
