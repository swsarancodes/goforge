/**
 * Generates a database of N tables that looks like a grown-up business schema: modules (some as PostgreSQL schemas, some as
 * name prefixes in `public`), root entities with child, history and note tables, shared lookup tables, foreign keys to them,
 * domain columns, a few legacy columns that point somewhere without a foreign key, and a few extra indexes. Deterministic
 * for a given (tableCount, seed). Used by the evaluation and by the demo database in the browser check.
 */

export interface SyntheticColumn {
    name: string;
    type: string;
    notNull: boolean;
    /** SQL that fills the column when the table is populated, with `g` as the row number. Undefined: left NULL (or an identity). */
    fill?: string;
    /** For a column that points at another table's id without a foreign key. */
    refersTo?: string;
}

export interface SyntheticTable {
    schema: string;
    name: string;
    qualified: string;
    /** The words a person would use for it: ["invoice", "items"]. */
    words: string[];
    module: string;
    entity: string;
    role: "hub" | "root" | "child" | "history" | "notes";
    parent?: string;
    columns: SyntheticColumn[];
    foreignKeys: { column: string; references: string }[];
    indexes: { name: string; columns: string[] }[];
    /** Rows to insert when the database is populated (0: left empty). */
    rows: number;
}

export interface SyntheticSchema {
    tables: SyntheticTable[];
    seed: number;
    /** Creation statements in dependency order. */
    createSql: string[];
    /** Foreign keys, to be added after the data is loaded. */
    foreignKeySql: string[];
    /** Statements that load rows into the populated tables. */
    populateSql: string[];
}

function rng(seed: number) {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        int: (max: number) => Math.floor(next() * max),
        pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)],
        chance: (p: number) => next() < p,
        shuffle: <T>(list: readonly T[]): T[] => {
            const copy = [...list];
            for (let i = copy.length - 1; i > 0; i--) {
                const j = Math.floor(next() * (i + 1));
                [copy[i], copy[j]] = [copy[j], copy[i]];
            }
            return copy;
        },
    };
}

const MODULES = ["sales", "billing", "inventory", "procurement", "logistics", "support", "marketing", "finance", "hr", "payroll", "projects", "compliance", "analytics", "identity", "catalog", "pricing", "fulfillment", "returns", "contracts", "assets", "maintenance", "quality", "research", "training", "facilities", "legal", "security", "partners", "subscriptions", "notifications"];

const ENTITIES = ["order", "invoice", "payment", "shipment", "customer", "supplier", "product", "warehouse", "ticket", "campaign", "lead", "contract", "employee", "timesheet", "expense", "budget", "project", "task", "milestone", "audit", "policy", "incident", "asset", "vehicle", "route", "delivery", "refund", "quote", "subscription", "plan", "coupon", "review", "survey", "document", "approval", "schedule", "shift", "claim", "license", "certificate", "vendor", "requisition", "receipt", "ledger", "journal", "forecast", "report", "alert", "template", "contact", "account", "address", "session", "device", "event", "booking", "reservation", "inspection", "batch", "recipe", "component", "sample", "experiment", "trial", "filing", "dispute", "settlement", "benefit", "leave", "candidate", "interview", "offer", "course", "enrollment", "visit", "appointment", "pallet", "container", "manifest", "tariff", "rebate", "discount", "bundle", "listing", "bid", "pledge", "donation", "grant", "tenant", "lease", "meter", "reading", "outage", "permit", "recall", "warranty", "voucher", "payout", "shipping_label", "pick_list", "stock_count"];

const DERIVED = [
    { suffix: "items", role: "child" as const },
    { suffix: "history", role: "history" as const },
    { suffix: "notes", role: "notes" as const },
    { suffix: "attachments", role: "child" as const },
    { suffix: "tags", role: "child" as const },
    { suffix: "revisions", role: "history" as const },
];

const DOMAIN_COLUMNS: { name: string; type: string; fill?: string }[] = [
    { name: "warehouse_code", type: "varchar(20)", fill: "'W' || (g % 40)" },
    { name: "shipped_at", type: "timestamptz" },
    { name: "delivered_at", type: "timestamptz" },
    { name: "invoice_no", type: "varchar(30)", fill: "'INV-' || g" },
    { name: "sku", type: "varchar(40)", fill: "'SKU-' || (g % 5000)" },
    { name: "region", type: "varchar(40)", fill: "'region-' || (g % 12)" },
    { name: "priority", type: "smallint", fill: "g % 5" },
    { name: "currency_code", type: "char(3)", fill: "'USD'" },
    { name: "tax_rate", type: "numeric(5,2)", fill: "(g % 25)::numeric" },
    { name: "discount_pct", type: "numeric(5,2)", fill: "(g % 30)::numeric" },
    { name: "quantity", type: "integer", fill: "1 + g % 50" },
    { name: "unit_price", type: "numeric(12,2)", fill: "(g % 9000)::numeric / 10" },
    { name: "total_amount", type: "numeric(14,2)", fill: "(g % 90000)::numeric / 10" },
    { name: "due_date", type: "date", fill: "current_date + (g % 90)" },
    { name: "approved_at", type: "timestamptz" },
    { name: "cost_center", type: "varchar(20)", fill: "'CC' || (g % 90)" },
    { name: "external_ref", type: "varchar(64)", fill: "md5(g::text)" },
    { name: "channel", type: "varchar(30)", fill: "'channel-' || (g % 6)" },
    { name: "weight_kg", type: "numeric(8,3)", fill: "(g % 5000)::numeric / 7" },
    { name: "language", type: "varchar(8)", fill: "'en'" },
    { name: "is_archived", type: "boolean", fill: "g % 20 = 0" },
    { name: "severity", type: "smallint", fill: "g % 4" },
    { name: "resolution", type: "text" },
    { name: "contact_email", type: "varchar(254)", fill: "'user' || g || '@example.test'" },
    { name: "phone", type: "varchar(32)", fill: "'+1555' || (1000000 + g % 8999999)" },
    { name: "latitude", type: "double precision", fill: "(g % 180) - 90" },
    { name: "longitude", type: "double precision", fill: "(g % 360) - 180" },
    { name: "batch_no", type: "varchar(24)", fill: "'B' || (g % 700)" },
    { name: "serial_no", type: "varchar(40)", fill: "'S' || g" },
    { name: "expires_on", type: "date", fill: "current_date + (g % 400)" },
    { name: "score", type: "integer", fill: "g % 100" },
    { name: "rating", type: "smallint", fill: "g % 6" },
    { name: "retry_count", type: "integer", fill: "g % 4" },
    { name: "checksum", type: "varchar(64)", fill: "md5(g::text)" },
];

const SIGNATURE_WORDS = ["carrier", "courier", "depot", "dock", "lane", "yard", "bay", "gate", "pier", "terminal", "locker", "rack", "shelf", "bin", "zone", "ledger_page", "cohort", "stratum", "tranche", "cadence", "sprint", "epoch", "lot", "wave", "tier", "band", "slot", "grade", "variant", "revision_tag", "channel_key", "partner_key", "origin_code", "target_code"];

const HUBS: { name: string; extra: SyntheticColumn[] }[] = [
    { name: "users", extra: [{ name: "email", type: "varchar(254)", notNull: true, fill: "'u' || g || '@example.test'" }, { name: "display_name", type: "varchar(120)", notNull: false, fill: "'User ' || g" }] },
    { name: "organizations", extra: [{ name: "legal_name", type: "varchar(200)", notNull: true, fill: "'Org ' || g" }] },
    { name: "countries", extra: [{ name: "iso_code", type: "char(2)", notNull: true, fill: "'C' || chr(65 + g % 26)" }] },
    { name: "currencies", extra: [{ name: "iso_code", type: "char(3)", notNull: true, fill: "'X' || chr(65 + g % 26) || chr(65 + (g / 26) % 26)" }] },
];

const HUB_ROWS = 2000;

/** Rows loaded into the populated ("big") tables; enough that the data is above the "small" limit (16 MiB) used to size a change. */
export const BIG_TABLE_ROWS = 260_000;

const quote = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name}"`);

export function generateSchema(tableCount: number, seed: number, options: { bigTables?: number } = {}): SyntheticSchema {
    const random = rng(seed);
    const tables: SyntheticTable[] = [];
    const taken = new Set<string>();
    const add = (table: SyntheticTable) => {
        if (taken.has(table.qualified)) return false;
        taken.add(table.qualified);
        tables.push(table);
        return true;
    };

    for (const hub of HUBS) {
        add({
            schema: "public", name: hub.name, qualified: `public.${hub.name}`, words: [hub.name], module: "core", entity: hub.name, role: "hub",
            columns: [{ name: "id", type: "bigint", notNull: true }, ...hub.extra, { name: "created_at", type: "timestamptz", notNull: true, fill: "now() - (g % 1000) * interval '1 hour'" }],
            foreignKeys: [], indexes: [], rows: HUB_ROWS,
        });
    }

    const moduleCount = Math.max(1, Math.min(MODULES.length, Math.ceil(tableCount / 40)));
    const modules = random.shuffle(MODULES).slice(0, moduleCount);
    const entityPool = random.shuffle(ENTITIES);
    let cursor = 0;

    // Fill module by module, root by root, until the count is reached.
    let guard = 0;
    while (tables.length < tableCount && guard++ < tableCount * 20) {
        const module = modules[guard % modules.length];
        const separateSchema = MODULES.indexOf(module) % 3 !== 0;
        const entity = entityPool[cursor++ % entityPool.length];
        const schema = separateSchema ? module : "public";
        const rootName = separateSchema ? `${entity}s` : `${module}_${entity}s`;
        const root: SyntheticTable = {
            schema, name: rootName, qualified: `${schema}.${rootName}`, words: separateSchema ? [entity] : [module, entity], module, entity, role: "root",
            columns: [
                { name: "id", type: "bigint", notNull: true },
                { name: "code", type: "varchar(24)", notNull: true, fill: "substr(md5(g::text), 1, 12)" },
                { name: "status", type: "varchar(20)", notNull: true, fill: "'status-' || (g % 5)" },
                { name: "owner_id", type: "bigint", notNull: true, fill: `1 + g % ${HUB_ROWS}` },
                { name: "organization_id", type: "bigint", notNull: false, fill: `1 + g % ${HUB_ROWS}` },
                { name: "created_at", type: "timestamptz", notNull: true, fill: "now() - (g % 1000) * interval '1 hour'" },
                { name: "updated_at", type: "timestamptz", notNull: false },
                { name: "notes", type: "text", notNull: false },
            ],
            foreignKeys: [{ column: "owner_id", references: "public.users" }, { column: "organization_id", references: "public.organizations" }],
            indexes: [], rows: 0,
        };
        for (const domain of random.shuffle(DOMAIN_COLUMNS).slice(0, 3 + random.int(6))) root.columns.push({ name: domain.name, type: domain.type, notNull: false, fill: domain.fill });
        if (random.chance(0.35)) {
            const signature = `${entity}_${random.pick(SIGNATURE_WORDS)}_code`;
            if (!root.columns.some((column) => column.name === signature)) root.columns.push({ name: signature, type: "varchar(30)", notNull: false, fill: "'sig-' || (g % 900)" });
        }
        if (random.chance(0.4)) root.indexes.push({ name: `${rootName}_status_idx`, columns: ["status"] });
        if (!add(root)) continue;

        const derived = random.shuffle(DERIVED).slice(0, 1 + random.int(3));
        for (const kind of derived) {
            if (tables.length >= tableCount) break;
            const name = separateSchema ? `${entity}_${kind.suffix}` : `${module}_${entity}_${kind.suffix}`;
            const fk = `${entity}_id`;
            const child: SyntheticTable = {
                schema, name, qualified: `${schema}.${name}`, words: [...root.words, kind.suffix], module, entity, role: kind.role === "history" ? "history" : kind.suffix === "notes" ? "notes" : "child", parent: root.qualified,
                columns: [
                    { name: "id", type: "bigint", notNull: true },
                    { name: fk, type: "bigint", notNull: true },
                    ...(kind.role === "history"
                        ? [{ name: "changed_at", type: "timestamptz", notNull: true, fill: "now() - (g % 1000) * interval '1 hour'" }, { name: "changed_by", type: "bigint", notNull: false, fill: `1 + g % ${HUB_ROWS}` }, { name: "old_value", type: "text", notNull: false }, { name: "new_value", type: "text", notNull: false }]
                        : kind.suffix === "notes"
                          ? [{ name: "body", type: "text", notNull: true, fill: "'note ' || g" }, { name: "created_at", type: "timestamptz", notNull: true, fill: "now() - (g % 1000) * interval '1 hour'" }]
                          : [{ name: "label", type: "varchar(120)", notNull: false, fill: "'item ' || g" }, { name: "quantity", type: "integer", notNull: true, fill: "1 + g % 50" }, { name: "created_at", type: "timestamptz", notNull: true, fill: "now() - (g % 1000) * interval '1 hour'" }]),
                ],
                foreignKeys: [{ column: fk, references: root.qualified }],
                indexes: random.chance(0.5) ? [{ name: `${name}_${fk}_idx`, columns: [fk] }] : [],
                rows: 0,
            };
            // some children carry a column that points at another root without a foreign key, the way grown databases do
            const other = tables.filter((t) => t.role === "root" && t.qualified !== root.qualified);
            if (other.length > 0 && random.chance(0.3)) {
                const target = random.pick(other);
                child.columns.push({ name: `${target.entity}_ref_id`, type: "bigint", notNull: false, refersTo: target.qualified });
            }
            if (random.chance(0.25)) child.indexes.push({ name: `${name}_created_idx`, columns: [kind.role === "history" ? "changed_at" : "created_at"] });
            add(child);
        }
    }

    // The populated tables: a few roots with their children, so a change to them is a change to real data.
    const big = options.bigTables ?? Math.max(2, Math.min(10, Math.round(tableCount / 40)));
    const roots = tables.filter((t) => t.role === "root");
    for (const root of random.shuffle(roots).slice(0, Math.ceil(big / 2))) {
        root.rows = BIG_TABLE_ROWS;
        for (const child of tables.filter((t) => t.parent === root.qualified).slice(0, 1)) child.rows = BIG_TABLE_ROWS;
    }
    // legacy reference columns are only filled in tables that are loaded, with ids of rows that exist
    for (const table of tables) {
        for (const column of table.columns) {
            if (column.refersTo && table.rows > 0) {
                const target = tables.find((t) => t.qualified === column.refersTo);
                column.fill = target && target.rows > 0 ? `1 + g % ${target.rows}` : undefined;
            }
        }
    }

    const createSql: string[] = [];
    for (const schema of new Set(tables.map((t) => t.schema))) if (schema !== "public") createSql.push(`CREATE SCHEMA ${quote(schema)}`);
    for (const table of tables) {
        const columns = table.columns.map((column) => `${quote(column.name)} ${column.type}${column.name === "id" ? " GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY" : ""}${column.notNull && column.name !== "id" ? " NOT NULL" : ""}`);
        createSql.push(`CREATE TABLE ${quote(table.schema)}.${quote(table.name)} (${columns.join(", ")})`);
        for (const index of table.indexes) createSql.push(`CREATE INDEX ${quote(index.name)} ON ${quote(table.schema)}.${quote(table.name)} (${index.columns.map(quote).join(", ")})`);
    }

    const populateSql: string[] = [];
    for (const table of tables) {
        if (table.rows === 0) continue;
        const filled = table.columns.filter((column) => column.name !== "id" && column.fill !== undefined);
        const parentRows = table.parent ? (tables.find((t) => t.qualified === table.parent)?.rows ?? 0) : 0;
        const fkColumn = table.parent ? table.foreignKeys[0]?.column : undefined;
        const columns = [...filled.map((column) => column.name), ...(fkColumn ? [fkColumn] : [])];
        const values = [...filled.map((column) => column.fill as string), ...(fkColumn ? [`1 + g % ${Math.max(1, parentRows)}`] : [])];
        populateSql.push(`INSERT INTO ${quote(table.schema)}.${quote(table.name)} (${columns.map(quote).join(", ")}) SELECT ${values.join(", ")} FROM generate_series(1, ${table.rows}) AS g`);
    }

    const foreignKeySql = tables.flatMap((table) =>
        table.foreignKeys.map((fk) => {
            const [schema, name] = fk.references.split(".");
            return `ALTER TABLE ${quote(table.schema)}.${quote(table.name)} ADD CONSTRAINT ${quote(`${table.name}_${fk.column}_fkey`.slice(0, 63))} FOREIGN KEY (${quote(fk.column)}) REFERENCES ${quote(schema)}.${quote(name)} (id)`;
        }),
    );

    return { tables, seed, createSql, foreignKeySql, populateSql };
}

/** `warehouse_code` -> "warehouse code" */
export const wordsOf = (name: string): string => name.replace(/_/g, " ");
