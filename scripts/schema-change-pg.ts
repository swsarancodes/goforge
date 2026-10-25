/**
 * Runs the schema-change code against a real PostgreSQL and checks what it claims: lock levels read from pg_locks, which type changes rewrite a
 * table, runbooks executed and compared with the catalog, the pre-flight and lock-retry behaviour with real sessions. Written for PostgreSQL 12 to 18.
 *
 *   docker run -d --name goforge-schema -e POSTGRES_PASSWORD=schema -p 54330:5432 postgres:16 -c max_locks_per_transaction=1024
 *   npm run test:schema-pg                # every section against that server
 *   npm run test:schema-pg -- model       # one section
 *   npm run test:schema-pg:versions       # every section against PostgreSQL 12, 13, 14, 15, 16, 17 and 18 (starts and removes the containers)
 *
 * SCHEMA_CHANGE_DATABASE_URL points it at another server (default postgres://postgres:schema@127.0.0.1:54330/postgres).
 * Each section builds its own scratch database and drops it afterwards. Exit code 1 if any check failed.
 */
import { loadCatalog } from "../server/src/schema-change/catalog";
import { healthReport } from "../server/src/schema-change/health";
import { PREFLIGHT_LIMITS, preflight } from "../server/src/schema-change/preflight";
import { diffExpected } from "../server/src/schema-change/expected-state";
import { planSchemaChange } from "../server/src/schema-change/planner";
import { namesToRedact } from "../server/src/schema-change/prompt";
import { Redactor, findLeaks, stringValues } from "../server/src/schema-change/redact";
import type { ModelCall } from "../server/src/ai/provider";
import { castKey, checkKey, defaultKey, loadFacts, probe } from "../server/src/schema-change/facts";
import { classifyTypeChange } from "../server/src/schema-change/type-change";
import { splitSqlStatements } from "../server/src/services/sql-tokens";
import { buildSearchIndex, selectScope } from "../server/src/schema-change/retrieval";
import { Checks, connect, createDatabase, dropDatabase, withDatabase, type PgClient } from "./lib/pg-scratch";
import { asRunner, compileOn, parsePlan, runRunbook } from "./lib/plan-runner";

type Section = (checks: Checks) => Promise<void>;

/** The server under test (12 to 18): set before the sections run, read by the ones that use a feature a version lacks. */
let MAJOR = 16;

const FIXTURE = `
  CREATE SCHEMA billing;
  CREATE TYPE mood AS ENUM ('ok', 'bad');
  CREATE TABLE customers (id bigint PRIMARY KEY, email text NOT NULL UNIQUE, created_at timestamptz DEFAULT now());
  CREATE TABLE orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES customers (id),
    status varchar(20) NOT NULL DEFAULT 'new',
    mood mood,
    total numeric(12, 2),
    shipped_at timestamptz,
    CONSTRAINT orders_total_positive CHECK (total >= 0)
  );
  CREATE INDEX orders_customer_idx ON orders (customer_id);
  CREATE INDEX orders_status_open_idx ON orders (status) WHERE shipped_at IS NULL;
  CREATE TABLE order_items (id bigint PRIMARY KEY, order_id bigint NOT NULL, product text, quantity int);
  ALTER TABLE order_items ADD CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id) NOT VALID;
  CREATE TABLE billing.invoices (id bigint PRIMARY KEY, order_id bigint REFERENCES orders (id), due_date date);
  CREATE VIEW open_orders AS SELECT id, status FROM orders WHERE shipped_at IS NULL;
  CREATE TABLE events (id bigint, at timestamptz NOT NULL, payload jsonb) PARTITION BY RANGE (at);
  CREATE TABLE events_2026_01 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
  CREATE TABLE events_2026_02 PARTITION OF events FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
  INSERT INTO customers SELECT g, 'c' || g || '@example.test' FROM generate_series(1, 1000) g;
  INSERT INTO orders (customer_id, status, total) SELECT 1 + g % 1000, 'new', g FROM generate_series(1, 5000) g;
  INSERT INTO events SELECT g, '2026-01-15', '{}' FROM generate_series(1, 300) g;
  ANALYZE;
  CREATE TABLE never_analyzed (id bigint PRIMARY KEY, note text);
  INSERT INTO never_analyzed SELECT g, 'x' FROM generate_series(1, 50) g;
`;


// A table of about 45 MB, big enough to be "medium" by the size rule, so the online-safe paths are used instead of the direct ones.
const SHOP = `
  CREATE TABLE customers (id bigint PRIMARY KEY, email text NOT NULL, name text);
  CREATE TABLE orders (id bigint PRIMARY KEY, customer_id bigint NOT NULL, status varchar(20) NOT NULL DEFAULT 'new', total numeric(12, 2), qty integer NOT NULL DEFAULT 1,
                       note text, shipped_at timestamptz, ref text);
  CREATE TABLE order_items (id bigint PRIMARY KEY, order_id bigint, sku text, quantity integer);
  CREATE TABLE tags (id integer PRIMARY KEY, label text);
  INSERT INTO customers SELECT g, 'c' || g || '@example.test', 'n' || g FROM generate_series(1, 50000) g;
  INSERT INTO orders SELECT g, 1 + g % 50000, 'new', g % 997, g % 5, repeat('x', 40), NULL, 'r' || g FROM generate_series(1, 400000) g;
  INSERT INTO order_items SELECT g, 1 + g % 400000, 'sku' || g % 100, g % 7 FROM generate_series(1, 500000) g;
  INSERT INTO tags SELECT g, 'tag' || g FROM generate_series(1, 100) g;
  CREATE INDEX orders_status_idx ON orders (status);
  CREATE INDEX orders_qty_idx ON orders (qty);
  ANALYZE;
`;

interface Scenario {
    name: string;
    tables: string[];
    operations: unknown[];
    /** Runs after the runbook; checks what the database looks like now. */
    verify: (client: PgClient, checks: Checks) => Promise<void>;
    /** The runbook is expected to compile with this error code instead of running. */
    refused?: string;
    includeOptional?: boolean;
    /** SQL run on the scratch database before the plan is compiled (for what the shared fixture does not have). */
    setup?: string;
}

const one = async (client: PgClient, sql: string): Promise<Record<string, unknown> | undefined> => (await client.query(sql)).rows[0];

const SCENARIOS: Scenario[] = [
    {
        name: "add a nullable column",
        tables: ["public.orders"],
        operations: [{ type: "add_column", tableName: "orders", field: { name: "carrier", dataType: "varchar", maxLength: 30 } }],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'carrier'"))?.t, "character varying(30)", "column exists with its length");
        },
    },
    {
        name: "add a NOT NULL column with a constant default (no rewrite)",
        tables: ["public.orders"],
        operations: [{ type: "add_column", tableName: "orders", field: { name: "priority", dataType: "integer", nullable: false, defaultValue: "0" } }],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM orders WHERE priority = 0"))?.n, 400000, "existing rows read the default");
            checks.equal((await one(client, "SELECT attnotnull AS n FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'priority'"))?.n, true, "NOT NULL");
        },
    },
    {
        name: "add a NOT NULL column with a volatile default on a medium table (expand, fill in batches, then NOT NULL)",
        tables: ["public.orders"],
        operations: [{ type: "add_column", tableName: "orders", field: { name: "public_id", dataType: "uuid", nullable: false, defaultValue: "gen_random_uuid()" } }],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM orders WHERE public_id IS NULL"))?.n, 0, "every existing row was filled");
            checks.equal((await one(client, "SELECT count(DISTINCT public_id)::int AS n FROM orders"))?.n, 400000, "with its own value");
            checks.equal((await one(client, "SELECT attnotnull AS n FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'public_id'"))?.n, true, "NOT NULL in the end");
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'c' AND conname LIKE '%not_null'"))?.n, 0, "the helper CHECK is gone");
        },
    },
    {
        name: "add an index",
        tables: ["public.orders"],
        operations: [{ type: "add_index", tableName: "orders", index: { name: "orders_customer_idx", columns: ["customer_id"] } }],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT indisvalid AS v FROM pg_index WHERE indexrelid = 'orders_customer_idx'::regclass"))?.v, true, "valid index");
        },
    },
    {
        name: "add a unique index that the data violates (fails, and the runbook says how to clean up)",
        tables: ["public.orders"],
        operations: [{ type: "add_index", tableName: "orders", index: { name: "orders_status_uq", columns: ["status"], unique: true } }],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT indisvalid AS v FROM pg_index WHERE indexrelid = 'orders_status_uq'::regclass"))?.v, false, "a failed CONCURRENTLY build leaves an INVALID index, as the notes say");
        },
    },
    {
        name: "add a foreign key on a medium table (NOT VALID, VALIDATE, index the key)",
        tables: ["public.order_items", "public.orders"],
        operations: [{ type: "add_relationship", relationship: { sourceTable: "orders", sourceColumn: "id", targetTable: "order_items", targetColumn: "order_id", onDelete: "cascade" } }],
        async verify(client, checks) {
            const fk = await one(client, "SELECT convalidated AS v, confdeltype::text AS d FROM pg_constraint WHERE conrelid = 'order_items'::regclass AND contype = 'f'");
            checks.equal(fk, { v: true, d: "c" }, "validated foreign key with ON DELETE CASCADE");
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM pg_index WHERE indrelid = 'order_items'::regclass AND NOT indisprimary AND indisvalid"))?.n, 1, "an index on the foreign key column");
        },
    },
    {
        name: "make a column NOT NULL on a medium table (CHECK NOT VALID, VALIDATE, SET NOT NULL, drop the CHECK)",
        tables: ["public.orders"],
        operations: [{ type: "alter_column", tableName: "orders", columnName: "ref", changes: { nullable: false } }],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT attnotnull AS n FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'ref'"))?.n, true, "NOT NULL");
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'c'"))?.n, 0, "no helper CHECK left");
        },
    },
    {
        name: "make a column NOT NULL when it has NULLs (the validation step fails and nothing is half done)",
        tables: ["public.orders"],
        operations: [{ type: "alter_column", tableName: "orders", columnName: "shipped_at", changes: { nullable: false } }],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT attnotnull AS n FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'shipped_at'"))?.n, false, "still nullable");
            checks.equal((await one(client, "SELECT convalidated AS v FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'c'"))?.v, false, "the NOT VALID CHECK stays so new NULLs are already refused");
        },
    },
    {
        name: "raise a varchar limit (catalog only)",
        tables: ["public.orders"],
        operations: [{ type: "alter_column", tableName: "orders", columnName: "status", changes: { dataType: "varchar", maxLength: 50 } }],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'status'"))?.t, "character varying(50)", "new length");
        },
    },
    {
        name: "change integer to bigint on a medium table (expand / contract, with the index copied)",
        tables: ["public.orders"],
        operations: [{ type: "alter_column", tableName: "orders", columnName: "qty", changes: { dataType: "bigint" } }],
        includeOptional: true,
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'qty'"))?.t, "bigint", "the column has the new type");
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM orders WHERE qty IS DISTINCT FROM (id % 5)"))?.n, 0, "and the same values");
            checks.equal((await one(client, "SELECT attnotnull AS n FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'qty'"))?.n, true, "still NOT NULL");
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname LIKE 'qty\\_\\_%' AND NOT attisdropped"))?.n, 0, "the temporary columns are gone after the contract step");
            const index = await one(client, "SELECT pg_get_indexdef(indexrelid) AS d FROM pg_index WHERE indrelid = 'orders'::regclass AND indisvalid AND indexrelid::regclass::text = 'orders_qty_idx'");
            checks.ok(String(index?.d).includes("(qty)"), "the index on the column exists under its old name, on the new column", index);
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'orders'::regclass AND NOT tgisinternal"))?.n, 0, "the sync trigger is gone");
        },
    },
    {
        name: "make a column unique (unique index CONCURRENTLY, then USING INDEX)",
        tables: ["public.customers"],
        operations: [{ type: "alter_column", tableName: "customers", columnName: "email", changes: { unique: true } }],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'customers'::regclass AND contype = 'u'"))?.n, 1, "a unique constraint");
        },
    },
    {
        name: "set and drop defaults, rename a column",
        tables: ["public.orders"],
        operations: [
            { type: "alter_column", tableName: "orders", columnName: "note", changes: { defaultValue: "'none'" } },
            { type: "alter_column", tableName: "orders", columnName: "ref", changes: { newName: "reference" } },
        ],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT pg_get_expr(adbin, adrelid) AS d FROM pg_attrdef WHERE adrelid = 'orders'::regclass AND adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'note')"))?.d, "'none'::text", "default");
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'reference'"))?.n, 1, "renamed column");
        },
    },
    {
        name: "drop an index, a column and a table",
        tables: ["public.orders", "public.tags"],
        operations: [
            { type: "drop_index", tableName: "orders", indexName: "orders_status_idx" },
            { type: "drop_column", tableName: "orders", columnName: "note" },
            { type: "drop_table", tableName: "tags" },
        ],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT to_regclass('orders_status_idx') IS NULL AS gone"))?.gone, true, "index dropped");
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'note' AND NOT attisdropped"))?.n, 0, "column dropped");
            checks.equal((await one(client, "SELECT to_regclass('tags') IS NULL AS gone"))?.gone, true, "table dropped");
        },
    },
    {
        name: "create a table, with an index and a foreign key to an existing table",
        tables: ["public.customers"],
        operations: [
            { type: "create_table", table: { name: "support_tickets", fields: [
                { name: "id", dataType: "bigint", primaryKey: true, autoIncrement: true },
                { name: "customer_id", dataType: "bigint", nullable: false },
                { name: "subject", dataType: "varchar", maxLength: 200, nullable: false },
                { name: "opened_at", dataType: "timestamptz", nullable: false, defaultValue: "now()" },
            ], indexes: [{ name: "support_tickets_opened_idx", columns: ["opened_at"] }] } },
            { type: "add_relationship", relationship: { sourceTable: "customers", sourceColumn: "id", targetTable: "support_tickets", targetColumn: "customer_id" } },
        ],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'support_tickets'::regclass AND contype = 'f' AND convalidated"))?.n, 1, "foreign key exists and is valid");
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM pg_index WHERE indrelid = 'support_tickets'::regclass AND indisvalid"))?.n, 3, "primary key, the requested index and the foreign key index");
        },
    },
    {
        name: "add a unique constraint (unique index CONCURRENTLY, then USING INDEX)",
        tables: ["public.customers"],
        operations: [{ type: "add_unique", tableName: "customers", constraintName: "customers_email_uq", columns: ["email"] }],
        async verify(client, checks) {
            checks.equal(await one(client, "SELECT contype::text AS t, (SELECT indisvalid FROM pg_index WHERE indexrelid = 'customers_email_uq'::regclass) AS v FROM pg_constraint WHERE conname = 'customers_email_uq'"), { t: "u", v: true }, "a unique constraint backed by a valid index");
            await client.query("INSERT INTO customers VALUES (900001, 'dup@example.test', 'a')");
            await client.query("INSERT INTO customers VALUES (900002, 'dup@example.test', 'b')").then(() => checks.ok(false, "a duplicate is refused"), () => checks.ok(true, "a duplicate is refused"));
        },
    },
    {
        name: "add a check on a medium table (NOT VALID, then VALIDATE)",
        tables: ["public.orders"],
        operations: [{ type: "add_check", tableName: "orders", constraintName: "orders_qty_nonneg", expression: "qty >= 0 AND status <> ''" }],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT convalidated AS v FROM pg_constraint WHERE conname = 'orders_qty_nonneg'"))?.v, true, "validated");
            await client.query("INSERT INTO orders (id, customer_id, status, qty) VALUES (900001, 1, 'x', -1)").then(() => checks.ok(false, "a row that breaks it is refused"), () => checks.ok(true, "a row that breaks it is refused"));
        },
    },
    {
        name: "add a check the data violates (fails, and the constraint is left NOT VALID)",
        tables: ["public.orders"],
        operations: [{ type: "add_check", tableName: "orders", constraintName: "orders_total_small", expression: "total < 500" }],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT convalidated AS v FROM pg_constraint WHERE conname = 'orders_total_small'"))?.v, false, "added NOT VALID, enforced for new rows, validation failed");
        },
    },
    {
        name: "add a primary key to a table without one (NOT NULL first, unique index CONCURRENTLY, USING INDEX)",
        setup: "CREATE TABLE orders_nopk AS SELECT id, customer_id, status FROM orders; ANALYZE orders_nopk;",
        tables: ["public.orders_nopk"],
        operations: [{ type: "add_primary_key", tableName: "orders_nopk", columns: ["id"] }],
        async verify(client, checks) {
            checks.equal(await one(client, "SELECT contype::text AS t, (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'orders_nopk'::regclass AND attname = 'id') AS nn FROM pg_constraint WHERE conrelid = 'orders_nopk'::regclass AND contype = 'p'"), { t: "p", nn: true }, "a primary key on a NOT NULL column");
            checks.equal((await one(client, "SELECT indisprimary AS p, indisvalid AS v FROM pg_index WHERE indexrelid = 'orders_nopk_pkey'::regclass"))?.p, true, "the index built for it is the primary key's");
            await client.query("INSERT INTO orders_nopk VALUES (1, 1, 'dup')").then(() => checks.ok(false, "a duplicate key is refused"), () => checks.ok(true, "a duplicate key is refused"));
            checks.equal((await one(client, "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'orders_nopk'::regclass AND contype = 'c'"))?.n, 0, "the helper CHECK is gone");
        },
    },
    {
        name: "make an integer column an identity column (the sequence starts after the largest value)",
        setup: "CREATE TABLE ledger (id integer NOT NULL PRIMARY KEY, memo text); INSERT INTO ledger SELECT g, repeat('x', 40) FROM generate_series(1, 300000) g; ANALYZE ledger;",
        tables: ["public.ledger"],
        operations: [{ type: "alter_column", tableName: "ledger", columnName: "id", changes: { autoIncrement: true } }],
        async verify(client, checks) {
            checks.equal((await one(client, "SELECT attidentity::text AS i FROM pg_attribute WHERE attrelid = 'ledger'::regclass AND attname = 'id'"))?.i, "d", "GENERATED BY DEFAULT AS IDENTITY");
            checks.equal((await one(client, "INSERT INTO ledger (memo) VALUES ('new') RETURNING id"))?.id, 300001, "the next row gets the number after the largest one");
            await client.query("INSERT INTO ledger (id, memo) VALUES (-5, 'explicit')");
            checks.ok(true, "a row that gives its own id is still accepted");
        },
    },
    {
        name: "turn a serial column into an identity column (drop the default, then identity)",
        setup: "CREATE TABLE ledger2 (id serial PRIMARY KEY, memo text); INSERT INTO ledger2 (memo) SELECT repeat('x', 40) FROM generate_series(1, 300000); ANALYZE ledger2;",
        tables: ["public.ledger2"],
        operations: [{ type: "alter_column", tableName: "ledger2", columnName: "id", changes: { defaultValue: null, autoIncrement: true } }],
        async verify(client, checks) {
            checks.equal(await one(client, "SELECT attidentity::text AS i, pg_get_expr(d.adbin, d.adrelid) AS d FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = 'ledger2'::regclass AND a.attname = 'id'"), { i: "d", d: null }, "an identity column and no default");
            checks.equal((await one(client, "INSERT INTO ledger2 (memo) VALUES ('new') RETURNING id"))?.id, 300001, "the next row gets the number after the largest one");
        },
    },
    {
        name: "refuses NOT NULL without a default on a table with rows",
        tables: ["public.orders"],
        operations: [{ type: "add_column", tableName: "orders", field: { name: "must_have", dataType: "text", nullable: false } }],
        refused: "not-null-needs-default",
        async verify() {},
    },
    {
        name: "refuses to drop a table another table points at",
        tables: ["public.customers", "public.orders"],
        operations: [{ type: "add_relationship", relationship: { sourceTable: "customers", sourceColumn: "id", targetTable: "orders", targetColumn: "customer_id" } }, { type: "drop_table", tableName: "customers" }],
        refused: "referenced",
        async verify() {},
    },
];

async function compileSection(checks: Checks, only?: string) {
    const template = `sc_tpl_${process.pid}`;
    await createDatabase(template, async (client) => {
        await client.query(SHOP);
    });
    try {
        for (const scenario of SCENARIOS) {
            if (only && !scenario.name.includes(only)) continue;
            await withDatabase(async (client) => {
                if (scenario.setup) await client.query(scenario.setup);
                const plan = parsePlan(scenario.operations);
                const { runbook } = await compileOn(client, plan, scenario.tables);
                if (scenario.refused) {
                    checks.ok(runbook.findings.some((finding) => finding.severity === "error" && finding.code === scenario.refused), `${scenario.name}: refused with ${scenario.refused}`, runbook.findings);
                    return;
                }
                const errors = runbook.findings.filter((finding) => finding.severity === "error");
                checks.equal(errors, [], `${scenario.name}: compiles without errors`);
                const result = await runRunbook(client, runbook, { includeOptional: scenario.includeOptional });
                const expectFailure = scenario.name.includes("(fails") || scenario.name.includes("has NULLs");
                if (expectFailure) checks.ok(!result.ok, `${scenario.name}: the runbook stops at the failing step`, result);
                else checks.ok(result.ok, `${scenario.name}: every statement runs in autocommit mode`, result.failure);
                await scenario.verify(client, checks);
                console.log(`  ${scenario.name}: ${runbook.steps.length} steps, risk ${runbook.steps.map((step) => step.risk[0].toUpperCase()).join("")}`);
            }, { template });
        }
    } finally {
        await dropDatabase(template);
    }
}


// ---- lock levels: what each step says it takes, against what PostgreSQL reports it holding --------------------------------

const LOCK_ORDER = ["AccessShareLock", "RowShareLock", "RowExclusiveLock", "ShareUpdateExclusiveLock", "ShareLock", "ShareRowExclusiveLock", "ExclusiveLock", "AccessExclusiveLock"];
const LOCK_NAMES: Record<string, string> = {
    "ACCESS EXCLUSIVE": "AccessExclusiveLock",
    "SHARE ROW EXCLUSIVE": "ShareRowExclusiveLock",
    SHARE: "ShareLock",
    "SHARE UPDATE EXCLUSIVE": "ShareUpdateExclusiveLock",
    "ROW EXCLUSIVE": "RowExclusiveLock",
    "ROW SHARE": "RowShareLock",
    "ACCESS SHARE": "AccessShareLock",
};

async function locksHeld(client: PgClient): Promise<Map<string, string>> {
    const rows = (await client.query(
        `SELECT c.relname AS name, n.nspname AS schema, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND l.granted AND c.relkind IN ('r', 'p') AND n.nspname = 'public'`,
    )).rows as { name: string; schema: string; mode: string }[];
    const strongest = new Map<string, string>();
    for (const row of rows) {
        const key = `${row.schema}.${row.name}`;
        const current = strongest.get(key);
        if (!current || LOCK_ORDER.indexOf(row.mode) > LOCK_ORDER.indexOf(current)) strongest.set(key, row.mode);
    }
    return strongest;
}

async function locksSection(checks: Checks) {
    const template = `sc_tpl_${process.pid}`;
    await createDatabase(template, async (client) => {
        await client.query(SHOP);
    });
    let compared = 0;
    try {
        for (const scenario of SCENARIOS) {
            if (scenario.refused || scenario.name.includes("(fails") || scenario.name.includes("has NULLs")) continue;
            await withDatabase(async (client) => {
                if (scenario.setup) await client.query(scenario.setup);
                const { runbook } = await compileOn(client, parsePlan(scenario.operations), scenario.tables);
                for (const step of runbook.steps) {
                    if (step.optional && !scenario.includeOptional) continue;
                    const text = step.sql;
                    const inTransaction = step.work !== "backfill" && step.sql.indexOf("CONCURRENTLY") === -1;
                    if (!inTransaction) {
                        const result = await runRunbook(client, { ...runbook, steps: [step] }, { includeOptional: true });
                        checks.ok(result.ok, `${scenario.name} / ${step.title}: runs`, result.failure);
                        continue;
                    }
                    await client.query("BEGIN");
                    try {
                        for (const statement of splitSqlStatements(text)) await client.query(statement.text);
                        const held = await locksHeld(client);
                        // A dropped table can't be looked up afterwards; DROP TABLE's lock is documented.
                        if (step.table && step.lock !== "none" && !step.title.startsWith("Drop table")) {
                            const mode = held.get(step.table);
                            compared++;
                            checks.equal(mode, LOCK_NAMES[step.lock], `${scenario.name} / ${step.title}: lock on ${step.table}`);
                        }
                        for (const other of step.alsoLocks) {
                            checks.ok(held.has(other), `${scenario.name} / ${step.title}: also locks ${other}`, [...held.entries()]);
                        }
                    } finally {
                        await client.query("COMMIT");
                    }
                }
            }, { template });
        }
    } finally {
        await dropDatabase(template);
    }

    // CREATE INDEX CONCURRENTLY waits for earlier writers; while it waits, what it holds can be read from another session.
    await withDatabase(async (client, name) => {
        await client.query(SHOP);
        const writer = await connect(name);
        const builder = await connect(name);
        try {
            await writer.query("BEGIN");
            await writer.query("UPDATE orders SET qty = qty WHERE id = 1");
            const pid = Number((await builder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
            const build = builder.query("CREATE INDEX CONCURRENTLY wait_probe ON orders (customer_id)");
            let held: string[] = [];
            for (let attempt = 0; attempt < 100 && held.length === 0; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                const waiting = (await client.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted", [pid])).rows.length > 0;
                if (waiting) held = (await client.query("SELECT mode FROM pg_locks WHERE pid = $1 AND locktype = 'relation' AND relation = 'orders'::regclass AND granted", [pid])).rows.map((row) => row.mode as string);
            }
            checks.equal(held, ["ShareUpdateExclusiveLock"], "CREATE INDEX CONCURRENTLY holds only SHARE UPDATE EXCLUSIVE on the table while it waits (writes and reads continue)");
            await writer.query("COMMIT");
            await build;
        } finally {
            await writer.end().catch(() => undefined);
            await builder.end().catch(() => undefined);
        }
    });
    checks.ok(compared >= 20, `compared ${compared} step locks with pg_locks`);
}

// ---- which type changes rewrite the table ------------------------------------------------------------------------------------

async function rewritesSection(checks: Checks) {
    const pairs: [string, string, string?][] = [
        ["varchar(20)", "varchar(50)"],
        ["varchar(20)", "varchar"],
        ["varchar(20)", "text"],
        ["text", "varchar"],
        ["text", "varchar(100)"],
        ["varchar(20)", "varchar(10)"],
        ["varchar", "varchar(30)"],
        ["numeric(10,2)", "numeric(12,2)"],
        ["numeric(10,2)", "numeric(10,3)"],
        ["numeric(10,2)", "numeric(8,2)"],
        ["numeric(10,2)", "numeric"],
        ["integer", "bigint"],
        ["bigint", "integer"],
        ["integer", "smallint"],
        ["integer", "numeric"],
        ["smallint", "integer"],
        ["timestamp", "timestamptz"],
        ["date", "timestamp"],
        ["char(5)", "char(10)"],
        ["char(5)", "varchar(10)"],
        ["json", "jsonb"],
        ["text", "integer", "USING v::integer"],
        ["real", "double precision"],
        ["varchar(20)", "varchar(20)"],
    ];
    const conservative: string[] = [];
    await withDatabase(async (client) => {
        for (const [index, [from, to, using]] of pairs.entries()) {
            const table = `t${index}`;
            const sample = from.startsWith("numeric") ? "1.25" : from === "integer" || from === "bigint" || from === "smallint" || from === "real" ? "7" : from.startsWith("timestamp") ? "now()" : from === "date" ? "current_date" : from === "json" ? "'{\"a\":1}'" : from === "text" && using ? "'12'" : "'ab'";
            await client.query(`CREATE TABLE ${table} (id int PRIMARY KEY, v ${from}); ${from === "json" ? "" : `CREATE INDEX ${table}_v ON ${table} (v)`}`);
            await client.query(`INSERT INTO ${table} SELECT g, ${sample}${from.startsWith("char(") ? "::" + from : ""} FROM generate_series(1, 100) g`);
            const files = async () => (await client.query(`SELECT string_agg(c.relname || '=' || pg_relation_filenode(c.oid)::text, ',' ORDER BY c.relname) AS f FROM pg_class c WHERE c.relname IN ('${table}', '${table}_v')`)).rows[0].f as string;
            const before = await files();
            const probes = await probe(asRunner(client), { types: [], typeChanges: [{ from, to }], functions: [], defaults: [], checks: [], relations: [], schemas: [] });
            const cast = probes.casts.get(castKey(from, to));
            let verdict = classifyTypeChange(await columnType(client, table), to, cast);
            try {
                await client.query(`ALTER TABLE ${table} ALTER COLUMN v TYPE ${to} ${using ?? ""}`);
            } catch (error) {
                checks.ok(false, `${from} -> ${to} could not be applied`, error instanceof Error ? error.message : String(error));
                continue;
            }
            const rewritten = (await files()) !== before;
            const label = `${from} -> ${to}`;
            if (!verdict.rewrite && rewritten) checks.ok(false, `${label}: predicted no rewrite, but the table or its index was rewritten`, verdict.reason);
            else checks.ok(true, label);
            if (verdict.rewrite && !rewritten) conservative.push(label);
            verdict = { ...verdict };
            console.log(`  ${label.padEnd(36)} predicted ${verdict.rewrite ? "rewrite   " : "catalog only"}  observed ${rewritten ? "rewrite" : "catalog only"}`);
        }
    });
    if (conservative.length > 0) console.log(`  treated as rewrites although PostgreSQL did not rewrite (safe side): ${conservative.join(", ")}`);
}

async function columnType(client: PgClient, table: string): Promise<string> {
    return (await client.query(`SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attname = 'v'`)).rows[0].t as string;
}


async function healthSection(checks: Checks) {
    await withDatabase(async (client) => {
        const wide = Array.from({ length: 60 }, (_, i) => `c${i} int`).join(", ");
        await client.query(`
          CREATE TABLE healthy (id bigint PRIMARY KEY, owner_id bigint, label text) WITH (autovacuum_enabled = false);
          CREATE TABLE owners (id bigint PRIMARY KEY) WITH (autovacuum_enabled = false);
          ALTER TABLE healthy ADD CONSTRAINT healthy_owner_fk FOREIGN KEY (owner_id) REFERENCES owners (id);
          CREATE INDEX healthy_owner_idx ON healthy (owner_id);
          CREATE TABLE heap_only (a int, b text) WITH (autovacuum_enabled = false);
          CREATE TABLE child_no_index (id bigint PRIMARY KEY, owner_id bigint, a int, b int) WITH (autovacuum_enabled = false);
          ALTER TABLE child_no_index ADD CONSTRAINT child_owner_fk FOREIGN KEY (owner_id) REFERENCES owners (id);
          CREATE INDEX child_a_idx ON child_no_index (a);
          CREATE INDEX child_a_idx_copy ON child_no_index (a);
          CREATE INDEX child_a_b_idx ON child_no_index (a, b);
          CREATE TABLE big_unused (id bigint PRIMARY KEY, payload text) WITH (autovacuum_enabled = false);
          INSERT INTO big_unused SELECT g, repeat(md5(g::text), 4) FROM generate_series(1, 60000) g;
          CREATE INDEX big_unused_payload_idx ON big_unused (payload);
          CREATE TABLE wide (${wide}) WITH (autovacuum_enabled = false);
          CREATE TABLE unvalidated (id bigint PRIMARY KEY, owner_id bigint, n int) WITH (autovacuum_enabled = false);
          ALTER TABLE unvalidated ADD CONSTRAINT unvalidated_n_chk CHECK (n > 0) NOT VALID;
          CREATE TABLE churn (id bigint PRIMARY KEY, v int) WITH (autovacuum_enabled = false);
          INSERT INTO churn SELECT g, 0 FROM generate_series(1, 30000) g;
          CREATE TABLE broken_index (id bigint PRIMARY KEY, v int) WITH (autovacuum_enabled = false);
          INSERT INTO broken_index SELECT g, 1 FROM generate_series(1, 100) g;
          CREATE SEQUENCE nearly_out MAXVALUE 1000;
          CREATE TABLE seq_owner (id bigint PRIMARY KEY DEFAULT nextval('nearly_out')) WITH (autovacuum_enabled = false);
          ALTER SEQUENCE nearly_out OWNED BY seq_owner.id;
          SELECT setval('nearly_out', 800);
          ANALYZE healthy, owners, child_no_index, big_unused, wide, unvalidated, churn, broken_index, seq_owner;
        `);
        await client.query("UPDATE churn SET v = v + 1");
        await client.query("UPDATE churn SET v = v + 1");
        await client.query("INSERT INTO heap_only SELECT g, 'x' FROM generate_series(1, 100) g");
        await client.query("CREATE UNIQUE INDEX CONCURRENTLY broken_idx ON broken_index (v)").catch(() => undefined);
        await client.query("SELECT pg_stat_force_next_flush()").catch(() => undefined);
        // before PostgreSQL 15 the statistics reach the views through a collector, a moment later
        for (let attempt = 0; attempt < 100; attempt++) {
            const seen = (await client.query("SELECT (SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'churn') AS dead, (SELECT count(*) FROM pg_stat_user_tables WHERE relname = 'heap_only') AS heap")).rows[0];
            if (Number(seen.dead) >= 30000 && Number(seen.heap) > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const report = await healthReport(asRunner(client), { thresholds: { unusedIndexMinBytes: 1024 * 1024 } });
        const by = (category: string) => report.findings.filter((finding) => finding.category === category);
        const objects = (category: string) => by(category).map((finding) => finding.object ?? finding.table).sort();

        checks.equal(by("no-primary-key").map((f) => f.table).sort(), ["public.heap_only", "public.wide"], "tables without a primary key, and no others");
        checks.equal(objects("fk-without-index"), ["child_owner_fk"], "the foreign key nothing indexes (and not the one that has an index)");
        checks.equal(objects("duplicate-index"), ["child_a_idx_copy"], "the duplicate index (the first of two identical ones is kept)");
        checks.equal(objects("redundant-index"), ["child_a_idx"], "the index that is the start of a longer one");
        checks.ok(objects("unused-index").includes("big_unused_payload_idx"), "a large index nothing has scanned", objects("unused-index"));
        checks.ok(!objects("unused-index").includes("child_a_b_idx"), "small indexes are not called unused");
        checks.equal(objects("invalid-index"), ["broken_idx"], "the invalid index a failed CONCURRENTLY build left");
        checks.equal(objects("unvalidated-constraint"), ["unvalidated_n_chk"], "the NOT VALID constraint");
        checks.equal(by("wide-table").map((f) => f.table), ["public.wide"], "the wide table");
        checks.equal(by("sequence-near-limit").map((f) => f.detail.owner), ["public.seq_owner.id"], "the sequence at 80% of its range, with the column that uses it");
        checks.ok(by("dead-rows").some((f) => f.table === "public.churn"), "a table with many dead rows", by("dead-rows"));
        checks.ok(by("stale-statistics").some((f) => f.table === "public.heap_only"), "a table that was never analyzed", by("stale-statistics"));
        checks.ok(by("stale-statistics").every((f) => f.table !== "public.healthy"), "an analyzed table is not reported");
        checks.ok(!report.findings.some((f) => f.table === "public.healthy" && f.category !== "stale-statistics"), "the clean table has no findings of its own");
        checks.ok(report.largest[0].table === "public.big_unused", "largest table first", report.largest[0]);
        checks.ok(report.limits.length >= 3, "the limits of the report are listed");
    });
}


// A fake model that answers with a fixed plan, translated into the placeholders it was shown when names are redacted.
async function plannerSection(checks: Checks) {
    const template = `sc_tpl_${process.pid}`;
    await createDatabase(template, async (client) => {
        await client.query(SHOP);
    });
    try {
        await withDatabase(async (client) => {
            const db = asRunner(client);
            const deps = (answer: (call: ModelCall, redactor: Redactor | undefined) => unknown, seen: ModelCall[]) => ({
                loadFacts: (names: string[]) => loadFacts(db, names),
                probe: (request: Parameters<typeof probe>[1]) => probe(db, request),
                wholeDatabase: async () => ({ tables: (await loadCatalog(db)).tables }),
                callModel: async (call: ModelCall) => {
                    seen.push(call);
                    const facts = await loadFacts(db, ["public.orders", "public.customers"]);
                    const redactor = call.context?.redacted ? new Redactor(namesToRedact(facts, (await loadCatalog(db)).tables)) : undefined;
                    return { output: answer(call, redactor), model: "fake", usage: { inputTokens: null, outputTokens: null }, auditId: seen.length, latencyMs: 1 };
                },
            });
            const request = { prompt: "orders are slow to look up by their customer, index them", tables: ["public.orders", "public.customers"], connection: { id: "x", name: "scratch" } };
            const plan = (redactor?: Redactor, indexName = "orders_cust_idx") => {
                const id = (name: string) => redactor?.id(name) ?? name;
                return { summary: "index orders", assumptions: [], warnings: [], clarifyingQuestions: [], operations: [{ type: "add_index", tableName: `${id("public")}.${id("orders")}`, index: { name: indexName, columns: [id("customer_id")] } }] };
            };

            // names in the clear
            const seenPlain: ModelCall[] = [];
            const plain = await planSchemaChange(deps((_call, redactor) => plan(redactor), seenPlain), { ...request, redact: false });
            checks.equal(plain.runbook?.steps.length, 1, "plan -> runbook on the real database, names in the clear");
            checks.ok(JSON.stringify(seenPlain[0].input).includes("customer_id"), "the model is shown the real names when redaction is off");
            const runResult = await runRunbook(client, plain.runbook!);
            checks.ok(runResult.ok, "the runbook the planner produced runs", runResult.failure);

            // names replaced
            const seenMasked: ModelCall[] = [];
            const masked = await planSchemaChange(deps((_call, redactor) => plan(redactor, "orders_cust_idx2"), seenMasked), { ...request, redact: true });
            const sent = JSON.stringify(seenMasked[0].input);

            const real = (await loadFacts(db, request.tables));
            const names = namesToRedact(real, (await loadCatalog(db)).tables).map((entry) => entry.name);
            checks.equal(findLeaks(stringValues(seenMasked[0].input).join("\n"), names), [], "with redaction on, none of the database's names is in what is sent");
            checks.ok(!/customers|orders|email|shipped_at/.test(sent), "spot check: table and column names are absent from the request");
            checks.ok(/"scans":\d+/.test(sent) && /"dataBytes":\d+/.test(sent), "sizes and usage counters are still there");
            checks.equal(masked.plan.operations[0], { ...plain.plan.operations[0], index: { name: "orders_cust_idx2", columns: ["customer_id"] } }, "the answer is translated back to the real names");
            checks.equal(masked.runbook?.steps[0].sql, plain.runbook?.steps[0].sql.replace("orders_cust_idx", "orders_cust_idx2"), "and compiles to the same SQL");
            checks.ok(masked.redacted, "the result says names were redacted");
        }, { template });
    } finally {
        await dropDatabase(template);
    }
}

async function dropsSection(checks: Checks) {
    // What the runbook says a column drop takes with it must be exactly what PostgreSQL removes.
    const cases: { column: string; label: string }[] = [
        { column: "a", label: "a column that is a prefix of another column's name and used in a two-column CHECK" },
        { column: "deleted_at", label: "a column used only in a partial index's WHERE" },
        { column: "status", label: "a column used in a key, a partial predicate and an expression index" },
        { column: "payload", label: "a column used only as an INCLUDE column" },
    ];
    for (const { column, label } of cases) {
        await withDatabase(async (client) => {
            await client.query(`
                CREATE TABLE ev (id bigint PRIMARY KEY, status text, deleted_at timestamptz, payload text, a int, aa int, b int,
                    CONSTRAINT ev_aa_positive CHECK (aa > 0), CONSTRAINT ev_a_b CHECK (a < b));
                CREATE INDEX ev_live ON ev (status) WHERE deleted_at IS NULL;
                CREATE INDEX ev_lower ON ev (lower(status));
                CREATE INDEX ev_cover ON ev (id) INCLUDE (payload);
                INSERT INTO ev SELECT g, 's', now(), 'p', g, g, g + 1 FROM generate_series(1, 200) g;
                ANALYZE;`);
            const names = async () => new Set<string>((await client.query(`SELECT relname AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'i' UNION ALL SELECT conname FROM pg_constraint WHERE conrelid = 'ev'::regclass AND contype = 'c'`)).rows.map((row) => row.n as string));
            const before = await names();
            const { runbook } = await compileOn(client, parsePlan([{ type: "drop_column", tableName: "ev", columnName: column }]), ["public.ev"]);
            const notes = runbook.steps[0].notes.join(" ");
            const predicted = new Set<string>();
            for (const match of notes.matchAll(/(?:Indexes|CHECK constraints?|Foreign keys) dropped with it: ([^.]*)\./g)) for (const name of match[1].split(", ")) predicted.add(name.replace(/ \(used.*$/, "").trim());
            const result = await runRunbook(client, runbook);
            checks.ok(result.ok, `drop ${column} ran`, result.failure?.message);
            const after = await names();
            const actual = new Set([...before].filter((name) => !after.has(name)));
            const same = predicted.size === actual.size && [...actual].every((name) => predicted.has(name));
            checks.ok(same, `drop ${column}: ${label}`, `predicted ${[...predicted].sort().join(", ") || "nothing"}; PostgreSQL dropped ${[...actual].sort().join(", ") || "nothing"}`);
        });
    }
}

async function dependentsSection(checks: Checks) {
    // The compiler must refuse exactly what PostgreSQL refuses (without CASCADE) because something depends on the column or table.
    await withDatabase(async (client) => {
        await client.query(`
            CREATE TABLE t (id bigserial PRIMARY KEY, price numeric, qty int, total numeric GENERATED ALWAYS AS (price * qty) STORED, note text, region text, ident int GENERATED ALWAYS AS IDENTITY, plain int DEFAULT 5);
            CREATE VIEW v AS SELECT id, price FROM t;
            CREATE FUNCTION trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
            CREATE TRIGGER t_note AFTER UPDATE OF note ON t FOR EACH ROW EXECUTE FUNCTION trg();
            CREATE TRIGGER t_when BEFORE INSERT ON t FOR EACH ROW WHEN (NEW.region IS NOT NULL) EXECUTE FUNCTION trg();
            ALTER TABLE t ENABLE ROW LEVEL SECURITY;
            CREATE POLICY p ON t USING (region = 'eu');
            CREATE STATISTICS st ON price, qty FROM t;
            ${MAJOR >= 14 ? "CREATE FUNCTION sqlf(t) RETURNS numeric LANGUAGE sql BEGIN ATOMIC SELECT $1.price; END;" : ""}
            CREATE TABLE u (id int PRIMARY KEY, x int);
            CREATE TABLE other (id int, n int);
            ALTER TABLE other ENABLE ROW LEVEL SECURITY;
            CREATE POLICY op ON other USING (n IN (SELECT id FROM u));
            ${MAJOR >= 14 ? "CREATE FUNCTION atomicf() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT count(*)::int FROM u; END;" : ""}
            INSERT INTO t (price, qty, note, region) SELECT g, g, 'n', 'eu' FROM generate_series(1, 100) g;
            ANALYZE;`);
        const refused = async (statement: string): Promise<boolean> => {
            await client.query("BEGIN");
            try {
                await client.query(statement);
                return false;
            } catch {
                return true;
            } finally {
                await client.query("ROLLBACK");
            }
        };
        const cases: { label: string; operation: Record<string, unknown>; statement: string; tables: string[] }[] = [];
        for (const column of ["id", "price", "qty", "total", "note", "region", "ident", "plain"]) {
            cases.push({ label: `drop column ${column}`, operation: { type: "drop_column", tableName: "t", columnName: column }, statement: `ALTER TABLE t DROP COLUMN ${column}`, tables: ["public.t"] });
        }
        for (const [column, to] of [["price", "numeric(12,2)"], ["qty", "bigint"], ["note", "varchar(50)"], ["region", "varchar(50)"], ["plain", "bigint"], ["total", "numeric(12,2)"]] as const) {
            cases.push({ label: `${column} to ${to}`, operation: { type: "alter_column", tableName: "t", columnName: column, changes: { dataType: to } }, statement: `ALTER TABLE t ALTER COLUMN ${column} TYPE ${to}`, tables: ["public.t"] });
        }
        cases.push({ label: "drop table u", operation: { type: "drop_table", tableName: "u" }, statement: "DROP TABLE u", tables: ["public.u"] });
        cases.push({ label: "drop table other", operation: { type: "drop_table", tableName: "other" }, statement: "DROP TABLE other", tables: ["public.other"] });
        for (const { label, operation, statement, tables } of cases) {
            const { runbook } = await compileOn(client, parsePlan([operation]), tables);
            const compilerRefuses = runbook.findings.some((finding) => finding.severity === "error" && finding.code === "dependents");
            const otherRefusal = runbook.findings.filter((finding) => finding.severity === "error" && finding.code !== "dependents").map((finding) => finding.code);
            const postgresRefuses = await refused(statement);
            // a refusal for another reason (a key, a view) is fine only when PostgreSQL refuses too
            const agree = compilerRefuses === postgresRefuses || (!compilerRefuses && postgresRefuses && otherRefusal.length > 0);
            checks.ok(agree, label, `compiler ${compilerRefuses ? "refuses (dependents)" : otherRefusal.length ? `refuses (${otherRefusal.join(", ")})` : "allows"}; PostgreSQL ${postgresRefuses ? "refuses" : "allows"}`);
        }
    });
}

async function lockWaitSection(checks: Checks) {
    // A step that needs ACCESS EXCLUSIVE while another session holds a lock on the table: it must retry, give up cleanly, and not stall readers for long.
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await withDatabase(async (client, name) => {
        await client.query("CREATE TABLE orders (id bigint PRIMARY KEY, qty int); INSERT INTO orders SELECT g, g FROM generate_series(1, 1000) g; ANALYZE;");
        const columns = async (table = "orders") => (await client.query(`SELECT attname FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`)).rows.map((row) => row.attname as string);
        const compileStep = async (settings: { lockTimeoutSeconds: number; lockAttempts: number }, column: string) => {
            const { runbook } = await compileOn(client, parsePlan([{ type: "add_column", tableName: "orders", field: { name: column, dataType: "text" } }]), ["public.orders"], settings);
            // the table is small here, so the step is wrapped only when the compiler treats it as locking: force the check
            return runbook;
        };

        // 1. the holder lets go after ~2.5s: the step waits, retries and succeeds
        {
            const holder = await connect(name);
            const runner = await connect(name);
            const reader = await connect(name);
            try {
                const runbook = await compileStep({ lockTimeoutSeconds: 1, lockAttempts: 8 }, "note_a");
                checks.ok(runbook.steps[0].sql.includes("$retry$"), "the step is wrapped in the retry block");
                await holder.query("BEGIN");
                await holder.query("SELECT count(*) FROM orders");
                let release = false;
                const latencies: number[] = [];
                const probing = (async () => {
                    while (!release) {
                        const started = Date.now();
                        await reader.query("SELECT 1 FROM orders LIMIT 1");
                        latencies.push(Date.now() - started);
                        await sleep(100);
                    }
                })();
                const started = Date.now();
                setTimeout(() => void holder.query("COMMIT"), 2500);
                const result = await runRunbook(runner, runbook);
                const elapsed = Date.now() - started;
                release = true;
                await probing;
                checks.ok(result.ok, "retried until the holder let go, then ran", result.failure?.message);
                checks.ok(elapsed >= 2000, `it really waited (${elapsed} ms)`);
                checks.ok((await columns()).includes("note_a"), "and the change was made");
                const worst = Math.max(...latencies);
                checks.ok(worst < 2500, `a reader was never stalled for long while it waited (worst ${worst} ms over ${latencies.length} reads, per-attempt limit 1000 ms)`);
            } finally {
                await holder.query("ROLLBACK").catch(() => undefined);
                await Promise.all([holder.end(), runner.end(), reader.end()].map((end) => end.catch(() => undefined)));
            }
        }

        // 2. the holder never lets go: the step gives up, changes nothing, and says who holds the table
        {
            const holder = await connect(name);
            const runner = await connect(name);
            try {
                const runbook = await compileStep({ lockTimeoutSeconds: 1, lockAttempts: 3 }, "note_b");
                await holder.query("BEGIN");
                const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
                await holder.query("SELECT count(*) FROM orders /* long report */");
                const started = Date.now();
                const result = await runRunbook(runner, runbook);
                const elapsed = Date.now() - started;
                checks.ok(!result.ok, "gave up when the table never became free");
                const message = result.failure?.message ?? "";
                checks.ok(/Gave up after 3 attempts/.test(message), "says how many attempts it made", message);
                checks.ok(message.includes(`pid ${holderPid}`), "names the session holding the table", message);
                checks.ok(message.includes("long report"), "shows what that session is running", message);
                checks.ok(!(await columns()).includes("note_b"), "and changed nothing");
                // that it stops is what is checked, not how fast: a loaded machine makes the attempts slow
                checks.ok(elapsed < 180000, `and it stopped (${elapsed} ms)`);
            } finally {
                await holder.query("ROLLBACK").catch(() => undefined);
                await Promise.all([holder.end(), runner.end()].map((end) => end.catch(() => undefined)));
            }
        }

        // 2b. the same, run by a role that may not read other roles' sessions: the holder is still named, as another role
        {
            const low = `lw_low_${process.pid}`;
            await client.query(`CREATE ROLE ${low}; CREATE TABLE orders_low (id int PRIMARY KEY); ALTER TABLE orders_low OWNER TO ${low}; GRANT USAGE ON SCHEMA public TO ${low}`);
            const holder = await connect(name);
            const runner = await connect(name);
            try {
                await runner.query(`SET ROLE ${low}`);
                const { runbook } = await compileOn(runner, parsePlan([{ type: "add_column", tableName: "orders_low", field: { name: "note", dataType: "text" } }]), ["public.orders_low"], { lockTimeoutSeconds: 1, lockAttempts: 2 });
                await holder.query("BEGIN");
                await holder.query("LOCK TABLE orders_low IN ACCESS SHARE MODE");
                const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
                const result = await runRunbook(runner, runbook);
                const message = result.failure?.message ?? "";
                checks.ok(!result.ok && message.includes(`pid ${holderPid}`) && message.includes("another role"), "a role that cannot read other sessions still gets the holder's pid, as another role", message);
                checks.ok(!message.includes("()"), "and not an empty description", message);
            } finally {
                await holder.query("ROLLBACK").catch(() => undefined);
                await Promise.all([holder.end(), runner.end()].map((end) => end.catch(() => undefined)));
                await client.query(`DROP TABLE IF EXISTS orders_low; DROP OWNED BY ${low}; DROP ROLE IF EXISTS ${low}`);
            }
        }

        // 3. the column swap is atomic inside the block: when it gives up, neither rename happened
        {
            const holder = await connect(name);
            const runner = await connect(name);
            try {
                await client.query("CREATE TABLE big (id bigint PRIMARY KEY, amount int, pad text); INSERT INTO big SELECT g, g, repeat('x', 40) FROM generate_series(1, 300000) g; ANALYZE big;");
                const { runbook } = await compileOn(client, parsePlan([{ type: "alter_column", tableName: "big", columnName: "amount", changes: { dataType: "bigint" } }]), ["public.big"], { lockTimeoutSeconds: 1, lockAttempts: 2 });
                const swap = runbook.steps.find((step) => step.title.startsWith("Swap"));
                if (swap) {
                    // run everything before the swap, hold the table, then try the swap alone
                    const before = { ...runbook, steps: runbook.steps.slice(0, runbook.steps.indexOf(swap)) };
                    const prepared = await runRunbook(runner, before);
                    checks.ok(prepared.ok, "the steps before the swap ran", prepared.failure?.message);
                    await holder.query("BEGIN");
                    await holder.query("SELECT count(*) FROM big");
                    const attempt = await runRunbook(runner, { ...runbook, steps: [swap] });
                    checks.ok(!attempt.ok && /Gave up after 2 attempts/.test(attempt.failure?.message ?? ""), "the swap gave up while the table was held", attempt.failure?.message);
                    const names = await columns("big");
                    checks.ok(names.includes("amount") && !names.includes("amount__old"), "and neither rename happened", names.join(", "));
                    await holder.query("ROLLBACK");
                    const again = await runRunbook(runner, { ...runbook, steps: [swap] });
                    checks.ok(again.ok, "run again when the table is free, the swap went through", again.failure?.message);
                    checks.ok((await columns("big")).includes("amount__old"), "and both renames happened");
                } else {
                    checks.ok(false, "no swap step found for the type change", runbook.steps.map((step) => step.title).join(" | "));
                }
            } finally {
                await holder.query("ROLLBACK").catch(() => undefined);
                await Promise.all([holder.end(), runner.end()].map((end) => end.catch(() => undefined)));
            }
        }
    });
}

async function preflightSection(checks: Checks) {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await withDatabase(async (client, name) => {
        await client.query("CREATE TABLE orders (id bigint PRIMARY KEY, qty int); CREATE TABLE other (id int); INSERT INTO orders SELECT g, g FROM generate_series(1, 100) g; ANALYZE;");
        const run = async (tables: string[]) => {
            const probe = await connect(name);
            try {
                return await preflight(asRunner(probe) as never, tables);
            } finally {
                await probe.end();
            }
        };
        const status = (report: Awaited<ReturnType<typeof run>>, id: string) => report.checks.find((check) => check.id === id)!;

        // a quiet database
        {
            const report = await run(["public.orders"]);
            checks.ok(report.checks.every((check) => check.status === "ok"), "a quiet database passes every check", report.checks.filter((check) => check.status !== "ok").map((check) => `${check.id}: ${check.status}`).join(", "));
            checks.ok(report.serverVersion.startsWith(String(MAJOR)), `reads the server version (${report.serverVersion})`);
        }

        // a session in a transaction on the table, and none on another table
        const holder = await connect(name);
        const waiter = await connect(name);
        const pid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        try {
            await holder.query("BEGIN");
            await holder.query("UPDATE orders SET qty = qty WHERE id = 1 /* nightly report */");
            const original = PREFLIGHT_LIMITS.longTransactionSeconds;
            try {
                const report = await run(["public.orders"]);
                const sessions = status(report, "sessions");
                checks.ok(sessions.status === "warn" && sessions.items.some((item) => item.includes(`pid ${pid}`) && item.includes("nightly report") && item.includes("public.orders")), "a session with a transaction open on the table is named, with its query", JSON.stringify(sessions));
                checks.equal(status(await run(["public.other"]), "sessions").status, "ok", "the same session is not reported for a table it does not use");

                await sleep(1200);
                PREFLIGHT_LIMITS.longTransactionSeconds = 1;
                const later = status(await run(["public.orders"]), "sessions");
                checks.ok(later.status === "warn" && /open 1s or more/.test(later.detail), "and once it has been open long enough, it is called long", later.detail);
            } finally {
                PREFLIGHT_LIMITS.longTransactionSeconds = original;
            }

            // a strong lock held, and one queued behind it
            await holder.query("LOCK TABLE orders IN SHARE MODE");
            await waiter.query("SET lock_timeout = '20s'");
            const queued = waiter.query("ALTER TABLE orders ADD COLUMN waiting int").catch(() => undefined);
            await sleep(500);
            const report = await run(["public.orders"]);
            const locks = status(report, "locks");
            checks.ok(locks.status === "warn" && locks.items.some((item) => item.includes(`pid ${pid}: ShareLock on public.orders`)), "a strong lock held by another session is reported", JSON.stringify(locks.items));
            checks.ok(locks.items.some((item) => item.includes("AccessExclusiveLock") && item.includes("(waiting)")), "and so is the ACCESS EXCLUSIVE request queued behind it", JSON.stringify(locks.items));
            await holder.query("ROLLBACK");
            await queued;
        } finally {
            await holder.query("ROLLBACK").catch(() => undefined);
            await Promise.all([holder.end(), waiter.end()].map((end) => end.catch(() => undefined)));
        }

        // a role that is not allowed to read other roles' sessions (no pg_read_all_stats) still finds who holds the table
        {
            await client.query(`CREATE ROLE pf_low_${process.pid}`);
            const other = await connect(name);
            const low = await connect(name);
            try {
                await other.query("BEGIN");
                await other.query("UPDATE orders SET qty = qty WHERE id = 2");
                await low.query(`SET ROLE pf_low_${process.pid}`);
                const visible = await low.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND backend_type IS NULL");
                checks.ok(Number(visible.rows[0].n) > 0, "setup: this role really cannot read the other session's details");
                const report = await preflight(asRunner(low) as never, ["public.orders"]);
                const sessions = status(report, "sessions");
                checks.ok(sessions.status === "warn" && sessions.items.some((item) => item.includes("another role") && item.includes("public.orders")), "a low-privilege role still finds the session holding the table, from pg_locks", JSON.stringify(sessions));
                checks.equal(status(await preflight(asRunner(low) as never, ["public.other"]), "sessions").status, "ok", "and reports nothing for a table that session does not hold");
            } finally {
                await other.query("ROLLBACK").catch(() => undefined);
                await Promise.all([other.end(), low.end()].map((end) => end.catch(() => undefined)));
                await client.query(`DROP ROLE IF EXISTS pf_low_${process.pid}`);
            }
        }

        // a slot nothing reads
        await client.query("SELECT pg_create_physical_replication_slot('preflight_idle_slot', true)");
        try {
            const slots = status(await run(["public.orders"]), "slots");
            checks.ok(slots.status === "warn" && slots.items.some((item) => item.includes("preflight_idle_slot") && item.includes("inactive")), "an inactive replication slot is reported", JSON.stringify(slots));
        } finally {
            await client.query("SELECT pg_drop_replication_slot('preflight_idle_slot')");
        }

        // a role timeout
        await client.query(`ALTER DATABASE ${name} SET statement_timeout = '45s'`);
        {
            const timeouts = status(await run(["public.orders"]), "timeouts");
            checks.ok(timeouts.status === "warn" && timeouts.items.some((item) => item.includes("statement_timeout = 45000ms")), "a statement_timeout set for the database is reported", JSON.stringify(timeouts));
        }
        await client.query(`ALTER DATABASE ${name} RESET statement_timeout`);
    });
}

async function modelSection(checks: Checks) {
    // The compiler plans each step against its own model of the tables. Run every scenario's runbook (the steps that run by default), read the
    // catalog again and compare it with the state the compiler said it would leave: a difference is a bug in a step or in the model.
    const template = `sc_model_${process.pid}`;
    await createDatabase(template, async (client) => {
        await client.query(SHOP);
    });
    // Scenarios of its own, on the same data, for the operations the others leave out; `setup` runs first.
    const own: { name: string; setup?: string; tables: string[]; operations: unknown[] }[] = [
        { name: "rename a table", tables: ["public.tags"], operations: [{ type: "rename_table", tableName: "tags", newName: "labels" }] },
        {
            name: "drop a foreign key",
            setup: "ALTER TABLE order_items ADD CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)",
            tables: ["public.orders", "public.order_items"],
            operations: [{ type: "drop_relationship", sourceTable: "orders", sourceColumn: "id", targetTable: "order_items", targetColumn: "order_id" }],
        },
        {
            name: "drop a column that has a CHECK and a partial index",
            setup: "ALTER TABLE orders ADD CONSTRAINT orders_total_positive CHECK (total >= 0); CREATE INDEX orders_open_idx ON orders (status) WHERE shipped_at IS NULL",
            tables: ["public.orders"],
            operations: [{ type: "drop_column", tableName: "orders", columnName: "total" }, { type: "drop_column", tableName: "orders", columnName: "shipped_at" }],
        },
        {
            name: "drop a check and a unique constraint",
            setup: "ALTER TABLE orders ADD CONSTRAINT orders_qty_ck CHECK (qty >= 0); ALTER TABLE customers ADD CONSTRAINT customers_email_key UNIQUE (email)",
            tables: ["public.orders", "public.customers"],
            operations: [{ type: "drop_constraint", tableName: "orders", constraintName: "orders_qty_ck" }, { type: "drop_constraint", tableName: "customers", constraintName: "customers_email_key" }],
        },
        {
            name: "add a check and a unique constraint, then drop a column the check uses",
            tables: ["public.orders", "public.customers"],
            operations: [
                { type: "add_check", tableName: "orders", expression: "qty >= 0 AND total >= 0" },
                { type: "add_unique", tableName: "customers", columns: ["email", "name"] },
                { type: "drop_column", tableName: "orders", columnName: "total" },
            ],
        },
        { name: "add a unique column", tables: ["public.customers"], operations: [{ type: "add_column", tableName: "customers", field: { name: "handle", dataType: "text", unique: true } }] },
        {
            name: "rename a column and index it under its new name",
            tables: ["public.orders"],
            operations: [{ type: "alter_column", tableName: "orders", columnName: "note", changes: { newName: "memo" } }, { type: "add_index", tableName: "orders", index: { name: "orders_memo_idx", columns: ["memo"] } }],
        },
        {
            name: "change a type that has an index and a partial index",
            setup: "CREATE INDEX orders_qty_open_idx ON orders (qty) WHERE shipped_at IS NULL",
            tables: ["public.orders"],
            operations: [{ type: "alter_column", tableName: "orders", columnName: "qty", changes: { dataType: "bigint" } }],
        },
    ];
    let compared = 0;
    try {
        const scenarios = [...SCENARIOS.filter((scenario) => !(scenario.refused || scenario.name.includes("(fails") || scenario.name.includes("has NULLs"))).map((scenario) => ({ name: scenario.name, tables: scenario.tables, operations: scenario.operations, setup: scenario.setup })), ...own];
        for (const scenario of scenarios) {
            await withDatabase(async (client) => {
                if (scenario.setup) await client.query(scenario.setup);
                const { runbook } = await compileOn(client, parsePlan(scenario.operations), scenario.tables);
                const result = await runRunbook(client, runbook);
                if (!result.ok) {
                    checks.ok(false, `${scenario.name}: the runbook ran`, result.failure);
                    return;
                }
                const names = [...runbook.expected.tables.map((table) => table.qualified), ...runbook.expected.absent];
                const actual = await loadFacts(asRunner(client), names);
                const mismatches = diffExpected(runbook.expected, actual);
                compared++;
                checks.ok(mismatches.length === 0, `${scenario.name}: the database is as the compiler said`, mismatches.map((mismatch) => `${mismatch.table}: ${mismatch.message}`));
            }, { template });
        }
    } finally {
        await dropDatabase(template);
    }
    checks.ok(compared >= 16, `compared ${compared} scenarios with the catalog`);
}

async function renameSection(checks: Checks) {
    // Renaming a table leaves a view under the old name: it has to behave like the table did, for the roles that used it, and go away on the contract step.
    const suffix = process.pid;
    const app = `rn_app_${suffix}`;
    const readonly = `rn_ro_${suffix}`;
    await withDatabase(async (client, name) => {
        await client.query(`
            CREATE ROLE ${app}; CREATE ROLE ${readonly};
            CREATE TABLE items (id bigserial PRIMARY KEY, name text NOT NULL DEFAULT 'unnamed', qty int, owner_name text);
            CREATE TABLE item_notes (id serial PRIMARY KEY, item_id bigint REFERENCES items (id), note text);
            INSERT INTO items (qty, owner_name) SELECT g, CASE WHEN g % 2 = 0 THEN '${app}' ELSE 'someone_else' END FROM generate_series(1, 200) g;
            GRANT USAGE ON SCHEMA public TO ${app}, ${readonly};
            GRANT SELECT, INSERT, UPDATE, DELETE ON items TO ${app};
            GRANT USAGE ON SEQUENCE items_id_seq TO ${app};
            GRANT SELECT ON items TO ${readonly};
            ANALYZE;`);
        const renameOps = [{ type: "rename_table", tableName: "items", newName: "things" }];
        const { runbook } = await compileOn(client, parsePlan(renameOps), ["public.items"]);
        checks.ok(runbook.steps[0].sql.includes("CREATE VIEW"), "the rename compiles with a compatibility view", runbook.steps.map((step) => step.title));
        const ran = await runRunbook(client, runbook);
        checks.ok(ran.ok, "the rename step runs", ran.failure);

        const as = async (role: string, sql: string) => {
            const session = await connect(name);
            try {
                await session.query(`SET ROLE ${role}`);
                return await session.query(sql);
            } finally {
                await session.end();
            }
        };
        checks.equal(Number((await as(app, "SELECT count(*)::int AS n FROM items")).rows[0].n), 200, "the old name still reads, for a role that was granted on the table");
        const inserted = await as(app, "INSERT INTO items (qty) VALUES (500) RETURNING id, name");
        checks.ok(Number(inserted.rows[0].id) > 200 && inserted.rows[0].name === "unnamed", "an INSERT through the old name gets the table's defaults (sequence and constant)", inserted.rows[0]);
        await as(app, "UPDATE items SET qty = 501 WHERE qty = 500");
        checks.equal(Number((await client.query("SELECT count(*)::int AS n FROM things WHERE qty = 501")).rows[0].n), 1, "an UPDATE through the old name changes the table");
        await as(app, "DELETE FROM items WHERE qty = 501");
        checks.equal(Number((await client.query("SELECT count(*)::int AS n FROM things WHERE qty = 501")).rows[0].n), 0, "and a DELETE removes the row");
        checks.equal(Number((await as(readonly, "SELECT count(*)::int AS n FROM items")).rows[0].n), 200, "a read-only role still reads through the old name");
        await as(readonly, "INSERT INTO items (qty) VALUES (1)").then(() => checks.ok(false, "a read-only role still cannot write"), () => checks.ok(true, "a read-only role still cannot write"));
        await client.query("INSERT INTO item_notes (item_id, note) VALUES (1, 'kept')");
        checks.equal(Number((await client.query("SELECT count(*)::int AS n FROM item_notes n JOIN things t ON t.id = n.item_id")).rows[0].n), 1, "a foreign key from another table follows the renamed table");
        const kind = (await client.query("SELECT relkind::text AS k FROM pg_class WHERE oid = 'items'::regclass")).rows[0].k;
        checks.equal(kind, "v", "the old name is a view");

        // the catalog is as the compiler said, the old name included
        const actual = await loadFacts(asRunner(client), [...runbook.expected.tables.map((table) => table.qualified), ...runbook.expected.absent]);
        const mismatches = diffExpected(runbook.expected, actual);
        checks.ok(mismatches.length === 0, "the catalog matches the compiler's expected state", mismatches.map((mismatch) => mismatch.message));

        // a table behind the view cannot have its columns dropped until the view is gone: the compiler knows
        const { runbook: drop } = await compileOn(client, parsePlan([{ type: "drop_column", tableName: "things", columnName: "owner_name" }]), ["public.things"]);
        checks.ok(drop.findings.some((finding) => finding.code === "dependents"), "later changes to a listed column are refused while the view exists", drop.findings.map((finding) => finding.message));

        // the contract step takes the old name away
        const contract = runbook.steps.find((step) => step.optional)!;
        const done = await runRunbook(client, { ...runbook, steps: [contract] }, { includeOptional: true });
        checks.ok(done.ok, "the contract step runs", done.failure);
        await client.query("SELECT 1 FROM items").then(() => checks.ok(false, "the old name is gone after the contract step"), () => checks.ok(true, "the old name is gone after the contract step"));
    });

    // undo: the view goes and the table gets its name back
    await withDatabase(async (client) => {
        await client.query("CREATE TABLE items (id int PRIMARY KEY); INSERT INTO items VALUES (1);");
        const { runbook } = await compileOn(client, parsePlan([{ type: "rename_table", tableName: "items", newName: "things" }]), ["public.items"]);
        await runRunbook(client, runbook);
        for (const statement of splitSqlStatements(runbook.steps[0].undo ?? "")) await client.query(statement.text);
        checks.equal((await client.query("SELECT relkind::text AS k FROM pg_class WHERE oid = 'items'::regclass")).rows[0].k, "r", "undo puts the table back under its name");
        checks.equal((await client.query("SELECT to_regclass('things')::text AS t")).rows[0].t, null, "and the new name is gone");
    });

    // row-level security: from 15 the view applies the caller's policies; before that it is refused
    await withDatabase(async (client, name) => {
        await client.query(`
            CREATE TABLE ledger (id serial PRIMARY KEY, owner_name text, amount int);
            INSERT INTO ledger (owner_name, amount) SELECT CASE WHEN g % 2 = 0 THEN '${app}' ELSE 'someone_else' END, g FROM generate_series(1, 100) g;
            ALTER TABLE ledger ENABLE ROW LEVEL SECURITY;
            CREATE POLICY mine ON ledger USING (owner_name = current_user);
            GRANT USAGE ON SCHEMA public TO ${app}; GRANT SELECT ON ledger TO ${app};`);
        const { runbook } = await compileOn(client, parsePlan([{ type: "rename_table", tableName: "ledger", newName: "ledger_entries" }]), ["public.ledger"]);
        if (MAJOR < 15) {
            checks.ok(runbook.findings.some((finding) => finding.code === "unsupported" && /row-level security/.test(finding.message)), "before PostgreSQL 15 a table with row-level security is refused");
        } else {
            const ran = await runRunbook(client, runbook);
            checks.ok(ran.ok, "the rename of a table with row-level security runs", ran.failure);
            const session = await connect(name);
            try {
                await session.query(`SET ROLE ${app}`);
                const seen = Number((await session.query("SELECT count(*)::int AS n FROM ledger")).rows[0].n);
                checks.equal(seen, 50, "through the old name the caller still sees only the rows its policy allows");
            } finally {
                await session.end();
            }
        }
    });

    const admin = await connect();
    try {
        for (const role of [app, readonly]) await admin.query(`DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    } finally {
        await admin.end();
    }
}

const sections: Record<string, Section> = {
    async drops(checks) {
        await dropsSection(checks);
    },

    async dependents(checks) {
        await dependentsSection(checks);
    },

    async lockwait(checks) {
        await lockWaitSection(checks);
    },

    async preflight(checks) {
        await preflightSection(checks);
    },

    async model(checks) {
        await modelSection(checks);
    },

    async rename(checks) {
        await renameSection(checks);
    },


    async planner(checks) {
        await plannerSection(checks);
    },


    async health(checks) {
        await healthSection(checks);
    },


    async locks(checks) {
        await locksSection(checks);
    },

    async rewrites(checks) {
        await rewritesSection(checks);
    },


    async compile(checks) {
        await compileSection(checks, process.argv[3]);
    },

    async catalog(checks) {
        await withDatabase(async (client) => {
            await client.query(FIXTURE);
            const catalog = await loadCatalog(asRunner(client));
            const names = catalog.tables.map((table) => table.qualified);
            checks.equal(names, ["billing.invoices", "public.customers", "public.events", "public.never_analyzed", "public.order_items", "public.orders"], "catalog lists tables, with partitioned parent and no partitions");
            checks.ok(Math.floor(catalog.serverVersionNum / 10000) === MAJOR, "reports the server version", catalog.serverVersion);

            const events = catalog.tables.find((table) => table.name === "events");
            checks.ok(events?.partitioned && events.partitionCount === 2, "partitioned table is counted with its partitions", events);
            checks.equal(events?.estimatedRows, 300, "partitioned parent's row estimate is the sum of its partitions");

            const orders = catalog.tables.find((table) => table.name === "orders");
            checks.equal(orders?.primaryKey, ["id"], "primary key columns");
            checks.equal(orders?.estimatedRows, 5000, "row estimate comes from reltuples after ANALYZE");
            checks.ok((orders?.totalBytes ?? 0) > 100_000, "total size includes indexes", orders?.totalBytes);
            checks.equal(orders?.foreignKeys.map((fk) => [fk.columns, `${fk.refSchema}.${fk.refTable}`, fk.refColumns, fk.validated]), [[["customer_id"], "public.customers", ["id"], true]], "foreign keys with their columns");

            const items = catalog.tables.find((table) => table.name === "order_items");
            checks.equal(items?.foreignKeys[0]?.validated, false, "a NOT VALID foreign key is reported as not validated");
            checks.equal(catalog.tables.find((table) => table.name === "never_analyzed")?.estimatedRows, null, "a table never analyzed reports unknown rows, not zero");
            checks.equal(items?.estimatedRows, 0, "an analyzed empty table reports zero");
        });
    },

    async retrieval(checks) {
        await withDatabase(async (client) => {
            await client.query(FIXTURE);
            const index = buildSearchIndex(await loadCatalog(asRunner(client)));
            const scope = selectScope(index, "add a note to every order item");
            const picked = new Map(scope.tables.map((table) => [table.qualified, table]));
            checks.equal(picked.get("public.order_items")?.origin, "match", "names the table the request is about");
            checks.equal(picked.get("public.customers")?.origin, "neighbour", "adds the table a matched table points at");
            checks.equal(picked.get("public.customers")?.reasons[0], { kind: "referenced-by", from: "public.orders" }, "and says why");
            checks.equal(selectScope(index, "index invoices by due date").tables[0]?.qualified, "billing.invoices", "finds a schema-qualified table by its words");
        });
    },

    async facts(checks) {
        await withDatabase(async (client) => {
            await client.query(FIXTURE);
            const facts = await loadFacts(asRunner(client), ["public.orders", "public.order_items", "public.events", "billing.invoices"]);
            const orders = facts.tables.get("public.orders");
            checks.ok(orders, "loads the requested tables");
            if (!orders) return;

            checks.equal(orders.estimatedRows, 5000, "row estimate");
            checks.ok(orders.heapBytes > 0 && orders.indexBytes > 0 && orders.totalBytes >= orders.heapBytes + orders.indexBytes, "heap, index and total size are separate facts", orders);
            checks.equal(orders.columns.map((column) => column.name), ["id", "customer_id", "status", "mood", "total", "shipped_at"], "columns in order");

            const column = (name: string) => orders.columns.find((candidate) => candidate.name === name);
            checks.equal(column("id")?.generated, "always-identity", "identity column");
            checks.equal(column("status")?.type, "character varying(20)", "type as format_type prints it");
            checks.equal(column("status")?.default, "'new'::character varying", "default expression");
            checks.equal(column("mood")?.typeSchema, "public", "a type defined in the database is marked by its schema");
            checks.equal(column("total")?.type, "numeric(12,2)", "numeric precision and scale");
            checks.equal(column("shipped_at")?.nullFraction, 1, "NULL fraction from the statistics (all rows have no shipped_at)");
            checks.equal(column("customer_id")?.notNull, true, "NOT NULL");

            checks.equal(orders.checks.map((check) => check.name), ["orders_total_positive"], "check constraints");
            checks.equal(orders.foreignKeys.map((fk) => fk.name), ["orders_customer_id_fkey"], "foreign keys");
            checks.equal(orders.referencedBy.map((fk) => `${fk.schema}.${fk.table}`).sort(), ["billing.invoices", "public.order_items"], "foreign keys that point at the table");
            checks.equal(orders.dependentViews, ["public.open_orders"], "views that depend on the table");

            const partial = orders.indexes.find((index) => index.name === "orders_status_open_idx");
            checks.ok(partial?.partial === true && partial.columns[0] === "status", "partial index", partial);
            const primary = orders.indexes.find((index) => index.primary);
            checks.ok(primary?.constraint === "orders_pkey" && primary.unique, "the index behind a primary key names its constraint", primary);
            checks.equal(orders.primaryKey, ["id"], "primary key from the index");
            const customerIndex = orders.indexes.find((index) => index.name === "orders_customer_idx");
            checks.equal(customerIndex?.scans, 0, "index usage counter (never scanned)");
            checks.ok((customerIndex?.bytes ?? 0) > 0, "index size");
            checks.ok(orders.stats !== null && orders.stats.liveTuples >= 0, "table statistics");

            const items = facts.tables.get("public.order_items");
            checks.equal(items?.foreignKeys[0]?.validated, false, "NOT VALID foreign key carries validated = false");

            const events = facts.tables.get("public.events");
            checks.ok(events?.partitioned && events.partitionCount === 2 && events.partitions.length === 2, "partitions are listed", events?.partitions);
            checks.equal(events?.estimatedRows, 300, "partitioned estimate");

            checks.ok(Math.floor(facts.serverVersionNum / 10000) === MAJOR, "server version");
        });
    },

    async probe(checks) {
        await withDatabase(async (client) => {
            await client.query(FIXTURE);
            const probes = await probe(asRunner(client), {
                types: ["varchar(40)", "numeric(10,2)", "bigint", "timestamptz", "mood", "nope", "double precision", "int[]", "text[]"],
                typeChanges: [
                    { from: "character varying(20)", to: "text" },
                    { from: "integer", to: "bigint" },
                    { from: "text", to: "integer" },
                ],
                functions: ["now", "random", "gen_random_uuid", "nextval", "lower", "no_such_function"],
                defaults: [
                    { expression: "'new'", type: "varchar(20)" },
                    { expression: "now()", type: "timestamptz" },
                    { expression: "'abc'", type: "integer" },
                    { expression: "no_such_function()", type: "text" },
                    { expression: "active", type: "text" },
                ],
                checks: [
                    { table: "public.orders", expression: "total >= 0 AND status <> 'x'" },
                    { table: "public.orders", expression: "no_such_column > 0" },
                    { table: "public.orders", expression: "total + 1" },
                ],
                relations: [{ schema: "public", name: "orders" }, { schema: "public", name: "orders_pkey" }, { schema: "public", name: "brand_new_index" }, { schema: "billing", name: "invoices" }],
                schemas: ["public", "billing", "nope"],
            });
            checks.equal(probes.defaults.get(defaultKey("'new'", "varchar(20)")), undefined, "PostgreSQL accepts a text default");
            checks.equal(probes.defaults.get(defaultKey("now()", "timestamptz")), undefined, "and a function default");
            checks.equal(probes.checks.get(checkKey("public.orders", "total >= 0 AND status <> 'x'")), undefined, "PostgreSQL accepts a CHECK over the table's columns");
            checks.match(probes.checks.get(checkKey("public.orders", "no_such_column > 0")), /column "no_such_column" does not exist/, "rejects a CHECK on a column the table does not have, with its own message");
            checks.match(probes.checks.get(checkKey("public.orders", "total + 1")), /must be type boolean/, "and one that is not boolean");
            checks.match(probes.defaults.get(defaultKey("'abc'", "integer")), /invalid input syntax for type integer/, "rejects a default of the wrong type, with its own message");
            checks.match(probes.defaults.get(defaultKey("no_such_function()", "text")), /function no_such_function\(\) does not exist/, "rejects a function that does not exist");
            checks.match(probes.defaults.get(defaultKey("active", "text")), /column "active" does not exist/, "rejects a bare word that would be read as a column");
            checks.equal(probes.relationExists.get("public.orders"), true, "knows a table name is taken");
            checks.equal(probes.relationExists.get("public.orders_pkey"), true, "and an index name");
            checks.equal(probes.relationExists.get("public.brand_new_index"), false, "and that a new name is free");
            checks.equal(probes.relationExists.get("billing.invoices"), true, "in another schema too");
            checks.equal([probes.schemaExists.get("public"), probes.schemaExists.get("billing"), probes.schemaExists.get("nope")], [true, true, false], "and which schemas exist");
            checks.equal(probes.types.get("varchar(40)"), "character varying", "knows varchar(40)");
            checks.equal(probes.types.get("mood"), "mood", "knows a type defined in the database");
            checks.equal(probes.types.get("nope"), undefined, "does not know an invented type");
            checks.equal(probes.types.get("double precision"), "double precision", "multi-word type names");
            checks.equal(probes.types.get("int[]"), "integer[]", "array types");
            checks.equal(probes.casts.get(castKey("character varying(20)", "text")), "b", "varchar to text is binary coercible");
            checks.equal(probes.casts.get(castKey("integer", "bigint")), "f", "integer to bigint is a function cast (a rewrite)");
            checks.equal(probes.casts.get(castKey("text", "integer")), undefined, "text to integer has no catalog cast (it needs a USING expression)");
            checks.equal(probes.volatility.get("now"), "s", "now() is stable");
            checks.equal(probes.volatility.get("random"), "v", "random() is volatile");
            if (MAJOR >= 13) checks.equal(probes.volatility.get("gen_random_uuid"), "v", "gen_random_uuid() is volatile");
            checks.equal(probes.volatility.get("nextval"), "v", "nextval() is volatile");
            checks.equal(probes.volatility.get("lower"), "i", "lower() is immutable");
            checks.equal(probes.volatility.get("no_such_function"), undefined, "unknown function");
        });
    },
};

async function main() {
    const only = process.argv[2];
    const probe_ = await connect();
    MAJOR = Math.floor(Number((await probe_.query("SHOW server_version_num")).rows[0].server_version_num) / 10000);
    await probe_.end();
    console.log(`PostgreSQL ${MAJOR}`);
    if (MAJOR < 13) {
        // gen_random_uuid() is built in from PostgreSQL 13; before that it needs pgcrypto. Any volatile uuid expression tests the same path.
        const scenario = SCENARIOS.find((candidate) => candidate.name.startsWith("add a NOT NULL column with a volatile default"));
        ((scenario?.operations[0] as { field: { defaultValue: string } }).field).defaultValue = "(md5(random()::text || clock_timestamp()::text))::uuid";
    }
    let failed = false;
    for (const [name, run] of Object.entries(sections)) {
        if (only && only !== name) continue;
        const checks = new Checks(name);
        try {
            await run(checks);
        } catch (error) {
            checks.ok(false, `${name} threw`, error instanceof Error ? (error.stack ?? error.message) : String(error));
        }
        if (!checks.report()) failed = true;
    }
    process.exit(failed ? 1 : 0);
}

main().catch((error) => {
    console.error(error);
    process.exit(2);
});
