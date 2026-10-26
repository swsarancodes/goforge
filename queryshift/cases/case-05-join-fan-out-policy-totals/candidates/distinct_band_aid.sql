SELECT p.policy_id AS polcy_id,
       p.policy_type AS polcy_typ_cd,
       COALESCE(cl.clm_tot, 0) AS clm_tot,
       COALESCE(SUM(DISTINCT v.limit_amount), 0) AS limit_tot,
       COUNT(v.coverage_id) AS covr_cnt
FROM policies AS p
LEFT JOIN coverages AS v ON v.policy_id = p.policy_id
LEFT JOIN (SELECT policy_id, SUM(claim_amount) AS clm_tot
           FROM claims
           GROUP BY policy_id) AS cl ON cl.policy_id = p.policy_id
WHERE p.status_code = 'AC'
GROUP BY p.policy_id, p.policy_type, cl.clm_tot
ORDER BY p.policy_id
