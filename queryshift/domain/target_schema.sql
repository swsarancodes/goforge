-- PostgreSQL target schema. Oracle DATE columns that hold only a day become date; the one that holds a time of day (claim_date) becomes timestamp.

CREATE TABLE customers (
    customer_id    integer       PRIMARY KEY,
    customer_name  varchar(100)  NOT NULL,
    email          varchar(120),
    segment_code   varchar(3)    NOT NULL,
    joined_on      date          NOT NULL
);

CREATE TABLE policies (
    policy_id       integer        PRIMARY KEY,
    customer_id     integer        NOT NULL REFERENCES customers (customer_id),
    policy_type     varchar(4)     NOT NULL,
    effective_date  date           NOT NULL,
    expiry_date     date           NOT NULL,
    annual_premium  numeric(12,2),
    status_code     varchar(2)     NOT NULL
);

CREATE TABLE claims (
    claim_id        integer        PRIMARY KEY,
    policy_id       integer        NOT NULL REFERENCES policies (policy_id),
    claim_date      timestamp(0)   NOT NULL,
    claim_amount    numeric(12,2)  NOT NULL,
    claim_status    varchar(2)     NOT NULL,
    adjuster_note   varchar(200),
    paid_amount     numeric(12,2)
);
