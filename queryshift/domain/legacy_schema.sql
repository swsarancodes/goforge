-- Synthetic Oracle schema for a retail insurer. All names and values are invented.
-- Oracle DATE columns carry a time of day (to the second); that matters for case 3.

CREATE TABLE CUST_MST (
    CUST_ID     NUMBER(10)     PRIMARY KEY,
    CUST_NM     VARCHAR2(100)  NOT NULL,
    CUST_EMAIL  VARCHAR2(120),
    SEGMT_CD    VARCHAR2(3)    NOT NULL,
    JOIN_DT     DATE           NOT NULL
);

CREATE TABLE POLCY_HDR (
    POLCY_ID      NUMBER(10)    PRIMARY KEY,
    CUST_ID       NUMBER(10)    NOT NULL REFERENCES CUST_MST (CUST_ID),
    POLCY_TYP_CD  VARCHAR2(4)   NOT NULL,
    EFF_DT        DATE          NOT NULL,
    EXP_DT        DATE          NOT NULL,
    ANNL_PREM     NUMBER(12,2),
    STAT_CD       VARCHAR2(2)   NOT NULL   -- AC active, LP lapsed
);

CREATE TABLE CLM_DTL (
    CLM_ID        NUMBER(10)    PRIMARY KEY,
    POLCY_ID      NUMBER(10)    NOT NULL REFERENCES POLCY_HDR (POLCY_ID),
    CLM_DT        DATE          NOT NULL,   -- includes time of day
    CLM_AMT       NUMBER(12,2)  NOT NULL,
    CLM_STAT_CD   VARCHAR2(2)   NOT NULL,   -- OP open, CL closed
    ADJ_NOTE      VARCHAR2(200),
    PAID_AMT      NUMBER(12,2)
);

CREATE TABLE COVERAGE (
    COVR_ID         NUMBER(10)    PRIMARY KEY,
    POLCY_ID        NUMBER(10)    NOT NULL REFERENCES POLCY_HDR (POLCY_ID),   -- several coverages per policy
    COVR_TYP_CD     VARCHAR2(4)   NOT NULL,
    COVR_LIMIT_AMT  NUMBER(12,2)  NOT NULL
);
