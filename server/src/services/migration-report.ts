import { createHash } from "node:crypto";
import type { ConversionStatus, NotCarried } from "./oracle-conversion-notes.js";
import { dataChangeFor, type DataChange, type DataChangeEffect } from "./oracle-data-changes.js";
import { failedChecks, foldName, type DataCheck, type MigrationPlan, type OracleTable } from "./oracle-migration.js";
import type { MigrationEdits } from "./oracle-type-edits.js";

/**
 * The report a person reads before the migration runs: what will change in the schema and in the data, in one structure. It is built from
 * the plan, so it needs no Oracle connection; what has to be read from the data (counts of NULLs and of values that change, a few sample
 * rows) is passed in when there is one, and the report says nothing about it when there is not. Every fact in it comes from the plan or
 * from reading the data. The model writes none of it (an optional summary is added beside it, labelled, and never enters the hash).
 */

/** What reading the Oracle data found about one column. */
export interface ColumnFacts {
    /** Non-NULL and NULL values. */
    nulls: number;
    values: number;
    /** Counts of values the copy changes or loses, each with the query that counted them. */
    affected: { label: string; count: number; sql: string }[];
}

/** Facts keyed by Oracle `TABLE.COLUMN`. */
export type DataFacts = Record<string, ColumnFacts>;

/** A few rows, each value as Oracle shows it beside the same value as PostgreSQL will receive it (what the copy reads, with its own expressions). */
export interface ReportSample {
    columns: string[];
    oracle: (string | null)[][];
    postgres: (string | null)[][];
    /** The rows are the first by primary key; false for a table with none, where they are simply the first the database returned. */
    ordered: boolean;
    /** The one query run on Oracle for both views. */
    sql: string;
}

export interface ReportColumn {
    oracleName: string;
    pgName: string;
    oracleType: string;
    pgType: string;
    nullable: boolean;
    status: ConversionStatus;
    note: string;
    edited: ("name" | "type" | "default")[];
    oracleDefault: string | null;
    pgDefault: string | null;
    dataChange: DataChange;
    facts?: ColumnFacts;
    check?: DataCheck;
}

export interface ReportTable {
    oracleName: string;
    pgName: string;
    renamed: boolean;
    rows: number;
    primaryKey: string[];
    columns: ReportColumn[];
    sample?: ReportSample;
}

export interface ReportRename {
    kind: "table" | "column";
    /** The table the column is in (the table itself for a table). */
    table: string;
    from: string;
    to: string;
    /** `case`: Oracle's upper-case name written in lower case, as every unquoted name is. `you`: a name chosen by the person. */
    by: "case" | "you";
}

export interface ReportDefault {
    table: string;
    column: string;
    oracleDefault: string;
    /** For a dropped default, why. For a rewritten one, what it became. */
    detail: string;
}

/** An index or CHECK constraint the plan creates in PostgreSQL, with the statement that does it. */
export interface ReportObject {
    kind: "index" | "check";
    name: string;
    pgName: string;
    table: string;
    pgTable: string;
    detail: string;
    sql: string;
}

export type Verdict = "ready" | "needs-acceptance" | "blocked";

export interface MigrationReport {
    generatedAt: string;
    source: string;
    /** `blocked`: the migration cannot run as planned. `needs-acceptance`: values would change or be lost and have to be accepted by name. `ready`: nothing blocks it. */
    verdict: Verdict;
    summary: {
        tables: number;
        columns: number;
        rows: number;
        /** Columns by how their values fare, from the notes. */
        exact: number;
        changed: number;
        risk: number;
        /** Columns by what the copy does to their values. */
        values: Record<DataChangeEffect, number>;
        changesByYou: number;
        notCarried: number;
        /** Of those left behind, how many could be carried over if asked. */
        canBeCarried: number;
        /** Indexes and CHECK constraints the plan creates. */
        carried: number;
        problems: number;
    };
    renames: ReportRename[];
    droppedDefaults: ReportDefault[];
    rewrittenDefaults: ReportDefault[];
    tables: ReportTable[];
    notCarried: NotCarried[];
    /** Indexes and CHECK constraints the person chose to carry over: created after the rows, each checked against them. */
    carried: ReportObject[];
    behaviour: string[];
    problems: string[];
    editProblems: string[];
    /** Checks on the data that found something, or could not run: what has to be accepted before the migration may go ahead. */
    mustAccept: { table: string; column: string; description: string; count: number | null; sql: string; error?: string }[];
    /** Whether the data was read (counts, samples) to make this report. */
    dataRead: boolean;
    /** A fingerprint of everything above except the time and the sample rows. The approval carries it, and the server refuses an approval whose report is no longer this one. */
    hash: string;
}

export interface ReportInput {
    /** What the Oracle database is called to the person. */
    source: string;
    facts?: DataFacts;
    /** Sample rows by Oracle table name. */
    samples?: Record<string, ReportSample>;
    /** How many edits the person has made (names and types and defaults). */
    edits?: number;
    now?: () => Date;
}

const keyOf = (table: string, column: string) => `${table}.${column}`;

export function buildReport(plan: MigrationPlan, input: ReportInput): MigrationReport {
    const renames: ReportRename[] = [];
    const droppedDefaults: ReportDefault[] = [];
    const rewrittenDefaults: ReportDefault[] = [];
    const values: Record<DataChangeEffect, number> = { kept: 0, reformatted: 0, converted: 0, dropped: 0 };
    const counts = { exact: 0, changed: 0, risk: 0, columns: 0, rows: 0 };

    const tables = plan.tables.map((table): ReportTable => {
        counts.rows += table.rows;
        if (table.pgName !== table.oracleName) renames.push({ kind: "table", table: table.oracleName, from: table.oracleName, to: table.pgName, by: table.pgName === foldName(table.oracleName) ? "case" : "you" });
        const columns = table.columns.map((column): ReportColumn => {
            counts.columns += 1;
            counts[column.note.status] += 1;
            const dataChange = dataChangeFor(column);
            values[dataChange.effect] += 1;
            if (column.pgName !== column.oracleName) renames.push({ kind: "column", table: table.oracleName, from: column.oracleName, to: column.pgName, by: column.pgName === foldName(column.oracleName) ? "case" : "you" });
            if (column.oracleDefault !== null && column.pgDefault === null && !/^null$/i.test(column.oracleDefault)) {
                droppedDefaults.push({ table: table.oracleName, column: column.oracleName, oracleDefault: column.oracleDefault, detail: column.defaultDropped ?? "it is not carried over" });
            } else if (column.oracleDefault !== null && column.pgDefault !== null && column.oracleDefault.toUpperCase() !== column.pgDefault.toUpperCase()) {
                rewrittenDefaults.push({ table: table.oracleName, column: column.oracleName, oracleDefault: column.oracleDefault, detail: `becomes ${column.pgDefault}` });
            }
            return {
                oracleName: column.oracleName,
                pgName: column.pgName,
                oracleType: column.oracleType,
                pgType: column.pgType,
                nullable: column.nullable,
                status: column.note.status,
                note: column.note.text,
                edited: column.edited,
                oracleDefault: column.oracleDefault,
                pgDefault: column.pgDefault,
                dataChange,
                ...(input.facts?.[keyOf(table.oracleName, column.oracleName)] ? { facts: input.facts[keyOf(table.oracleName, column.oracleName)] } : {}),
                ...(column.check ? { check: column.check } : {}),
            };
        });
        return {
            oracleName: table.oracleName,
            pgName: table.pgName,
            renamed: table.renamed,
            rows: table.rows,
            primaryKey: table.oraclePrimaryKey,
            columns,
            ...(input.samples?.[table.oracleName] ? { sample: input.samples[table.oracleName] } : {}),
        };
    });

    const mustAccept = failedChecks(plan).map((entry) => ({ table: entry.table, column: entry.column, description: entry.check.description, count: entry.check.count, sql: entry.check.sql, ...(entry.check.error ? { error: entry.check.error } : {}) }));
    const carried: ReportObject[] = plan.objects.filter((object) => object.carried).map((object) => ({ kind: object.kind, name: object.oracleName, pgName: object.pgName, table: object.table, pgTable: object.pgTable, detail: object.detail, sql: object.sql! }));
    const verdict: Verdict = plan.problems.length > 0 ? "blocked" : mustAccept.length > 0 ? "needs-acceptance" : "ready";

    const body = {
        verdict,
        summary: { tables: plan.tables.length, columns: counts.columns, rows: counts.rows, exact: counts.exact, changed: counts.changed, risk: counts.risk, values, changesByYou: input.edits ?? 0, notCarried: plan.notCarried.length, canBeCarried: plan.notCarried.filter((entry) => entry.canCarry).length, carried: carried.length, problems: plan.problems.length },
        renames,
        droppedDefaults,
        rewrittenDefaults,
        // the rows shown are illustrations, and for a table without a key they are not even stable: they are not part of what is approved
        tables: tables.map(({ sample: _sample, ...rest }) => rest),
        notCarried: plan.notCarried,
        carried,
        behaviour: plan.behaviour,
        problems: plan.problems,
        editProblems: plan.editProblems,
        mustAccept,
        dataRead: input.facts !== undefined,
    };
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");

    return { generatedAt: (input.now?.() ?? new Date()).toISOString(), source: input.source, ...body, tables, hash };
}

/**
 * What the model is shown of a report to write its opening paragraph from: counts, names, types, the notes and the counts the data gave. Never
 * a sample row: those are the person's data, and the model does not need them to say what will change.
 */
export function digestForSummary(report: MigrationReport) {
    const columns = report.tables.flatMap((table) => table.columns.map((column) => ({ table, column })));
    const worth = columns.filter(({ column }) => column.status !== "exact" || column.facts?.affected.some((entry) => entry.count > 0));
    return {
        source: report.source,
        verdict: report.verdict,
        summary: report.summary,
        dataRead: report.dataRead,
        renamedByYou: report.renames.filter((rename) => rename.by === "you").map((rename) => `${rename.table}${rename.kind === "column" ? `.${rename.from}` : ""} to ${rename.to}`),
        upperToLowerCaseNames: report.renames.filter((rename) => rename.by === "case").length,
        droppedDefaults: report.droppedDefaults.map((entry) => `${entry.table}.${entry.column} (${entry.oracleDefault}): ${entry.detail}`),
        rewrittenDefaults: report.rewrittenDefaults.map((entry) => `${entry.table}.${entry.column}: ${entry.oracleDefault} ${entry.detail}`),
        columnsToRead: worth.slice(0, 60).map(({ table, column }) => ({
            column: `${table.pgName}.${column.pgName}`,
            from: column.oracleType,
            to: column.pgType,
            status: column.status,
            whatTheCopyDoes: column.dataChange.summary,
            counted: [...(column.facts?.affected ?? []).map((entry) => `${entry.count} ${entry.label}`), ...(column.facts ? [`${column.facts.nulls} NULL of ${column.facts.nulls + column.facts.values}`] : [])],
        })),
        mustAccept: report.mustAccept.map((entry) => `${entry.table}.${entry.column}: ${entry.count === null ? "the check could not run" : `${entry.count} ${entry.description}`}`),
        notCarried: report.notCarried.map((entry) => `${entry.kind} ${entry.name}${entry.canCarry === undefined ? "" : entry.canCarry ? " (can be carried over if asked)" : ` (cannot be carried over: ${entry.reason})`}`),
        carried: report.carried.map((entry) => `${entry.kind} ${entry.name} ${entry.detail}`),
        behaviour: report.behaviour,
        problems: report.problems,
        editProblems: report.editProblems,
    };
}

/** What the person changed, one line each, from the edits as they stand. */
export function describeEdits(edits: MigrationEdits): string[] {
    const lines: string[] = [];
    for (const [table, edit] of Object.entries(edits.tables ?? {})) if (edit.pgName !== undefined) lines.push(`table ${table} is called ${edit.pgName}`);
    for (const [key, edit] of Object.entries(edits.columns ?? {})) {
        if (edit.pgName !== undefined) lines.push(`column ${key} is called ${edit.pgName}`);
        if (edit.pgType !== undefined) lines.push(`column ${key} is ${edit.pgType}`);
        if (edit.dropDefault) lines.push(`the default of ${key} is dropped`);
    }
    for (const [key, edit] of Object.entries(edits.objects ?? {})) if (edit.carry) lines.push(`${key.replace(":", " ")} is carried over`);
    return lines;
}

/** Each foreign key with the PostgreSQL type of every column on both sides: what a reviewer needs to see that a parent and a child still agree. */
export function foreignKeysOf(tables: OracleTable[], report: MigrationReport): { from: string; to: string; fromTypes: string[]; toTypes: string[]; sameTypes: boolean }[] {
    const typeOf = (table: string, column: string) => report.tables.find((candidate) => candidate.oracleName === table)?.columns.find((candidate) => candidate.oracleName === column)?.pgType ?? "?";
    return tables.flatMap((table) =>
        table.foreignKeys.map((key) => {
            const fromTypes = key.columns.map((column) => typeOf(table.name, column));
            const toTypes = key.refColumns.map((column) => typeOf(key.refTable, column));
            return { from: `${table.name}(${key.columns.join(", ")})`, to: `${key.refTable}(${key.refColumns.join(", ")})`, fromTypes, toTypes, sameTypes: fromTypes.length === toTypes.length && fromTypes.every((type, at) => type === toTypes[at]) };
        }),
    );
}

const REVIEW_COLUMN_CAP = 300;

/**
 * What the plan reviewer is shown: every table and column with how it fares, the foreign keys, the counts, what is carried and left behind,
 * and what the person changed. Never a sample row. Beyond a few hundred columns only the ones that are not plain "same" are listed, and it says so.
 */
export function digestForReview(report: MigrationReport, extra: { edits: MigrationEdits; tables: OracleTable[] }) {
    const total = report.tables.reduce((sum, table) => sum + table.columns.length, 0);
    const everything = total <= REVIEW_COLUMN_CAP;
    return {
        source: report.source,
        verdict: report.verdict,
        summary: report.summary,
        dataRead: report.dataRead,
        changesTheyMade: describeEdits(extra.edits),
        tables: report.tables.map((table) => ({
            table: table.oracleName,
            becomes: table.pgName,
            rows: table.rows,
            primaryKey: table.primaryKey,
            columns: table.columns
                .filter((column) => everything || column.status !== "exact" || column.edited.length > 0 || column.facts?.affected.some((entry) => entry.count > 0))
                .map((column) => ({
                    column: column.oracleName,
                    from: column.oracleType,
                    to: column.pgType,
                    status: column.status,
                    ...(column.edited.length > 0 ? { changedByThem: column.edited } : {}),
                    ...(column.oracleDefault !== null ? { oracleDefault: column.oracleDefault, pgDefault: column.pgDefault } : {}),
                    whatTheCopyDoes: column.dataChange.summary,
                    counted: [...(column.facts?.affected ?? []).map((entry) => `${entry.count} ${entry.label}`), ...(column.facts ? [`${column.facts.nulls} NULL of ${column.facts.nulls + column.facts.values}`] : [])],
                })),
        })),
        columnsListed: everything ? "all" : `only those that are not plain 'exact', of ${total}`,
        foreignKeys: foreignKeysOf(extra.tables, report),
        mustAccept: report.mustAccept.map((entry) => `${entry.table}.${entry.column}: ${entry.count === null ? "the check could not run" : `${entry.count} ${entry.description}`}`),
        carriedOver: report.carried.map((entry) => `${entry.kind} ${entry.name} ${entry.detail}`),
        leftBehind: report.notCarried.map((entry) => `${entry.kind} ${entry.name}${entry.detail ? ` (${entry.detail})` : ""}${entry.canCarry === undefined ? "" : entry.canCarry ? ": could be carried over if asked" : `: cannot be carried over, ${entry.reason}`}`),
        behaviour: report.behaviour,
        problems: report.problems,
        editProblems: report.editProblems,
    };
}
