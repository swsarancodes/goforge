/**
 * Splits an Oracle script into the statements the driver runs one at a time. The driver takes one statement per call and rejects a
 * trailing `;`, while SQL*Plus-style scripts end plain statements with `;` and PL/SQL blocks with a line holding only `/`. So:
 *   - a line that is only `/` ends whatever statement is being read;
 *   - `;` ends a plain statement, outside quotes, q'[...]' strings and comments, and is not part of the text that is run;
 *   - a statement that starts a PL/SQL block (BEGIN, DECLARE, CREATE [OR REPLACE] FUNCTION/PROCEDURE/PACKAGE/TRIGGER/TYPE, ...) runs to
 *     the next `/` line, or to the end, and keeps its own final `;`.
 * Each statement carries the offset where it started, so an error position can be given for the whole script.
 */
export interface OracleStatement {
    text: string;
    /** 0-based offset of `text` in the script. */
    offset: number;
}

const BLOCK_START = /^(begin|declare|create\s+(or\s+replace\s+)?(editionable\s+|noneditionable\s+)?(function|procedure|package|trigger|type|library|java)\b)/i;

/** The text with comments, strings and quoted names blanked to spaces (same length), so a `;` or a keyword inside them is not seen. */
function blank(sql: string): string {
    const out = sql.split("");
    const wipe = (from: number, to: number) => {
        for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
    };
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        const next = sql[i + 1];
        if (c === "-" && next === "-") {
            let end = i;
            while (end < sql.length && sql[end] !== "\n") end++;
            wipe(i, end);
            i = end;
        } else if (c === "/" && next === "*") {
            const end = sql.indexOf("*/", i + 2);
            const stop = end < 0 ? sql.length : end + 2;
            wipe(i, stop);
            i = stop;
        } else if ((c === "q" || c === "Q") && next === "'" && sql[i + 2] !== undefined && !/\s/.test(sql[i + 2]) && !/[\w$#]/.test(sql[i - 1] ?? " ")) {
            const open = sql[i + 2];
            const close = ({ "[": "]", "{": "}", "(": ")", "<": ">" } as Record<string, string>)[open] ?? open;
            const end = sql.indexOf(`${close}'`, i + 3);
            const stop = end < 0 ? sql.length : end + 2;
            wipe(i, stop);
            i = stop;
        } else if (c === "'") {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
                else if (sql[j] === "'") break;
                else j++;
            }
            wipe(i, j + 1);
            i = j + 1;
        } else if (c === '"') {
            const end = sql.indexOf('"', i + 1);
            const stop = end < 0 ? sql.length : end + 1;
            wipe(i, stop);
            i = stop;
        } else i++;
    }
    return out.join("");
}

export function splitOracleScript(script: string): OracleStatement[] {
    const sql = script.replace(/\r\n?/g, "\n");
    const seen = blank(sql);
    const statements: OracleStatement[] = [];

    const push = (start: number, end: number, keepSemicolon: boolean) => {
        let text = sql.slice(start, end);
        const lead = text.length - text.trimStart().length;
        text = text.trim();
        if (!keepSemicolon) text = text.replace(/;\s*$/, "").trimEnd();
        // nothing but whitespace and comments is not a statement
        if (blank(text).trim() === "") return;
        statements.push({ text, offset: start + lead });
    };

    let start = 0;
    let i = 0;
    while (i < sql.length) {
        // where the statement being read really begins: after whitespace and comments
        const head = seen.slice(start).trimStart();
        const isBlock = BLOCK_START.test(head);
        const lineEnd = seen.indexOf("\n", i) < 0 ? sql.length : seen.indexOf("\n", i);
        const line = seen.slice(i, lineEnd);
        if (/^\s*\/\s*$/.test(line) && !/^\s*\/\s*$/.test(seen.slice(start, i)) ) {
            push(start, i, isBlock);
            start = lineEnd + 1;
            i = start;
            continue;
        }
        if (/^\s*\/\s*$/.test(line)) {
            // a lone `/` with nothing before it: skip it
            start = lineEnd + 1;
            i = start;
            continue;
        }
        if (!isBlock) {
            const semicolon = seen.indexOf(";", i);
            if (semicolon >= 0 && semicolon < lineEnd) {
                push(start, semicolon + 1, false);
                start = semicolon + 1;
                i = start;
                continue;
            }
        }
        i = lineEnd + 1;
    }
    push(start, sql.length, BLOCK_START.test(seen.slice(start).trimStart()));
    return statements;
}
