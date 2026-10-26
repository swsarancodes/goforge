SELECT p.policy_id AS polcy_id,
       p.policy_type AS polcy_typ_cd,
       COALESCE(SUM(c.claim_amount), 0) AS clm_tot,
       COALESCE(SUM(v.limit_amount), 0) AS limit_tot,
       COUNT(v.coverage_id) AS covr_cnt
FROM policies AS p
LEFT JOIN claims AS c ON c.policy_id = p.policy_id
LEFT JOIN coverages AS v ON v.policy_id = p.policy_id
WHERE p.status_code = 'AC'
GROUP BY p.policy_id, p.policy_type
ORDER BY p.policy_id
