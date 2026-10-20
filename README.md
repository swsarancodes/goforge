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
-  **Query Modernizer** – Rewrite a query written for Oracle, SQL Server, MySQL or DB2 so it runs on PostgreSQL with named, tested rules. It lists what it could not convert and where results can differ, and can ask a live PostgreSQL whether it accepts the result (nothing is run). It does not prove the new query returns the same rows.

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
# Set MASTER_KEY and ZEN_API_KEY in server/.env
bun run dev
```

Keep `ZEN_API_KEY` server-side. Never add it to a `VITE_*` variable or commit `server/.env`.

The API can run SQL against your saved databases (SQL Editor, Push Changes), so it only listens on `127.0.0.1` by default. Set `HOST=0.0.0.0` in `server/.env` if you really need to reach it from another machine; the Docker setup does this inside its private network, where the port is not published.

The AI workflow sends schema metadata (table, column, relationship, and index definitions) to Zen. It does not send database rows or saved connection credentials. The default contributor-free Zen model may use prompts and completions to improve future models, so review its data policy before using sensitive schema names.

### Query Modernizer: how it is tested

The conversion rules are checked against a real database, not only by comparing text. `npm run test:corpus` converts 340+ legacy queries (Oracle, SQL Server, MySQL, DB2), runs each result on PostgreSQL 16 and compares its rows with a hand-written reference. It exits non-zero if any result is silently wrong or a rule family drops below 90%.

```bash
docker run -d --name goforge-corpus -e POSTGRES_PASSWORD=corpus -e POSTGRES_DB=corpus -p 54329:5432 postgres:16
npm run test:corpus          # needs the container above (override with CORPUS_DATABASE_URL)
npm run corpus:golden        # regenerate the exact-output file after a deliberate rule change, then review the diff
```

`bun run test` runs the database-free half of the same corpus (every case converts, reports what it should, keeps its exact output, and produces SQL a PostgreSQL grammar accepts).

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
