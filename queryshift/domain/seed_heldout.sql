-- HELD-OUT data: same schema, different rows. A translation is judged on this after it has passed on seed_target.sql, and nothing measured
-- here is ever shown to a model: if a query fails on this data, it goes to a human, it is not corrected against it. Written separately from
-- seed_target.sql; the reference results in each case's expected_heldout.csv were derived by hand from Oracle semantics before any query was run.
-- Customer ids 21-28, policy ids 201-208, claim ids 8001-8010: no id overlaps the primary data, so a query that hard-codes ids cannot pass both.

INSERT INTO customers (customer_id, customer_name, email, segment_code, joined_on) VALUES
    (21, 'Ines Alvarez', 'ines@example.com',   'RET', DATE '2021-03-08'),
    (22, 'Jonas Weber',  NULL,                 'COM', DATE '2020-06-30'),  -- NULL email, with policies and claims
    (23, 'Kiran Shah',   'kiran@example.com',  'RET', DATE '2022-12-01'),  -- no policies
    (24, 'Lumen Retail', NULL,                 'COM', DATE '2023-04-15'),  -- no policies, NULL email
    (25, 'Mara Quinn',   'mara@example.com',   'RET', DATE '2019-10-10'),  -- only a 2025 policy
    (26, 'Nikhil Das',   'nikhil@example.com', 'RET', DATE '2024-08-20'),  -- one lapsed and one active policy
    (27, 'Olga Petrov',  NULL,                 'RET', DATE '2025-01-05'),  -- NULL email, active policy with NULL premium, no claims
    (28, 'Priya Nair',   'priya@example.com',  'RET', DATE '2025-11-11');  -- only a lapsed 2026 policy

INSERT INTO policies (policy_id, customer_id, policy_type, effective_date, expiry_date, annual_premium, status_code) VALUES
    (201, 21, 'AUTO', DATE '2026-04-30', DATE '2027-04-29', 1000.00, 'AC'),  -- last day of April
    (202, 22, 'PROP', DATE '2026-01-01', DATE '2026-12-31', 2500.75, 'AC'),
    (203, 22, 'LIAB', DATE '2026-08-31', DATE '2027-08-30',  400.00, 'AC'),  -- last day of August
    (204, 25, 'HOME', DATE '2025-06-30', DATE '2026-06-29',  600.00, 'AC'),  -- last day of June, in 2025
    (205, 26, 'AUTO', DATE '2026-02-15', DATE '2027-02-14',  880.00, 'LP'),
    (206, 26, 'HOME', DATE '2026-03-01', DATE '2027-02-28', 1500.00, 'AC'),
    (207, 27, 'LIAB', DATE '2026-05-20', DATE '2027-05-19', NULL,    'AC'),
    (208, 28, 'AUTO', DATE '2026-02-01', DATE '2027-01-31',  700.00, 'LP');

INSERT INTO claims (claim_id, policy_id, claim_date, claim_amount, claim_status, adjuster_note, paid_amount) VALUES
    (8001, 202, TIMESTAMP '2026-03-02 09:00:00',  500.00, 'OP', NULL,      NULL),
    (8002, 202, TIMESTAMP '2026-03-31 23:00:00', 3200.00, 'CL', 'roof',    3000.00),  -- late on the last day of March
    (8003, 202, TIMESTAMP '2026-02-28 23:59:59',  150.00, 'CL', 'minor',    150.00),  -- last second of February
    (8004, 204, TIMESTAMP '2026-03-31 12:00:00', 3200.00, 'OP', 'flood',    NULL),     -- same amount as 8002
    (8005, 206, TIMESTAMP '2026-03-01 00:00:00',  700.00, 'CL', 'door',     700.00),  -- the day the policy starts
    (8006, 206, TIMESTAMP '2026-03-10 18:30:00', 1200.00, 'OP', 'pipe',     NULL),
    (8007, 205, TIMESTAMP '2026-03-31 10:00:00',   90.00, 'CL', 'scratch',   90.00),
    (8008, 205, TIMESTAMP '2026-04-02 08:00:00', 4000.00, 'OP', 'late',     NULL),     -- April
    (8009, 204, TIMESTAMP '2026-03-15 00:00:00', 2000.00, 'CL', 'hail',    1800.00),
    (8010, 202, TIMESTAMP '2026-03-20 14:15:00', 1000.00, 'OP', NULL,      NULL);
