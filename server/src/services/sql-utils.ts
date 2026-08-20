// The frontend renderer wraps its DDL output in its own BEGIN/COMMIT (needed when a
// user copies the SQL out to run manually elsewhere). But /preview and /execute here
// own the transaction boundary themselves - preview's safety guarantee depends on
// nothing else committing before its own rollback, and a stray embedded "COMMIT;"
// mid-list would commit for real right then, silently defeating the dry-run. Strip
// these control statements out; only the statements that actually change something
// should reach the pg client.
const TRANSACTION_CONTROL = /^(BEGIN|START TRANSACTION|COMMIT|ROLLBACK|END)\s*;?$/i;

/**
 * Splits a multi-statement SQL string on top-level semicolons, ignoring
 * semicolons inside single-quoted string literals (with '' escaping) so a
 * default value like 'a;b' doesn't get split mid-statement. Strips any
 * transaction-control statements (BEGIN/COMMIT/etc.) - see TRANSACTION_CONTROL.
 */
export function splitStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = "";
    let inString = false;

    for (let i = 0; i < sql.length; i++) {
        const char = sql[i];

        if (char === "'") {
            // A doubled '' inside a string is an escaped quote, not a terminator.
            if (inString && sql[i + 1] === "'") {
                current += "''";
                i++;
                continue;
            }
            inString = !inString;
            current += char;
            continue;
        }

        if (char === ";" && !inString) {
            const trimmed = current.trim();
            if (trimmed.length > 0) statements.push(trimmed);
            current = "";
            continue;
        }

        current += char;
    }

    const trimmed = current.trim();
    if (trimmed.length > 0) statements.push(trimmed);

    return statements.filter((statement) => !TRANSACTION_CONTROL.test(statement));
}
