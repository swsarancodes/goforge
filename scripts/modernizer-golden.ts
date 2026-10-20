/** Rewrites engine/corpus/golden.json from the current engine. Review the diff before committing: every change is a change in what users get. */
import { writeFileSync } from "node:fs";
import { convertQuery } from "../src/features/query-modernizer/engine/convert";
import { CASES } from "../src/features/query-modernizer/engine/corpus/cases";
import { FIXTURE_SCHEMA } from "../src/features/query-modernizer/engine/corpus/fixture";

const golden: Record<string, string> = {};
for (const c of CASES) golden[c.id] = convertQuery({ sql: c.sql, dialect: c.from, schema: c.schema ? FIXTURE_SCHEMA : undefined }).sql;
const target = new URL("../src/features/query-modernizer/engine/corpus/golden.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(golden, null, 2)}\n`);
console.log(`wrote ${Object.keys(golden).length} outputs`);
