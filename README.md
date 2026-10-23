# Welcome to GoForge ⚡

GoForge is a **free, open-source database schema diagram generator** — design your database visually and export it as production-ready SQL DDL in your preferred dialect: **MySQL, PostgreSQL, MariaDB, SQLite, Oracle, or SQL Server**.

## Main features

-  **Interactive Diagram UI** – Visually design and manage your database schemas with an intuitive drag-and-drop interface.
-  **In-Depth Tables & Columns Control** – Fully customize tables, columns, types, and constraints.
-  **Index Suggestions** – Receive recommendations to optimize database performance.
-  **Import / Export SQL DDL** – Easily import existing schemas or export your design as SQL scripts, and edit the generated SQL directly to update the diagram.
-  **Foreign Key Cycle Detection** – Identify and resolve circular dependencies in relationships.
-  **Live Database Connections** – Connect to a real PostgreSQL database, introspect its schema onto the canvas, and push edits back to it.
-  **AI Schema Assistant** – Describe schema changes in plain language, review a validated operation plan and migration SQL, then explicitly apply it as one local transaction.
-  **Query Modernizer** – Rewrite a query written for Oracle, SQL Server, MySQL or DB2 so it runs on PostgreSQL with named, tested rules. It lists what it could not convert and where results can differ, and can ask a live PostgreSQL whether it accepts the result. A switch picks who writes the PostgreSQL: **Rules** (nothing leaves your machine), **Rules, then AI** (the model only for what the rules cannot do) or **AI** (the model writes it; PostgreSQL still has to accept it, otherwise the rules' version is shown). **Run on PostgreSQL** reads the first 100 rows read-only, and you can paste what the original database returned to have the two compared cell by cell (numbers and dates by value, NULL and an empty string as the same). It cannot prove the new query returns the same rows for other data.

### Supported Databases

- ✅ PostgreSQL
- ✅ MySQL
- ✅ MariaDB
- ✅ SQLite
- ✅ Oracle
- ✅ SQL Server (MSSQL)

## Get Started

Deploy locally to start designing your database schemas in minutes.

### How to Use Locally

#### Using Docker (Recommended)
The easiest way to run GoForge locally is using Docker:

```bash
# Build and run using Docker Compose
docker compose up

# Or build and run using Docker directly
docker build -t goforge .
docker run -p 8080:80 goforge
```

Then visit `http://localhost:8080` in your browser.

See [DOCKER.md](./DOCKER.md) for the full setup, including the optional live-database-connection service.

#### Using Bun

Install dependencies and start the frontend on port 5173:

```bash
bun install
bun run dev
```

Then visit `http://localhost:5173` in your browser.

The API server is required for live PostgreSQL connections and the AI assistant. In a second terminal:

```bash
cd server
bun install
cp .env.example .env
# Set MASTER_KEY in server/.env, and OPENAI_API_KEY for the AI features (below)
bun run dev
```

#### Accounts and the cloud database (Postgres)

By default GoForge is one anonymous workspace: saved connections live in a SQLite file next to the API and diagrams live in the browser. Set `DATABASE_URL` in `server/.env` to a PostgreSQL connection string (Neon works; `DATABASE_URL_POOLED` may hold its `-pooler` address) and it becomes a multi-account app instead: the tables are created when the API starts, people sign in with email and password, and everything below is stored in that database and shown only to its owner.

- **Accounts.** The first account is always allowed and becomes the admin, who alone can change the AI settings. More accounts need `ALLOW_SIGNUP=true` (the sign-in screen always offers both Sign in and Create account; with sign-up off, Create account says so). Set it to `false` on a server anyone else can reach. Passwords are stored as scrypt hashes, sessions as hashed tokens in an `HttpOnly`, `SameSite=Lax` cookie; sign-in is rate limited. Set `COOKIE_SECURE=true` behind https and `TRUST_PROXY=true` behind a proxy.
- **Diagrams** are saved to the account a moment after each edit and brought back when the account signs in on any browser. The last save wins if two devices edit the same diagram. A browser that someone else signs in to does not keep the previous account's diagrams.
- **Saved connections, the audit log and AI settings** move to the database too (passwords still encrypted with `MASTER_KEY`). To carry over the connections you saved before switching, sign up, then run `npm --prefix server run import:local -- you@example.com`.
- **GoForge cloud databases.** When pasting or importing a schema (or File → Create a live database…), "GoForge cloud" creates a real database on this server for the account: `CREATE DATABASE` plus a role of its own that owns it, has no other rights and is the only one allowed in, so what people run in the SQL editor cannot touch another account's database or the application's. The saved connection signs in as that role; the server's own credentials never leave the API. Each account may have `MAX_CLOUD_DATABASES_PER_USER` (10); deleting the connection from the connection list, after a confirmation, deletes the database and its role. The `DATABASE_URL` role needs `CREATEDB` and `CREATEROLE`.

#### AI features use the OpenAI API

Schema Change, AI Schema and the Query Modernizer call a model through the **OpenAI API** and nowhere else, using OpenAI's official `openai` Node library (the Responses API). It is used in one file, `server/src/ai/openai.ts`; nothing else in the app knows which library is behind it, and there is no agent framework: every call is one request that returns one answer. Put your key in `server/.env` as `OPENAI_API_KEY=sk-...` and restart the API. The key stays on the server: GoForge does not store it, there is no field for it in the browser, it is only sent to `OPENAI_BASE_URL` (default `https://api.openai.com/v1`, and it has to be `https`), and none of it belongs in a `VITE_*` variable or in a committed `server/.env`.

The model is `gpt-5.6-luna` unless you choose another under **Schema Change → AI settings** ("Load models from OpenAI" lists what your key can use) or set `OPENAI_MODEL` in `server/.env`. GPT-5 and o-series models think before they answer and that counts against the output limit, so they are sent `reasoning.effort: low` unless `OPENAI_REASONING_EFFORT` says otherwise. The library tries a request again twice after a rate limit, a server error or a dropped connection (`OPENAI_MAX_RETRIES`). "Test the connection" sends one short message with no schema in it. Requests are sent with `store: false`.

**Structured outputs.** Every answer the app asks for (the Schema Change plan, the diagram AI plan, the Modernizer conversion, the health summary) is requested as a JSON schema that OpenAI enforces, so the model cannot return a malformed or incomplete answer. The schema is made from the same zod validators that check the answer afterwards (`server/src/ai/structured.ts`): strict mode needs every key present and no length limits, so optional fields become "may be null" and the limits stay with the validator, which still checks everything. The schema is part of the request, so the audit log's "what was sent" includes it. A model that does not accept a JSON schema is asked again once in plain JSON mode. Because nothing here can prove OpenAI accepts the schemas without a key, `npm --prefix server run check:openai` asks it once per schema (a few hundred tokens, no data of yours) and reports which were accepted.

To try the page with no OpenAI key, `scripts/fake-model-server.ts` is a stand-in for the endpoint (see the comment at the top of the file for how to point the API at it).

#### Connecting to a database

The first thing GoForge asks for is a database to look at, not a name for a new one. Paste a connection string (`postgres://user:password@host:5432/database`, a JDBC URL, or `host=… dbname=… user=… password=…`, with or without a `psql` or `DATABASE_URL=` wrapper) and it connects at once: the connection is saved on the server with its password encrypted, the schema (tables, columns, keys, indexes, views, sequences; never rows) is read, and the result opens as a new diagram project named after the database. If the connection fails, nothing is saved. The API server above has to be running.

When the string has no `sslmode`, a local host connects without TLS and any other host connects with TLS but without checking the certificate; add `?sslmode=disable` or `?sslmode=verify-full` to say otherwise. The error shown after a failed attempt lists anything that was filled in this way. A connection is named after its database (`neondb`); use the pencil next to a saved connection to give it a name you will recognise, and connecting from the list names the new project after the connection. The host, user and password form has a Name field for the same purpose. **File → New empty diagram** (or "Start with an empty diagram instead" in the dialog) still creates a blank project.

#### Turning a pasted or imported schema into a live database

Pasting SQL or DBML in the diagram's code editor, or importing a `.sql` file, draws the schema as a local diagram. The Data, Modernizer, Schema Change and SQL pages work on live PostgreSQL connections, so the Review step (and the SQL import dialog) also offers **Also create it as a live PostgreSQL database**: pick one of your saved servers and a name, and on Apply GoForge runs `CREATE DATABASE` there, builds the schema in it as one transaction, and saves a connection to it. That connection appears in every picker and is selected when you open those pages. If the schema fails, the transaction is rolled back and the new database is dropped again; a name that already exists is refused and never touched. The role needs the `CREATEDB` right (managed servers usually have it for the owner role). The switch and server are remembered. PostgreSQL diagrams qualify as they are, and **Oracle diagrams are converted to PostgreSQL first** (`NUMBER` becomes `smallint`/`integer`/`bigint`/`numeric` by precision and scale, `VARCHAR2` becomes `varchar`, `DATE` becomes `timestamp` because an Oracle `DATE` carries a time, upper-case names become lower-case so the Query Modernizer's converted queries find them). A column type, default, view or `CHECK` constraint with no faithful PostgreSQL form stops it and is named; nothing is dropped silently. Other dialects (MySQL, SQL Server, SQLite) do not qualify yet. For a diagram that already exists, use **File → Create a live database from this diagram…**.

**Oracle databases.** With `ORACLE_ADMIN_URL=oracle://user:password@host:1521/FREEPDB1` in `server/.env` (a login that may create users, such as `SYSTEM` on Oracle Database Free; `docker compose --profile oracle up -d oracle` starts one, or `docker run -d -p 127.0.0.1:1521:1521 -e ORACLE_PASSWORD=… gvenzl/oracle-free:23-slim-faststart`), an **Oracle diagram** can also be created as an **Oracle database**: the same switch offers *Create it in: Oracle*. In Oracle a "database" for a person is a schema, so GoForge creates a new user named `GF_<account>_<name>` with its own password, a 200 MB quota and a limits profile (a few sessions, bounded work per call, idle sessions closed), runs the diagram's own Oracle DDL in it, and saves a connection that signs in as that user; the Oracle server's login never leaves the API. **Only the SQL page reads Oracle**: it lists the connection with an *Oracle* tag, splits the script (`;` ends a statement, a line holding only `/` ends a PL/SQL block), commits each statement as it runs, and shows `ORA-` errors with their position. A statement that overstays 60 s is stopped, and if the driver's timeout cannot interrupt it (a PL/SQL sleep) the admin login ends the session. Data, Modernizer and Schema Change are PostgreSQL pages and do not list Oracle databases. Each account may have `MAX_ORACLE_DATABASES_PER_USER` (5); **Delete database** on the SQL page drops the schema and everything in it. Oracle Database Free is limited to 12 GB of user data and 2 GB of RAM for the whole server, and the Docker image takes about 6 GB of disk. The Oracle tests (`oracle.integration.test.ts` and friends) run against a real Oracle when `ORACLE_TEST_ADMIN_URL` is set and are skipped otherwise.

The API can run SQL against your saved databases (SQL Editor, Push Changes), so it only listens on `127.0.0.1` by default. Set `HOST=0.0.0.0` in `server/.env` if you really need to reach it from another machine; the Docker setup does this inside its private network, where the port is not published.

The AI features send schema metadata (names, types, keys, indexes, sizes and counts) to the model. They do not send database rows or saved connection credentials. Which OpenAI model is used, which models may receive requests (an optional allow-list) and whether names are hidden is set in **Schema Change → AI settings** (see below).

### Schema Change: planning a change to a large PostgreSQL database

The **Schema Change** page works on a saved live connection, not on the diagram (the diagram-based **AI Schema** panel is still at `/database/ai-schema` for designing small schemas).

1. **Find the tables (optional).** You do not have to choose any. The catalog (names, columns, keys, estimated rows, sizes) is read in one round trip. The words of your request are matched against table, schema and column names, weighted by how rare each word is in *your* database, and the foreign-key neighbours of the best matches are added. The scope is shown with the reason for each table and you can add or remove tables. It matches names, not meanings: a request that calls `clients` "customers" finds nothing, and the plan then goes ahead with no table in scope. That is how a request for **new tables** works: the model is told the names of the existing tables (not their contents), creates the new ones with `create_table`, and any existing table its foreign keys point at is read afterwards so the keys are checked against that table's real columns. Names already taken in the database are refused.
2. **Give the planner facts.** Only the tables in scope are sent in full (the others by name): columns, keys, existing indexes with how often each was scanned (`pg_stat_user_indexes`), row estimates, data sizes, dependent views, and two aggregate statistics per column (NULL fraction, distinct-value estimate). Never rows, default expressions, index predicates or credentials.
3. **A model proposes operations; fixed rules write the SQL.** Each operation is checked against the real catalog (names exist, types are real, a foreign key points at a unique column, a NOT NULL column has a default when the table has rows, an index name is free, a default is accepted by PostgreSQL) and compiled into a runbook: `CREATE INDEX CONCURRENTLY`, foreign keys and checks `NOT VALID` then `VALIDATE`, `NOT NULL` through a validated `CHECK`, a `lock_timeout` on every step, batched committed backfills, and for a type change that would rewrite the table an expand/contract sequence (new column, trigger, batched copy, swap in one `DO` block, the old column dropped in a step that is commented out). Every step states its lock, the work it does, the size of the table and a risk class that follows from those three by a fixed rule, plus how to undo it where that is possible. The lock levels and the "rewrites the table" predictions are checked against PostgreSQL 16 (`npm run test:schema-pg`).
4. **Open it in the SQL Editor.** The runbook opens with the transaction switch off, because `CONCURRENTLY` and the batched backfills need each statement on its own. Nothing is run for you.
5. **Health.** A read-only report from catalog queries: tables without a primary key, foreign keys without an index, duplicate, redundant, unused and invalid indexes, constraints that were never validated, wide tables, missing or stale statistics, tables with many dead rows, sequences past half their range. A model may be asked to order and explain the findings; it can only point at findings that exist.
6. **Governance.** The model is called through the OpenAI API with your key (see above; GoForge does not store it), an allow-list of model ids, optional redaction of schema, table, column, index and constraint names into placeholders before anything leaves the server (the answer is translated back), and an audit log of every request with exactly what was sent, every plan, every runbook opened and every settings change, exportable as CSV or JSON. The audit log records that a runbook was *opened*; what you run in the SQL Editor is not tracked.

Limits worth knowing: lock levels and the compiler's rules assume PostgreSQL 12 or newer; the size classes (under 16 MiB small, under 1 GiB medium, larger large) are a rule of thumb, not a timing; index usage counts are per server and only since the statistics were last reset; expand/contract is not compiled for a column that is part of a key, a foreign key or a check, or that a view uses; a table without a primary key or unique NOT NULL column can only be backfilled by page on PostgreSQL 14 or newer. A plan is checked against the facts read when it was made: build it again if the schema changed.

How it is tested:

```bash
docker run -d --name goforge-schema -e POSTGRES_PASSWORD=schema -e POSTGRES_DB=schema -p 54330:5432 postgres:16 -c max_locks_per_transaction=1024
npm run test:schema-pg                                   # catalog, facts, locks, rewrites, compiler runs, health, redaction, on a real PostgreSQL 16
npm run eval:schema                                      # table selection, plan checks, lint, execution and latency on generated 50 / 300 / 1,000 table databases
npm run eval:schema -- --sizes 300 --per-size 30 --keep  # keep sc_eval_300 to browse it (save a connection to 127.0.0.1:54330)
OPENAI_API_KEY=sk-... npm run eval:schema -- --live   # a real model (gpt-5.6-luna, or EVAL_MODEL) plans instead of the reference plans
```

`npm run eval:schema` builds the databases (real foreign keys, tables with 260,000 rows), writes change requests in the words a person would use (with typos, partial names, a column name only, the same name in two schemas), runs each through retrieval, the checks and the compiler, executes the runbook on a copy of the database and verifies the result. It also feeds in requests that must be refused. Without `--live` the plans are the reference plans, so the plan-validity numbers measure the checks and the compiler, not a model; the model's own latency and token use are reported as not measured. `scripts/fake-model-server.ts` is a stand-in OpenAI endpoint for trying the page without a key.

### Query Modernizer: converting a whole file

The **Query Modernizer** page has two views: **One query** and **A script**. In the script view you paste or drop a legacy `.sql` file (up to 20 MB; the conversion runs in your browser tab) and get one row per statement.

- **Splitting.** The file is split the way the tool that wrote it ran it: `;`, a lone `/` line in Oracle scripts, `GO` batches in T-SQL, `DELIMITER` in MySQL, `--#SET TERMINATOR` in DB2. Comments, strings, quoted names and Oracle `q'[...]'` strings are respected. Procedures, functions, packages, triggers and anonymous blocks are kept whole (their body is full of `;`). If a block has no closing `/` or `GO`, or a quote is never closed, the page says so instead of guessing.
- **Converting.** Every query goes through exactly the same path as in the one-query view: the rules, then (with a connection chosen) PostgreSQL's own `EXPLAIN`, then, only for what the rules cannot finish, the model, for at most the number of different statements you set (default 25). A missing table on the connection is reported as "names could not be checked" and does not send the model off to repair anything. Identical statements are converted once.
- **Statuses.** *Converted* (rules finished, result accepted), *Already PostgreSQL* (no rule had anything to change), *Needs review* (behaviour that can differ, bind variables, a model's answer, names the connection lacks), *Failed* (something not converted, or the result is rejected), *Out of scope* (procedures, schema statements, client commands such as `SET` or `SPOOL`: listed and counted, never converted, never called failures). Each status comes with the facts behind it, and how it was checked: by the database, or by a PostgreSQL grammar only. Nothing is scored.
- **Export.** The converted `.sql` (what did not convert, and everything that is not a query, stays in it as a comment with the reason: nothing is dropped), a Markdown migration report (counts per status, what blocks, what needs a person, what is not covered, the rules that did the work) and a CSV with a row per statement.
- **Agents.** The MCP tool `goforge_modernize_query` takes `script` as well as `query`, returns the same statuses (rules plus a PostgreSQL grammar check; no database or model), and can return the converted file and the report.

Limits: the converter works on queries; stored procedures and PL/SQL packages are out of scope. T-SQL written without `;` and without `GO` cannot be split reliably. "Converted" does not prove the new statement returns the same rows: run old and new on the same data and compare.

### Query Modernizer: how it is tested

The conversion rules are checked against a real database, not only by comparing text. `npm run test:corpus` converts 340+ legacy queries (Oracle, SQL Server, MySQL, DB2), runs each result on PostgreSQL 16 and compares its rows with a hand-written reference. It exits non-zero if any result is silently wrong or a rule family drops below 90%.

```bash
docker run -d --name goforge-corpus -e POSTGRES_PASSWORD=corpus -e POSTGRES_DB=corpus -p 54329:5432 postgres:16
npm run test:corpus          # needs the container above (override with CORPUS_DATABASE_URL)
npm run corpus:golden        # regenerate the exact-output file after a deliberate rule change, then review the diff
```

`bun run test` runs the database-free half of the same corpus (every case converts, reports what it should, keeps its exact output, and produces SQL a PostgreSQL grammar accepts).

`npm run test:batch` (same container) writes the corpus into one script per dialect, splits and converts it through the script path, has PostgreSQL check every result, and compares the statuses with what the corpus knows: a statement known to be unconverted or to return different rows must never be plain "converted", and one whose rows were proven identical must never be "failed". It exits non-zero on any disagreement.

### How to Build
Install dependencies and create a production build:
```bash
bun install
bun run test
bun run build

cd server
bun install
bun run build
```

## Contributing

We welcome all contributions, whether small bug fixes or major feature additions.

- Follow the [Contributing Guide](./CONTRIBUTING.md) to get started.
- Agree to the [Code of Conduct](./CODE_OF_CONDUCT.md) to ensure a positive and respectful environment.
- Report bugs and request features via [GitHub Issues](https://github.com/swsarancodes/goforge/issues).

## 📜 License

GoForge is licensed under the [GNU Affero General Public License v3.0 (AGPLv3)](./LICENSE).
