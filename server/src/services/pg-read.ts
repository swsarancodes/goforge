import type { QueryResult } from "pg";

export const STATEMENT_TIMEOUT_MS = 15_000;

/** The one thing the read helpers need from a pg client (a Client, a PoolClient, or a test double). */
export interface Queryable {
    query(text: string): Promise<unknown>;
}

/**
 * Runs read-only SQL in ONE round trip: `BEGIN READ ONLY; SET LOCAL statement_timeout; <statements>; ROLLBACK`
 * is sent as a single simple-protocol multi-statement query and always ends in a rollback, so it can't change
 * anything and leaves no transaction open. Returns only the results of `statements`, in order.
 *
 * Statements must not contain bound parameters (inline validated values instead) and must not end with `;`.
 * If any statement fails the transaction is left aborted: callers must discard the client (the pool does this
 * for any error that carries a SQLSTATE code).
 */
export async function runReadOnly(client: Queryable, statements: string[]): Promise<QueryResult[]> {
    const text = ["BEGIN READ ONLY", `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`, ...statements, "ROLLBACK"].join("; ");
    const raw = (await client.query(text)) as QueryResult | QueryResult[];
    const results = Array.isArray(raw) ? raw : [raw];
    // [BEGIN, SET, ...statements, ROLLBACK]
    return results.slice(2, results.length - 1);
}
