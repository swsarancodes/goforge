const isIdentStart = (ch: string | undefined) => !!ch && /[A-Za-z_\u0080-￿]/.test(ch);
const isIdentChar = (ch: string | undefined) => !!ch && /[A-Za-z0-9_$\u0080-￿]/.test(ch);

/**
 * Returns `sql` with everything that is not code blanked out (replaced by spaces, newlines kept) so the result can be
 * scanned for keywords and `;` without being fooled by them appearing inside text: `-- line` and nested
 * `/* block *\/` comments, 'strings' (including E'..\'..' escapes), "quoted identifiers" and $tag$dollar quoted$tag$
 * bodies. The result has exactly the same length, so offsets map back onto the original.
 */
export function maskSql(sql: string): string {
    const out = sql.split("");
    const blank = (from: number, to: number) => {
        for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
    };

    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        const next = sql[i + 1];

        if (ch === "-" && next === "-") {
            let end = sql.indexOf("\n", i);
            if (end === -1) end = sql.length;
            blank(i, end);
            i = end;
        } else if (ch === "/" && next === "*") {
            let depth = 1;
            let j = i + 2;
            while (j < sql.length && depth > 0) {
                if (sql[j] === "/" && sql[j + 1] === "*") {
                    depth++;
                    j += 2;
                } else if (sql[j] === "*" && sql[j + 1] === "/") {
                    depth--;
                    j += 2;
                } else j++;
            }
            blank(i, j);
            i = j;
        } else if (ch === "'") {
            // E'...' strings treat backslash as an escape character; plain strings do not.
            const escapeString = i > 0 && /[eE]/.test(sql[i - 1]) && !isIdentChar(sql[i - 2]);
            let j = i + 1;
            while (j < sql.length) {
                if (escapeString && sql[j] === "\\") j += 2;
                else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
                else if (sql[j] === "'") break;
                else j++;
            }
            blank(i, Math.min(j + 1, sql.length));
            i = j + 1;
        } else if (ch === '"') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
                else if (sql[j] === '"') break;
                else j++;
            }
            blank(i, Math.min(j + 1, sql.length));
            i = j + 1;
        } else if (ch === "$" && !isIdentChar(sql[i - 1])) {
            // $tag$ ... $tag$ (the tag may be empty). `$1` is a parameter, not a dollar quote.
            let j = i + 1;
            if (isIdentStart(sql[j])) while (isIdentChar(sql[j]) && sql[j] !== "$") j++;
            if (sql[j] === "$") {
                const tag = sql.slice(i, j + 1);
                const close = sql.indexOf(tag, j + 1);
                const end = close === -1 ? sql.length : close + tag.length;
                blank(i, end);
                i = end;
            } else i++;
        } else i++;
    }

    return out.join("");
}

export interface SqlStatement {
    text: string;
    /** Offset of `text` within the original SQL. */
    start: number;
}

/** Splits on `;` that are real statement separators (not inside comments, strings or dollar-quoted bodies); drops empty statements. */
export function splitSqlStatements(sql: string): SqlStatement[] {
    const masked = maskSql(sql);
    const statements: SqlStatement[] = [];
    let from = 0;

    const push = (to: number) => {
        const raw = sql.slice(from, to);
        // A statement that is only whitespace and comments has nothing to run.
        if (masked.slice(from, to).trim() === "") return;
        const leading = raw.length - raw.trimStart().length;
        statements.push({ text: raw.trim(), start: from + leading });
    };

    for (let i = 0; i < masked.length; i++) {
        if (masked[i] === ";") {
            push(i);
            from = i + 1;
        }
    }
    push(masked.length);
    return statements;
}

const TRANSACTION_CONTROL = /^(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b/i;

/** The first statement that starts or ends a transaction or savepoint, if any (those belong to the Commit / Roll back buttons). */
export function findTransactionControl(sql: string): string | undefined {
    const masked = maskSql(sql);
    for (const statement of splitSqlStatements(sql)) {
        const code = masked.slice(statement.start, statement.start + statement.text.length).trim();
        const match = TRANSACTION_CONTROL.exec(code);
        if (match) return match[1].replace(/\s+/g, " ").toUpperCase();
    }
    return undefined;
}

const READ_QUERY_START = /^(select|with|values|table)\b/i;
const NOT_CURSOR_SAFE = /\b(insert|update|delete|merge|into)\b/i;

/**
 * True for a single read-only-looking statement that can be fetched through a cursor (`SELECT`, `VALUES`, `TABLE`, or a
 * `WITH` that doesn't modify data). Conservative on purpose: the caller falls back to running the SQL as written
 * if Postgres still refuses the cursor.
 */
export function isSingleReadQuery(sql: string): boolean {
    const statements = splitSqlStatements(sql);
    if (statements.length !== 1) return false;
    const masked = maskSql(statements[0].text).trim();
    return READ_QUERY_START.test(masked) && !NOT_CURSOR_SAFE.test(masked);
}
