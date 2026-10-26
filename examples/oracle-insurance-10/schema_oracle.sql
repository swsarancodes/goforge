-- A legacy Oracle insurer with 10 tables. All names and values are invented. Same schema as schema.dbml.
-- Use it two ways: paste it into File > New empty diagram (Oracle) and keep "Also create it as an Oracle database" on,
-- or run it on an empty Oracle database on the SQL page. CUST_MST, POLCY_HDR and CLM_DTL keep the columns of the small
-- insurance schema, so the Oracle queries written for that one still run; POLCY_HDR and CLM_DTL gain keys to the new tables.

CREATE TABLE AGNT_MST (
    AGNT_ID   NUMBER(10)     PRIMARY KEY,
    AGNT_NM   VARCHAR2(100)  NOT NULL,
    REGN_CD   VARCHAR2(3)    NOT NULL,                -- NE, SO, EA, WE
    HIRE_DT   DATE           NOT NULL,
    COMM_PCT  NUMBER(5,2)    NOT NULL,                -- commission, percent of premium
    ACTV_FLG  CHAR(1)        DEFAULT 'Y' NOT NULL     -- Y or N
);

CREATE TABLE PROD_MST (
    PROD_ID       NUMBER(10)    PRIMARY KEY,
    PROD_NM       VARCHAR2(80)  NOT NULL,
    POLCY_TYP_CD  VARCHAR2(4)   NOT NULL,             -- AUTO, HOME, PROP, LIAB
    BASE_PREM     NUMBER(12,2)  NOT NULL,
    PROD_DESC     CLOB,
    LNCH_DT       DATE,
    ACTV_FLG      CHAR(1)       DEFAULT 'Y' NOT NULL
);

CREATE TABLE ADJSTR_MST (
    ADJSTR_ID  NUMBER(10)     PRIMARY KEY,
    ADJSTR_NM  VARCHAR2(100)  NOT NULL,
    LCNS_NO    VARCHAR2(20)   NOT NULL UNIQUE,
    REGN_CD    VARCHAR2(3)    NOT NULL,
    HIRE_DT    DATE           NOT NULL
);

CREATE TABLE CUST_MST (
    CUST_ID     NUMBER(10)     PRIMARY KEY,
    CUST_NM     VARCHAR2(100)  NOT NULL,
    CUST_EMAIL  VARCHAR2(120),
    SEGMT_CD    VARCHAR2(3)    NOT NULL,              -- COM commercial, RET retail
    JOIN_DT     DATE           NOT NULL
);

CREATE TABLE CUST_ADDR (
    ADDR_ID      NUMBER(10)     PRIMARY KEY,
    CUST_ID      NUMBER(10)     NOT NULL REFERENCES CUST_MST (CUST_ID),
    ADDR_TYP_CD  VARCHAR2(2)    NOT NULL,             -- HM home, BL billing
    ADDR_LN1     VARCHAR2(120)  NOT NULL,
    CITY_NM      VARCHAR2(60)   NOT NULL,
    STATE_CD     CHAR(2)        NOT NULL,
    PSTL_CD      VARCHAR2(10),                        -- text, not a number: it can start with 0
    PRIM_FLG     CHAR(1)        DEFAULT 'N' NOT NULL
);

CREATE TABLE POLCY_HDR (
    POLCY_ID      NUMBER(10)    PRIMARY KEY,
    CUST_ID       NUMBER(10)    NOT NULL REFERENCES CUST_MST (CUST_ID),
    POLCY_TYP_CD  VARCHAR2(4)   NOT NULL,
    EFF_DT        DATE          NOT NULL,
    EXP_DT        DATE          NOT NULL,
    ANNL_PREM     NUMBER(12,2),
    STAT_CD       VARCHAR2(2)   NOT NULL,             -- AC active, LP lapsed
    AGNT_ID       NUMBER(10)    REFERENCES AGNT_MST (AGNT_ID),   -- empty for a policy sold direct
    PROD_ID       NUMBER(10)    NOT NULL REFERENCES PROD_MST (PROD_ID)
);

CREATE TABLE POLCY_COVG (
    COVG_ID    NUMBER(10)    PRIMARY KEY,
    POLCY_ID   NUMBER(10)    NOT NULL REFERENCES POLCY_HDR (POLCY_ID),
    COVG_CD    VARCHAR2(6)   NOT NULL,                -- LIAB, COLL, COMP, MED, DWLG, PERS, CONT, PROP
    COVG_LMT   NUMBER(12,2)  NOT NULL,
    DEDCT_AMT  NUMBER(10,2),
    CONSTRAINT UQ_POLCY_COVG UNIQUE (POLCY_ID, COVG_CD)
);

CREATE TABLE PREM_PMT (
    PMT_ID       NUMBER(10)    PRIMARY KEY,
    POLCY_ID     NUMBER(10)    NOT NULL REFERENCES POLCY_HDR (POLCY_ID),
    PMT_DT       DATE          NOT NULL,
    PMT_AMT      NUMBER(12,2)  NOT NULL,
    PMT_MTHD_CD  VARCHAR2(3)   NOT NULL,              -- CC card, ACH, CHK cheque
    PMT_STAT_CD  VARCHAR2(2)   NOT NULL,              -- OK paid, FL failed, RF refunded
    PMT_TS       TIMESTAMP(3)  NOT NULL               -- when the payment arrived, to the millisecond
);

CREATE TABLE CLM_DTL (
    CLM_ID       NUMBER(10)    PRIMARY KEY,
    POLCY_ID     NUMBER(10)    NOT NULL REFERENCES POLCY_HDR (POLCY_ID),
    CLM_DT       DATE          NOT NULL,              -- includes the time of day
    CLM_AMT      NUMBER(12,2)  NOT NULL,
    CLM_STAT_CD  VARCHAR2(2)   NOT NULL,              -- OP open, CL closed, DN denied
    ADJ_NOTE     VARCHAR2(200),
    PAID_AMT     NUMBER(12,2),
    ADJSTR_ID    NUMBER(10)    REFERENCES ADJSTR_MST (ADJSTR_ID)  -- empty until an adjuster is assigned
);

CREATE TABLE CLM_PYMT (
    PYMT_ID      NUMBER(10)    PRIMARY KEY,
    CLM_ID       NUMBER(10)    NOT NULL REFERENCES CLM_DTL (CLM_ID),
    ADJSTR_ID    NUMBER(10)    REFERENCES ADJSTR_MST (ADJSTR_ID),
    PYMT_DT      DATE          NOT NULL,
    PYMT_AMT     NUMBER(12,2)  NOT NULL,
    PYMT_TYP_CD  VARCHAR2(3)   NOT NULL               -- PRT partial, FIN final
);

-- indexes and rules the migration to PostgreSQL does not carry over, so its checklist has something to show
CREATE INDEX IX_POLCY_CUST ON POLCY_HDR (CUST_ID);
CREATE INDEX IX_POLCY_AGNT ON POLCY_HDR (AGNT_ID);
CREATE INDEX IX_PMT_POLCY  ON PREM_PMT (POLCY_ID);
CREATE INDEX IX_CLM_POLCY  ON CLM_DTL (POLCY_ID);
ALTER TABLE POLCY_HDR ADD CONSTRAINT CK_POLCY_DATES CHECK (EXP_DT >= EFF_DT);
ALTER TABLE CLM_DTL   ADD CONSTRAINT CK_CLM_AMT CHECK (CLM_AMT >= 0);
