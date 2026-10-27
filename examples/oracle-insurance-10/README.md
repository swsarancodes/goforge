# A 10-table legacy Oracle insurer

An invented insurer with ten tables, for trying the Oracle to PostgreSQL migration on something bigger than three tables. The first three tables (`CUST_MST`, `POLCY_HDR`, `CLM_DTL`) have the columns of the small insurance schema, so the Oracle queries written for that one still run.

| File | What it is |
|---|---|
| `schema.dbml` | The schema as DBML: import it with File, Import Project (.json, .dbml, .drawio), and pick Oracle |
| `schema_oracle.sql` | The same schema as Oracle DDL: paste it into File, New empty diagram (Oracle), with "Also create it as an Oracle database" on |
| `generate_data_oracle.sql` | Synthetic data for all ten tables: run it on the SQL page, on the Oracle database |

Tables: `AGNT_MST` (agents), `PROD_MST` (products), `ADJSTR_MST` (adjusters), `CUST_MST` (customers), `CUST_ADDR` (addresses), `POLCY_HDR` (policies), `POLCY_COVG` (coverages), `PREM_PMT` (premium payments), `CLM_DTL` (claims), `CLM_PYMT` (claim payments). Ten foreign keys, four indexes and two CHECK constraints; the indexes and CHECKs are what the migration leaves behind, so its checklist has something to show.

With the default 200 customers it makes 12 agents, 8 products, 10 adjusters, 200 customers, 255 addresses, 338 policies, 908 coverages, 1,961 premium payments, 508 claims and 411 claim payments: 4,611 rows (measured on an empty database). Change `n_customers` at the top of the script for more or fewer. It is seeded, so an empty database always gets the same rows, and it can be run again to add more.

The data is awkward on purpose: missing emails and premiums, policies sold direct, claims at any time of day and on the last second of a month, open and denied claims, zip codes that start with 0, a surname with an apostrophe and one with an accent, a product description of thousands of characters, and payments stamped to the millisecond.

`server/src/services/oracle-insurance-10.integration.test.ts` builds it on a real Oracle, fills it, runs the generator twice, and migrates the result to PostgreSQL with the proof passing (set `ORACLE_TEST_ADMIN_URL` and `PG_TEST_ADMIN_URL`). `src/features/database/oracle-insurance-10.test.ts` checks that the DBML imports and matches the DDL.

Five complex queries written for it, with what the converter does to each one, are in [docs/oracle-insurance-queries.md](../../docs/oracle-insurance-queries.md).
