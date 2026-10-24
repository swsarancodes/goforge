/** A problem with what the caller asked for (unknown relation/column), as opposed to a connection or SQL failure. */
export class DataRequestError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
        this.name = "DataRequestError";
    }
}

/** Quotes a Postgres identifier. Equivalent to pg's Client#escapeIdentifier, but usable without a client. */
export function quoteIdent(name: string): string {
    if (name.includes("\0")) throw new DataRequestError("Identifier contains a null byte");
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quotes a string as a Postgres literal (same rules as pg's Client#escapeLiteral): quotes are doubled and, when the
 * value contains a backslash, the literal is written as an E'' string so the backslash is doubled safely.
 */
export function quoteLiteral(value: string): string {
    if (value.includes("\0")) throw new DataRequestError("Value contains a null byte");
    const escaped = value.replace(/'/g, "''").replace(/\\/g, "\\\\");
    return value.includes("\\") ? `E'${escaped}'` : `'${escaped}'`;
}
