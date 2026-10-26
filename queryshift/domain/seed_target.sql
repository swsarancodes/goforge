-- Synthetic data, loaded the way the migration would load it ('' from Oracle is NULL). Rows marked ADVERSARIAL are there on purpose.

INSERT INTO customers (customer_id, customer_name, email, segment_code, joined_on) VALUES
    (1, 'Asha Rao',             'asha.rao@example.com',     'RET', DATE '2019-04-12'),
    (2, 'Brightline Logistics', NULL,                       'COM', DATE '2020-11-03'),  -- ADVERSARIAL: NULL email
    (3, 'Carlos Mendes',        'carlos@example.com',       'RET', DATE '2022-01-31'),
    (4, 'Dunmore Foods',        'accounts@dunmore.example', 'COM', DATE '2023-07-19'),
    (5, 'Eli Park',             NULL,                       'RET', DATE '2024-02-29'),  -- ADVERSARIAL: no policies, NULL email
    (6, 'Farah Khan',           'farah@example.com',        'RET', DATE '2025-05-05'),
    (7, 'Gita Nair',            'gita@example.com',         'RET', DATE '2025-09-01');

INSERT INTO policies (policy_id, customer_id, policy_type, effective_date, expiry_date, annual_premium, status_code) VALUES
    (101, 1, 'AUTO', DATE '2026-01-01', DATE '2026-12-31', 1200.00, 'AC'),  -- ADVERSARIAL: exactly on the filter boundary
    (102, 1, 'HOME', DATE '2025-12-31', DATE '2026-12-30',  800.00, 'AC'),  -- ADVERSARIAL: one day before the boundary
    (103, 2, 'PROP', DATE '2026-02-28', DATE '2027-02-27', 5000.50, 'AC'),  -- ADVERSARIAL: last day of February (ADD_MONTHS)
    (104, 2, 'LIAB', DATE '2026-03-15', DATE '2027-03-14', NULL,    'AC'),  -- ADVERSARIAL: NULL premium
    (105, 3, 'AUTO', DATE '2026-01-31', DATE '2027-01-30',  950.00, 'AC'),
    (106, 4, 'PROP', DATE '2026-01-15', DATE '2027-01-14', 12000.00, 'AC'),
    (107, 4, 'PROP', DATE '2026-07-01', DATE '2027-06-30', 3000.00, 'LP'),  -- ADVERSARIAL: lapsed, no claims
    (108, 6, 'AUTO', DATE '2025-05-05', DATE '2026-05-04',  700.00, 'AC'),
    (109, 7, 'HOME', DATE '2026-04-10', DATE '2027-04-09',  640.00, 'LP');

INSERT INTO claims (claim_id, policy_id, claim_date, claim_amount, claim_status, adjuster_note, paid_amount) VALUES
    (9001, 101, TIMESTAMP '2026-02-10 09:15:00', 1500.00, 'CL', 'rear bumper',  1500.00),
    (9002, 101, TIMESTAMP '2026-03-31 16:45:00', 2200.00, 'OP', NULL,           NULL),     -- ADVERSARIAL: last day of March, afternoon
    (9003, 103, TIMESTAMP '2026-03-01 00:00:00', 4000.00, 'CL', 'water damage', 3500.00),  -- ADVERSARIAL: first instant of March
    (9004, 103, TIMESTAMP '2026-03-15 12:30:00',  800.25, 'OP', NULL,           NULL),
    (9005, 105, TIMESTAMP '2026-03-31 23:59:59',  300.00, 'CL', 'glass',         300.00),  -- ADVERSARIAL: last second of March
    (9006, 105, TIMESTAMP '2026-04-01 00:00:00', 6100.00, 'OP', 'pending',      NULL),     -- ADVERSARIAL: first instant of April
    (9007, 106, TIMESTAMP '2026-03-20 08:00:00', 9000.00, 'CL', 'fire',         8000.00),
    (9008, 106, TIMESTAMP '2026-03-20 08:00:00', 9000.00, 'OP', 'fire annex',   NULL),     -- ADVERSARIAL: same amount and time as 9007
    (9009, 108, TIMESTAMP '2026-03-10 10:00:00',  450.00, 'CL', 'theft',         450.00),
    (9010, 102, TIMESTAMP '2026-03-05 14:20:00',  700.00, 'CL', 'storm',         600.00),
    (9011, 104, TIMESTAMP '2026-03-31 00:00:00',  120.00, 'CL', 'minor',         120.00);  -- ADVERSARIAL: midnight at the start of March 31

-- Several coverages per policy, so a join to them multiplies the rows of a policy. Rows marked ADVERSARIAL are there on purpose.
INSERT INTO coverages (coverage_id, policy_id, coverage_type, limit_amount) VALUES
    (3001, 101, 'COLL',  50000.00),   -- policy 101: three coverages and two claims
    (3002, 101, 'LIAB', 100000.00),
    (3003, 101, 'GLAS',   1000.00),
    (3004, 102, 'FIRE', 200000.00),
    (3005, 102, 'THFT',  15000.00),
    (3006, 103, 'FIRE', 500000.00),
    (3007, 103, 'FLOD', 100000.00),
    -- ADVERSARIAL: policy 104 has no coverage at all (it still has a claim and must still be listed)
    (3008, 105, 'COLL',  40000.00),   -- ADVERSARIAL: one coverage and two claims: the coverage total doubles if claims are joined in
    (3009, 106, 'FIRE', 900000.00),   -- policy 106: four coverages and two claims
    (3010, 106, 'THFT',  30000.00),
    (3011, 106, 'LIAB', 250000.00),
    (3012, 106, 'FLOD',  60000.00),
    (3013, 108, 'COLL',  25000.00),   -- one coverage and one claim: a join does not inflate this one
    (3014, 107, 'FIRE', 300000.00),   -- ADVERSARIAL: on a lapsed policy, which the report leaves out
    (3015, 109, 'FIRE',  80000.00);   -- ADVERSARIAL: on a lapsed policy
