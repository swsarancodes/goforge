import type { SchemaContext } from "../../types";

/**
 * The database the corpus runs against. Small on purpose: every expected result can be checked by hand.
 * Dates are fixed so that no result depends on when the corpus is run.
 */
export const FIXTURE_SQL = `
DROP TABLE IF EXISTS benefit, ord, emp, dept CASCADE;
DROP SEQUENCE IF EXISTS emp_seq;

CREATE TABLE dept (id int PRIMARY KEY, name text NOT NULL);
INSERT INTO dept VALUES (1, 'Engineering'), (2, 'Sales'), (3, 'HR'), (4, 'Ghost');

CREATE TABLE emp (
  id int PRIMARY KEY,
  name text NOT NULL,
  dept_id int REFERENCES dept (id),
  mgr_id int,
  salary numeric(10,2) NOT NULL,
  bonus numeric(10,2),
  status char(1),
  hired date NOT NULL,
  email text,
  region text
);
INSERT INTO emp VALUES
  (1, 'Alice', 1, NULL, 9000, 500, 'A', '2015-03-15', 'alice@x.com', 'EU'),
  (2, 'Bob',   1, 1,    7000, NULL, 'A', '2018-07-01', 'bob@x.com',   'US'),
  (3, 'Carol', 2, 1,    6000, 300, 'L', '2019-11-30', 'carol@x.com', 'EU'),
  (4, 'Dave',  2, 3,    5000, NULL, 'T', '2020-02-29', 'dave@x.com',  NULL),
  (5, 'Eve',   NULL, 1, 8000, 100, NULL, '2021-01-31', 'eve@x.com',   'US'),
  (6, 'Frank', 3, 1,    4000, 0,    'A', '2022-06-15', NULL,          'EU');

CREATE TABLE benefit (emp_id int NOT NULL, plan text NOT NULL, coverage_end date NOT NULL);
INSERT INTO benefit VALUES (1, 'Gold', '2030-01-01'), (1, 'Dental', '2020-01-01'), (2, 'Silver', '2030-01-01'), (3, 'Gold', '2019-01-01');

CREATE TABLE ord (id int PRIMARY KEY, emp_id int, total numeric(10,2), placed date NOT NULL);
INSERT INTO ord VALUES (1, 1, 100.50, '2024-01-10'), (2, 1, 200.00, '2024-02-20'), (3, 2, 50.25, '2024-03-05'), (4, 3, 300.00, '2023-12-31'), (5, 3, NULL, '2024-04-01');

CREATE SEQUENCE emp_seq START 100;
`;

/** The same tables as the SQL above, as the engine receives them (names and types only). Kept by hand; the corpus runner checks it against the database. */
export const FIXTURE_SCHEMA: SchemaContext = {
    tables: [
        { name: "benefit", columns: [{ name: "emp_id", type: "integer", nullable: false }, { name: "plan", type: "text", nullable: false }, { name: "coverage_end", type: "date", nullable: false }] },
        { name: "dept", columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }, { name: "name", type: "text", nullable: false }] },
        {
            name: "emp",
            columns: [
                { name: "id", type: "integer", nullable: false, isPrimary: true },
                { name: "name", type: "text", nullable: false },
                { name: "dept_id", type: "integer", nullable: true },
                { name: "mgr_id", type: "integer", nullable: true },
                { name: "salary", type: "numeric", nullable: false },
                { name: "bonus", type: "numeric", nullable: true },
                { name: "status", type: "character", nullable: true },
                { name: "hired", type: "date", nullable: false },
                { name: "email", type: "text", nullable: true },
                { name: "region", type: "text", nullable: true },
            ],
        },
        { name: "ord", columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }, { name: "emp_id", type: "integer", nullable: true }, { name: "total", type: "numeric", nullable: true }, { name: "placed", type: "date", nullable: false }] },
    ],
};
