import type { QueryModernizationRequest } from "@/lib/ai-api";
import type { StatementCheck, ValidationResponse } from "@/lib/modernizer-api";
import type { SyntaxCheck } from "./engine/checks";
import { Conversion, convertQuery, neutralizeParameters } from "./engine/convert";
import { IndexAdvice, adviseIndexes } from "./engine/index-advice";
import type { AiConversion, LegacyDialect, SchemaContext } from "./types";

/** At most this many times the model is asked about one query; PostgreSQL's answer is fed back each time. */
export const MAX_AI_ATTEMPTS = 2;

export interface PostgresCheck {
    /** accepted / rejected / skipped: PostgreSQL's answer. not-run: no connection was chosen. unreachable: it could not be asked. */
    status: "accepted" | "rejected" | "skipped" | "not-run" | "unreachable";
    connectionName?: string;
    statements: StatementCheck[];
    message?: string;
}

export interface AiRun {
    model: string;
    summary: string;
    changes: string[];
    /** The model's own words. Nothing checks them. */
    risks: string[];
    unsupported: string[];
    attempts: number;
    /** Whether PostgreSQL itself (rather than only a syntax check) accepted the model's SQL. */
    checkedByDatabase: boolean;
}

export interface ModernizeOutcome {
    dialect: LegacyDialect;
    original: string;
    /** What the built-in rules did, always kept. */
    engine: Conversion;
    /** The SQL to show: the rules' conversion, or the model's if the rules couldn't finish and PostgreSQL accepted the model's. */
    sql: string;
    source: "rules" | "ai";
    ai?: AiRun;
    /** Why the model's answer isn't the one shown (or couldn't be had). */
    aiNotice?: string;
    /** Syntax check of `sql` by a PostgreSQL grammar, offline. */
    syntax: SyntaxCheck;
    /** The database's answer about `sql`. */
    postgres: PostgresCheck;
    advice: IndexAdvice;
    elapsedMs: number;
}

export interface ModernizeDeps {
    syntax: (sql: string) => Promise<SyntaxCheck>;
    /** Asks a live database whether it accepts the SQL. Absent when no connection is chosen. */
    validate?: (sql: string) => Promise<ValidationResponse>;
    connectionName?: string;
    /** Asks the model. Absent when it's off or not configured. */
    ask?: (request: QueryModernizationRequest) => Promise<{ result: AiConversion; model: string }>;
    /**
     * Ask the model for the answer whatever the rules did, instead of only for what they could not do. The rules' conversion is still
     * made, shown as the fallback, and given to the model as a draft. The model's answer is still shown only if PostgreSQL accepts it.
     */
    aiFirst?: boolean;
    onStage?: (label: string) => void;
}

const NOT_RUN: PostgresCheck = { status: "not-run", statements: [] };

/** PostgreSQL says the table or the schema is not there. That is about the connection, not the SQL: a model cannot repair it, so it is not asked. */
export const MISSING_OBJECT_CODES = new Set(["42P01", "3F000"]);

const objectMissing = (check: PostgresCheck): boolean => check.status === "rejected" && check.statements.some((statement) => statement.status === "rejected" && MISSING_OBJECT_CODES.has(statement.error?.code ?? ""));

async function askPostgres(sql: string, deps: ModernizeDeps): Promise<PostgresCheck> {
    if (!deps.validate) return NOT_RUN;
    try {
        const response = await deps.validate(sql);
        return { status: response.status, statements: response.statements, connectionName: deps.connectionName };
    } catch (error) {
        return { status: "unreachable", statements: [], connectionName: deps.connectionName, message: error instanceof Error ? error.message : String(error) };
    }
}

const firstError = (check: PostgresCheck): string | undefined => {
    const rejected = check.statements.find((statement) => statement.status === "rejected");
    return rejected?.error ? `${rejected.error.message}${rejected.error.position ? ` (at character ${rejected.error.position} of the statement ${rejected.index + 1})` : ""}` : undefined;
};

/** Is this SQL acceptable: the database accepts it, or (when it can't give an answer) a PostgreSQL grammar does. */
const passes = (check: PostgresCheck, syntax: SyntaxCheck): boolean => (check.status === "accepted" ? true : check.status === "rejected" ? false : syntax.ok);

/**
 * Converts one query: the rules first, always. PostgreSQL is then asked whether it accepts the result (if a connection
 * is chosen). Only when the rules left something unconverted, or PostgreSQL rejected their SQL, is the model asked,
 * and its answer is shown only if PostgreSQL (or, with no connection, a PostgreSQL grammar) accepts it.
 */
export async function modernize(input: { sql: string; dialect: LegacyDialect; schema?: SchemaContext }, deps: ModernizeDeps): Promise<ModernizeOutcome> {
    const startedAt = performance.now();
    const stage = (label: string) => deps.onStage?.(label);

    stage("Converting with the rules");
    const engine = convertQuery({ sql: input.sql, dialect: input.dialect, schema: input.schema });
    const base = { dialect: input.dialect, original: input.sql, engine };
    // The model may still read a query the rules could not parse, when it is the one asked to do the conversion.
    if (engine.syntaxError && !(deps.aiFirst && deps.ask)) {
        return { ...base, sql: input.sql, source: "rules", syntax: { ok: false, error: engine.syntaxError }, postgres: NOT_RUN, advice: { recommendations: [], notes: [] }, elapsedMs: Math.round(performance.now() - startedAt) };
    }

    stage(deps.validate ? "Asking PostgreSQL" : "Checking the syntax");
    let sql = engine.sql;
    let source: ModernizeOutcome["source"] = "rules";
    let syntax = await deps.syntax(engine.validationSql);
    let postgres = await askPostgres(engine.validationSql, deps);
    let ai: AiRun | undefined;
    let aiNotice: string | undefined;

    const needsHelp = (deps.aiFirst === true && deps.ask !== undefined) || engine.unconverted.length > 0 || (postgres.status === "rejected" && !objectMissing(postgres)) || (postgres.status !== "accepted" && !syntax.ok);
    if (needsHelp && deps.ask) {
        let lastError = firstError(postgres) ?? (!syntax.ok ? syntax.error : undefined);
        let candidate = engine.sql;
        let attempts = 0;

        for (; attempts < MAX_AI_ATTEMPTS; ) {
            attempts++;
            stage(`Asking the model (attempt ${attempts} of ${MAX_AI_ATTEMPTS})`);
            let reply;
            try {
                reply = await deps.ask({
                    legacySql: input.sql,
                    sourceDialect: input.dialect,
                    schema: input.schema,
                    draft: { sql: candidate, changes: engine.applied.map((rule) => rule.title), notConverted: engine.unconverted.map((item) => ({ construct: item.construct, reason: item.reason })), postgresError: lastError },
                });
            } catch (error) {
                aiNotice = `The model could not be asked: ${error instanceof Error ? error.message : String(error)}. Showing the rules' conversion.`;
                break;
            }

            candidate = reply.result.sql;
            const checkable = neutralizeParameters(candidate, input.dialect);
            stage(deps.validate ? "Asking PostgreSQL about the model's answer" : "Checking the model's answer");
            const candidateSyntax = await deps.syntax(checkable);
            const candidatePostgres = await askPostgres(checkable, deps);

            if (passes(candidatePostgres, candidateSyntax)) {
                sql = candidate;
                source = "ai";
                syntax = candidateSyntax;
                postgres = candidatePostgres;
                ai = { model: reply.model, summary: reply.result.summary, changes: reply.result.changes, risks: reply.result.risks, unsupported: reply.result.unsupported, attempts, checkedByDatabase: candidatePostgres.status === "accepted" };
                break;
            }
            lastError = firstError(candidatePostgres) ?? (!candidateSyntax.ok ? candidateSyntax.error : undefined) ?? "the answer was not accepted";
            if (attempts >= MAX_AI_ATTEMPTS) aiNotice = `The model's answer was not accepted after ${attempts} tries (${lastError}). Showing the rules' conversion.`;
        }
    }

    return {
        ...base,
        sql,
        source,
        ai,
        aiNotice,
        syntax,
        postgres,
        advice: adviseIndexes(sql, input.schema),
        elapsedMs: Math.round(performance.now() - startedAt),
    };
}
