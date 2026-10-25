/**
 * Runs each case's legacy Oracle query on a REAL Oracle Database and compares what Oracle returns with the case's reference result.
 *
 * The references in `cases/*` (expected_result.csv, expected_heldout.csv) were derived by hand from documented Oracle behaviour, because the
 * harness runs without Oracle. That makes them one author's reading of Oracle. This check removes the reading: the same synthetic data is loaded
 * into an Oracle schema (the legacy schema in domain/legacy_schema.sql, the seed rows renamed to the legacy tables and columns through
 * domain/schema_mapping.csv), the legacy query is run there, and the answer is compared with the reference by the harness's own comparator.
 *
 *   docker run -d --name goforge-oracle -p 127.0.0.1:1521:1521 -e ORACLE_PASSWORD=choose-one gvenzl/oracle-free:23-slim-faststart
 *   ORACLE_ADMIN_URL=oracle://system:choose-one@127.0.0.1:1521/FREEPDB1 npm run queryshift:oracle-check
 *   ... -- --out queryshift/reports/oracle-check.json      # also write the result as JSON
 *
 * Each dataset gets a schema of its own on that server, created with GoForge's own schema helper and dropped afterwards, along with everything in it.
 * Oracle Database Free 23ai accepts a multi-row VALUES list; older versions would need the seed rewritten. Exit code 1 if Oracle disagrees with any
 * reference, which would mean the reference (or the case) is wrong, not the translation.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOracleSchema, dropOracleSchema, newSchemaPassword, oracleSchemaName, oracleServerFromEnv } from "../server/src/services/oracle-schemas";
import { oracledb, withOracle } from "../server/src/services/oracle-client";
import { compareResults, type ActualTable, type Category, type Comparison, type ExpectedTable } from "./src/compare";
import { loadCase, type LoadedCase } from "./src/case";
import { parseMapping, toLegacySeed } from "./src/legacy-seed";

const here = import.meta.dirname;
const domain = resolve(here, "domain");

/** node-oracledb hands a DATE back as a JavaScript Date in the process's time zone; the process runs in UTC (see run), so its parts are Oracle's own. */
const cellText = (cell: unknown): string | null => {
    if (cell === null || cell === undefined) return null;
    if (cell instanceof Date) {
        const two = (value: number) => String(value).padStart(2, "0");
        return `${String(cell.getFullYear()).padStart(4, "0")}-${two(cell.getMonth() + 1)}-${two(cell.getDate())} ${two(cell.getHours())}:${two(cell.getMinutes())}:${two(cell.getSeconds())}`;
    }
    return String(cell);
};

const categoryOf = (typeName: string): Category => (/NUMBER|FLOAT|INTEGER|BINARY_/.test(typeName) ? "number" : /DATE|TIMESTAMP/.test(typeName) ? "timestamp" : "text");

const stripTerminator = (sql: string): string => sql.replace(/[\s;]+$/, "");

interface Outcome {
    case: string;
    dataset: "primary" | "heldout";
    comparison: Comparison;
    oracleRows: (string | null)[][];
    columns: string[];
}

async function run(): Promise<number> {
    process.env.TZ = "UTC";
    const args = process.argv.slice(2);
    const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
    const server = oracleServerFromEnv(process.env);
    if (!server) {
        console.error("Set ORACLE_ADMIN_URL=oracle://user:password@host:1521/FREEPDB1 (a login that may create users, such as SYSTEM on Oracle Database Free).");
        return 2;
    }
    const admin = server.admin;
    const version = await withOracle(admin, async (connection) => connection.oracleServerVersionString ?? "unknown");
    console.log(`Oracle ${version} at ${admin.host}:${admin.port}/${admin.database}\n`);

    const mapping = parseMapping(readFileSync(resolve(domain, "schema_mapping.csv"), "utf8"));
    const legacySchema = readFileSync(resolve(domain, "legacy_schema.sql"), "utf8");
    const cases = ["case-01-outer-join-active-policies", "case-02-null-and-aggregation-claims", "case-03-date-time-claims-window"].map((name) => loadCase(resolve(here, "cases", name)));
    const outcomes: Outcome[] = [];

    const datasets: { name: "primary" | "heldout"; seed: (loaded: LoadedCase) => string | undefined; expected: (loaded: LoadedCase) => ExpectedTable | undefined }[] = [
        { name: "primary", seed: (loaded) => loaded.seedSql, expected: (loaded) => loaded.expected },
        { name: "heldout", seed: (loaded) => loaded.heldOut?.seedSql, expected: (loaded) => loaded.heldOut?.expected },
    ];

    for (const dataset of datasets) {
        const seed = dataset.seed(cases[0]);
        if (!seed) continue;
        const schema = oracleSchemaName("queryshift-oracle-check", `QS_${dataset.name.toUpperCase()}`);
        const password = newSchemaPassword();
        await dropOracleSchema(admin, schema).catch(() => undefined);
        try {
            const built = await createOracleSchema(admin, schema, password, `${legacySchema}\n${toLegacySeed(seed, mapping)}`);
            console.log(`${dataset.name} data: ${built.statementsRun} statements run in ${schema}`);
            for (const loaded of cases) {
                const expected = dataset.expected(loaded);
                if (!expected) continue;
                const result = await withOracle({ ...admin, user: schema, password }, async (connection) => {
                    return connection.execute(stripTerminator(loaded.legacySql), [], { maxRows: 10_000, outFormat: oracledb.OUT_FORMAT_ARRAY });
                });
                const columns = (result.metaData ?? []).map((meta) => ({ name: meta.name, category: categoryOf(String((meta as { dbTypeName?: string }).dbTypeName ?? "")) }));
                const rows = ((result.rows ?? []) as unknown[][]).map((row) => row.map(cellText));
                const actual: ActualTable = { columns, rows, truncated: false };
                const comparison = compareResults(expected, actual, { orderSensitive: loaded.definition.orderSensitive });
                outcomes.push({ case: loaded.definition.id, dataset: dataset.name, comparison, oracleRows: rows, columns: columns.map((column) => column.name) });
                console.log(`  ${loaded.definition.id} on ${dataset.name} data: ${comparison.passed ? "Oracle returns exactly the reference result" : `ORACLE DISAGREES WITH THE REFERENCE: ${comparison.message}`} (${rows.length} row(s) from Oracle, ${expected.rows.length} in the reference)`);
                if (!comparison.passed) {
                    for (const row of comparison.missing.slice(0, 5)) console.log(`      the reference has, Oracle does not: ${JSON.stringify(row)}`);
                    for (const row of comparison.additional.slice(0, 5)) console.log(`      Oracle has, the reference does not: ${JSON.stringify(row)}`);
                    if (comparison.columnProblem) console.log(`      ${comparison.columnProblem}`);
                }
            }
        } finally {
            await dropOracleSchema(admin, schema).catch((error) => console.warn(`could not drop ${schema}: ${error instanceof Error ? error.message : error}`));
        }
        console.log();
    }

    const disagreements = outcomes.filter((outcome) => !outcome.comparison.passed).length;
    console.log(`${outcomes.length - disagreements} of ${outcomes.length} references confirmed by Oracle ${version}; disagreements: ${disagreements}`);
    if (out) {
        writeFileSync(resolve(out), JSON.stringify({ oracleVersion: version, checkedAt: new Date().toISOString(), outcomes: outcomes.map((outcome) => ({ case: outcome.case, dataset: outcome.dataset, passed: outcome.comparison.passed, message: outcome.comparison.message, oracleRows: outcome.oracleRows.length, columns: outcome.columns })) }, null, 2) + "\n");
        console.log(`wrote ${out}`);
    }
    return disagreements === 0 ? 0 : 1;
}

run().then(
    (code) => process.exit(code),
    (error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(2);
    },
);
