import type { AppDb } from "./app-db.js";

/**
 * The application database's schema, as ordered steps that run once each. Add new steps at the end and never edit one that has shipped.
 */
export interface Migration {
    id: string;
    sql: string;
}

export const MIGRATIONS: Migration[] = [
    {
        id: "001_accounts_connections_projects_ai",
        sql: `
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE connections (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL,
  username text NOT NULL,
  database_name text NOT NULL,
  ssl_mode text NOT NULL DEFAULT 'disable',
  password_ciphertext bytea NOT NULL,
  password_iv bytea NOT NULL,
  password_auth_tag bytea NOT NULL,
  kind text NOT NULL DEFAULT 'external' CHECK (kind IN ('external', 'cloud')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connections_owner_idx ON connections (owner_id, created_at DESC);
-- one physical database on the application's own server belongs to exactly one connection
CREATE UNIQUE INDEX connections_cloud_database_key ON connections (database_name) WHERE kind = 'cloud';

CREATE TABLE projects (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  dialect text NOT NULL,
  document jsonb NOT NULL,
  tables_count integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_idx ON projects (owner_id, updated_at DESC);

CREATE TABLE ai_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_audit (
  id bigserial PRIMARY KEY,
  owner_id uuid REFERENCES users (id) ON DELETE SET NULL,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL,
  connection_id text,
  connection_name text,
  provider text,
  model text,
  endpoint_host text,
  redacted boolean NOT NULL DEFAULT false,
  request_chars integer,
  request_tokens_estimate integer,
  response_chars integer,
  usage_input_tokens integer,
  usage_output_tokens integer,
  latency_ms integer,
  error text,
  parent_id bigint,
  payload text,
  sha256 text,
  response text,
  detail jsonb
);
CREATE INDEX ai_audit_owner_idx ON ai_audit (owner_id, id DESC);
`,
    },
    {
        id: "002_connection_engine",
        sql: `
ALTER TABLE connections ADD COLUMN engine text NOT NULL DEFAULT 'postgres' CHECK (engine IN ('postgres', 'oracle'));
`,
    },
    {
        id: "003_oracle_schema_unique",
        sql: `
-- A PostgreSQL cloud database is its own physical database. An Oracle one is a schema (the user name) on a shared server, so there the
-- database_name (the service) is the same for all of them and the schema is what must be unique.
DROP INDEX connections_cloud_database_key;
CREATE UNIQUE INDEX connections_cloud_database_key ON connections (database_name) WHERE kind = 'cloud' AND engine = 'postgres';
CREATE UNIQUE INDEX connections_oracle_schema_key ON connections (host, port, database_name, username) WHERE kind = 'cloud' AND engine = 'oracle';
`,
    },
];

/** Runs every step that has not run yet, in order, in one transaction under a lock so two servers starting together do not collide. */
export async function migrate(db: AppDb, migrations: Migration[] = MIGRATIONS): Promise<string[]> {
    await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    return db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(727274)");
        const done = new Set((await tx.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((row) => row.id));
        const applied: string[] = [];
        for (const migration of migrations) {
            if (done.has(migration.id)) continue;
            await tx.query(migration.sql);
            await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
            applied.push(migration.id);
        }
        return applied;
    });
}
