SELECT p.policy_id AS polcy_id,
       p.policy_type AS polcy_typ_cd,
       COALESCE(cl.clm_tot, 0) AS clm_tot,
       COALESCE(cv.limit_tot, 0) AS limit_tot,
       COALESCE(cv.covr_cnt, 0) AS covr_cnt
FROM policies AS p
LEFT JOIN (SELECT policy_id, SUM(claim_amount) AS clm_tot
           FROM claims
           GROUP BY policy_id) AS cl ON cl.policy_id = p.policy_id
LEFT JOIN (SELECT policy_id, SUM(limit_amount) AS limit_tot, COUNT(*) AS covr_cnt
           FROM coverages
           GROUP BY policy_id) AS cv ON cv.policy_id = p.policy_id
WHERE p.status_code = 'AC'
ORDER BY p.policy_id DESC
