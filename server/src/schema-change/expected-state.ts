import type { Facts, TableFacts } from "./facts.js";
import { sameType } from "./type-change.js";

/**
 * What the compiler believes the tables look like once the runbook's steps (the ones that run by default) have run, and the check of
 * that belief against the database afterwards. The compiler plans each step against its own model of the tables, so a step is only as
 * right as that model; reading the catalog again after the run is the test of it. A difference is either a step that did not do what
 * it said, or something the compiler did not know about, and either way it is worth knowing before the next change.
 *
 * Only what the compiler decides is compared: columns (name, type, NOT NULL), the primary key, unique and CHECK constraints, foreign
 * keys, and indexes. Defaults, sizes, statistics and the helper objects of an expand/contract change (its trigger and function) are not.
 */

export interface ExpectedTable {
    qualified: string;
    columns: { name: string; type: string; notNull: boolean }[];
    primaryKey: string[];
    uniques: { name: string; columns: string[] }[];
    checks: { name: string; validated: boolean }[];
    foreignKeys: { name: string; columns: string[]; refTable: string; refColumns: string[]; validated: boolean }[];
    indexes: { name: string; columns: (string | null)[]; unique: boolean }[];
    /** Views that depend on the table, schema qualified: the others it already had, and the old name a rename leaves behind. */
    views: string[];
}

export interface ExpectedState {
    tables: ExpectedTable[];
    /** Tables that should no longer exist (dropped, or renamed away), schema qualified. */
    absent: string[];
}

export interface Mismatch {
    table: string;
    /** What differs: a column, index, constraint, foreign key, the primary key, or the table itself. */
    kind: "table" | "column" | "primary-key" | "unique" | "check" | "foreign-key" | "index" | "view";
    message: string;
}

export function expectedState(original: Map<string, TableFacts>, final: Map<string, TableFacts>): ExpectedState {
    const tables = [...final.values()].map((table): ExpectedTable => ({
        qualified: table.qualified,
        columns: table.columns.map((column) => ({ name: column.name, type: column.type, notNull: column.notNull })),
        primaryKey: [...table.primaryKey],
        uniques: table.uniques.map((unique) => ({ name: unique.name, columns: [...unique.columns] })),
        checks: table.checks.map((check) => ({ name: check.name, validated: check.validated })),
        foreignKeys: table.foreignKeys.map((fk) => ({ name: fk.name, columns: [...fk.columns], refTable: `${fk.refSchema}.${fk.refTable}`, refColumns: [...fk.refColumns], validated: fk.validated })),
        indexes: table.indexes.filter((index) => !index.primary).map((index) => ({ name: index.name, columns: [...index.columns], unique: index.unique })),
        views: [...table.dependentViews].sort(),
    }));
    const kept = new Set(tables.map((table) => table.qualified));
    const absent = [...original.keys()].filter((key) => !kept.has(key));
    return { tables, absent };
}

const same = (a: readonly (string | null)[], b: readonly (string | null)[]) => a.length === b.length && a.every((value, i) => value === b[i]);
const list = (names: readonly (string | null)[]) => names.map((name) => name ?? "(expression)").join(", ");

/** Differences between the expected state and the catalog as it is now; empty when they agree. */
export function diffExpected(expected: ExpectedState, actual: Facts): Mismatch[] {
    const found: Mismatch[] = [];
    for (const name of expected.absent) {
        if (actual.tables.has(name)) found.push({ table: name, kind: "table", message: `${name} should be gone, but it still exists.` });
    }
    for (const table of expected.tables) {
        const real = actual.tables.get(table.qualified);
        if (!real) {
            found.push({ table: table.qualified, kind: "table", message: `${table.qualified} should exist, but it does not.` });
            continue;
        }
        const note = (kind: Mismatch["kind"], message: string) => found.push({ table: table.qualified, kind, message });

        for (const column of table.columns) {
            const have = real.columns.find((candidate) => candidate.name === column.name);
            if (!have) note("column", `Column ${column.name} should exist, but it does not.`);
            else {
                if (!sameType(column.type, have.type)) note("column", `Column ${column.name} should be ${column.type}, but it is ${have.type}.`);
                if (column.notNull !== have.notNull) note("column", `Column ${column.name} should ${column.notNull ? "be NOT NULL" : "allow NULL"}, but it ${have.notNull ? "is NOT NULL" : "allows NULL"}.`);
            }
        }
        for (const have of real.columns) {
            if (!table.columns.some((column) => column.name === have.name)) note("column", `Column ${have.name} (${have.type}) exists, but the plan did not expect it.`);
        }

        if (!same(table.primaryKey, real.primaryKey)) note("primary-key", `The primary key should be (${list(table.primaryKey)}), but it is (${list(real.primaryKey)}).`);

        for (const unique of table.uniques) {
            const have = real.uniques.find((candidate) => candidate.name === unique.name);
            if (!have) note("unique", `Constraint ${unique.name} should exist, but it does not.`);
            else if (!same(unique.columns, have.columns)) note("unique", `Constraint ${unique.name} should cover (${list(unique.columns)}), but it covers (${list(have.columns)}).`);
        }
        for (const have of real.uniques) {
            if (!table.uniques.some((unique) => unique.name === have.name)) note("unique", `Constraint ${have.name} exists, but the plan did not expect it.`);
        }

        for (const check of table.checks) {
            const have = real.checks.find((candidate) => candidate.name === check.name);
            if (!have) note("check", `CHECK ${check.name} should exist, but it does not.`);
            else if (check.validated !== have.validated) note("check", `CHECK ${check.name} should be ${check.validated ? "validated" : "NOT VALID"}, but it is ${have.validated ? "validated" : "NOT VALID"}.`);
        }
        for (const have of real.checks) {
            if (!table.checks.some((check) => check.name === have.name)) note("check", `CHECK ${have.name} exists, but the plan did not expect it.`);
        }

        for (const fk of table.foreignKeys) {
            const have = real.foreignKeys.find((candidate) => candidate.name === fk.name);
            if (!have) note("foreign-key", `Foreign key ${fk.name} should exist, but it does not.`);
            else {
                if (!same(fk.columns, have.columns) || `${have.refSchema}.${have.refTable}` !== fk.refTable || !same(fk.refColumns, have.refColumns)) {
                    note("foreign-key", `Foreign key ${fk.name} should be (${list(fk.columns)}) → ${fk.refTable} (${list(fk.refColumns)}), but it is (${list(have.columns)}) → ${have.refSchema}.${have.refTable} (${list(have.refColumns)}).`);
                }
                if (fk.validated !== have.validated) note("foreign-key", `Foreign key ${fk.name} should be ${fk.validated ? "validated" : "NOT VALID"}, but it is ${have.validated ? "validated" : "NOT VALID"}.`);
            }
        }
        for (const have of real.foreignKeys) {
            if (!table.foreignKeys.some((fk) => fk.name === have.name)) note("foreign-key", `Foreign key ${have.name} exists, but the plan did not expect it.`);
        }

        for (const view of table.views) {
            if (!real.dependentViews.includes(view)) note("view", `View ${view} should depend on this table, but it does not exist.`);
        }
        for (const view of real.dependentViews) {
            if (!table.views.includes(view)) note("view", `View ${view} depends on this table, but the plan did not expect it.`);
        }

        for (const index of table.indexes) {
            const have = real.indexes.find((candidate) => candidate.name === index.name);
            if (!have) note("index", `Index ${index.name} should exist, but it does not.`);
            else {
                if (!have.valid) note("index", `Index ${index.name} exists but is INVALID (a concurrent build that failed leaves one): drop it and build it again.`);
                if (!same(index.columns, have.columns)) note("index", `Index ${index.name} should be on (${list(index.columns)}), but it is on (${list(have.columns)}).`);
                if (index.unique !== have.unique) note("index", `Index ${index.name} should ${index.unique ? "be unique" : "not be unique"}, but it ${have.unique ? "is" : "is not"}.`);
            }
        }
        for (const have of real.indexes) {
            if (have.primary) continue;
            if (!table.indexes.some((index) => index.name === have.name)) note("index", `Index ${have.name} exists, but the plan did not expect it.`);
        }
    }
    return found;
}
