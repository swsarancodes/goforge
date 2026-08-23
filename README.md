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

Install dependencies and start the frontend on port 7000:

```bash
bun install
bun run dev
```

Then visit `http://localhost:7000` in your browser.

The API server is required for live PostgreSQL connections and the AI assistant. In a second terminal:

```bash
cd server
bun install
cp .env.example .env
# Set MASTER_KEY and ZEN_API_KEY in server/.env
bun run dev
```

Keep `ZEN_API_KEY` server-side. Never add it to a `VITE_*` variable or commit `server/.env`.

The AI workflow sends schema metadata (table, column, relationship, and index definitions) to Zen. It does not send database rows or saved connection credentials. The default contributor-free Zen model may use prompts and completions to improve future models, so review its data policy before using sensitive schema names.

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
