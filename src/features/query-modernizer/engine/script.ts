import type { LegacyDialect } from "../types";

/**
 * Splits a legacy SQL file into the statements it contains, the way the tool that wrote it would have run them:
 * `;` everywhere, a lone `/` line in Oracle scripts, `GO` batches in T-SQL, `DELIMITER` and `--#SET TERMINATOR` where the dialect has them.
 * Procedures, functions, packages, triggers and anonymous blocks are kept whole (their body is full of `;`) and labelled
 * "procedural": they are not queries and the converter does not translate them. Anything the splitter can't be sure about is
 * said in `warnings` instead of being guessed.
 */

export type UnitKind =
    /** SELECT, INSERT, UPDATE, DELETE, MERGE, WITH ...: what the converter handles. */
    | "query"
    /** CREATE TABLE / INDEX / VIEW, ALTER, DROP, GRANT ...: schema statements, converted by other tools. */
    | "ddl"
    /** Procedures, functions, packages, triggers, anonymous blocks, CALL / EXEC, flow control. */
    | "procedural"
    /** SET, USE, COMMIT, SQL*Plus commands: they configure the session and have no PostgreSQL query form. */
    | "session"
    /** A statement that starts with a word this splitter does not know. */
    | "other";

export interface ScriptUnit {
    /** 0-based position among the units. */
    index: number;
    kind: UnitKind;
    /** First word, upper case: SELECT, CREATE, DECLARE ... */
    keyword: string;
    /** The statement as written, without its terminator and without the comments before it. */
    text: string;
    /** Comments and blank lines between the previous statement and this one. */
    comments: string;
    /** 1-based lines of the first and last character of `text`. */
    startLine: number;
    endLine: number;
    /** Why this unit looks the way it does (for example: "no terminator, so it runs to the end of the file"). */
    note?: string;
}

export interface ScriptSplit {
    units: ScriptUnit[];
    warnings: string[];
    lineCount: number;
}

const QUERY_WORDS = new Set(["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "REPLACE", "EXPLAIN", "UPSERT"]);
const DDL_WORDS = new Set(["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "COMMENT", "GRANT", "REVOKE", "ANALYZE", "AUDIT", "NOAUDIT", "FLASHBACK", "PURGE", "LOCK", "OPTIMIZE", "REPAIR"]);
const PROCEDURAL_WORDS = new Set(["CALL", "EXEC", "EXECUTE", "DECLARE", "BEGIN", "IF", "WHILE", "RETURN", "GOTO", "RAISERROR", "THROW", "OPEN", "FETCH", "CLOSE", "DEALLOCATE", "LOOP", "FOR", "CASE", "ELSE", "END", "BREAK", "CONTINUE", "TRY", "CATCH"]);
const SESSION_WORDS = new Set(["SET", "USE", "COMMIT", "ROLLBACK", "SAVEPOINT", "START", "PRINT", "SHOW", "DESCRIBE", "DESC", "DELIMITER", "GO", "CONNECT", "DISCONNECT", "PROMPT", "SPOOL", "REM", "REMARK", "DEFINE", "UNDEFINE", "WHENEVER", "EXIT", "QUIT", "COLUMN", "COL", "TTITLE", "BTITLE", "ACCEPT", "VARIABLE", "VAR", "CLEAR", "BREAK", "COMPUTE", "ECHO", "TERMINATE"]);

/** SQL*Plus commands: one line, no terminator needed. */
const SQLPLUS = /^(SET|SPOOL|PROMPT|REM|REMARK|DEFINE|UNDEFINE|WHENEVER|EXIT|QUIT|COLUMN|COL|TTITLE|BTITLE|ACCEPT|VARIABLE|VAR|PRINT|SHOW|START|CLEAR|BREAK|COMPUTE|ECHO|CONNECT|DISCONNECT|DESCRIBE|DESC)\b|^@/i;

const PROGRAM_UNIT = {
    oracle: /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|LIBRARY|JAVA)\b/i,
    mssql: /^(?:CREATE|ALTER)\s+(?:OR\s+ALTER\s+)?(?:PROC|PROCEDURE|FUNCTION|TRIGGER)\b/i,
    mysql: /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i,
    db2: /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|PACKAGE|MODULE|TYPE)\b/i,
} satisfies Record<LegacyDialect, RegExp>;

const Q_CLOSE: Record<string, string> = { "[": "]", "(": ")", "{": "}", "<": ">" };

export function splitScript(input: string, dialect: LegacyDialect): ScriptSplit {
    const text = input.replace(/^﻿/, "");
    const n = text.length;
    const warnings: string[] = [];
    const lineStarts = [0];
    for (let i = 0; i < n; i++) if (text[i] === "\n") lineStarts.push(i + 1);
    const lineAt = (offset: number): number => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (lineStarts[mid] <= offset) low = mid;
            else high = mid - 1;
        }
        return low + 1;
    };

    const units: ScriptUnit[] = [];
    let delimiter = ";";
    let carriedComments = "";

    interface Open {
        start: number;
        codeStart: number;
        /** program unit: ends only at / GO / custom delimiter / end of file */
        strong: boolean;
        /** flow code: ends at `;` once BEGIN/END and CASE/END are balanced */
        weak: boolean;
        depth: number;
        sqlplus: boolean;
    }
    let open: Open | undefined;
    let unitStart = 0;

    /** Index of the first character that is not whitespace or a comment, or `end` if there is none. */
    const firstCode = (from: number, end: number): number => {
        let i = from;
        while (i < end) {
            const ch = text[i];
            if (/\s/.test(ch)) i++;
            else if (ch === "-" && text[i + 1] === "-" && (dialect !== "mysql" || /\s/.test(text[i + 2] ?? " "))) i = lineEnd(i);
            else if (ch === "#" && dialect === "mysql") i = lineEnd(i);
            else if (ch === "/" && text[i + 1] === "*") {
                const close = text.indexOf("*/", i + 2);
                i = close === -1 || close + 2 > end ? end : close + 2;
            } else return i;
        }
        return end;
    };
    const lineEnd = (from: number): number => {
        const found = text.indexOf("\n", from);
        return found === -1 ? n : found;
    };

    const finish = (end: number, note?: string, dropSemicolon = false) => {
        const codeStart = firstCode(unitStart, end);
        const comments = text.slice(unitStart, codeStart);
        if (codeStart >= end) {
            carriedComments += comments;
            return;
        }
        let body = text.slice(codeStart, end).replace(/\s+$/, "");
        if (dropSemicolon) body = body.replace(/\s*;$/, "");
        const { kind, keyword } = classify(body, dialect);
        units.push({
            index: units.length,
            kind,
            keyword,
            text: body,
            comments: carriedComments + comments,
            startLine: lineAt(codeStart),
            endLine: lineAt(codeStart + Math.max(0, body.length - 1)),
            ...(note ? { note } : {}),
        });
        carriedComments = "";
    };

    const begin = (codeStart: number): Open => {
        const peek = text.slice(codeStart, codeStart + 400).replace(/\s+/g, " ");
        const word = /^[A-Za-z]+/.exec(peek)?.[0].toUpperCase() ?? "";
        const programUnit = PROGRAM_UNIT[dialect].test(peek);
        const transaction = /^BEGIN\s+(?:WORK|TRAN|TRANSACTION|DISTRIBUTED)\b/i.test(peek);
        let strong = false;
        let weak = false;
        if (programUnit) {
            // The body is full of `;`. Oracle and T-SQL end it with a / or GO line; MySQL and DB2 with their custom delimiter, or, without one, at the `;` after the balanced END.
            if (delimiter !== ";" || dialect === "oracle" || dialect === "mssql") strong = true;
            else weak = true;
        } else if (!transaction) {
            if (dialect === "oracle") {
                strong = word === "DECLARE"; // declarations end in `;` too, so only the / line ends the block
                weak = word === "BEGIN";
            } else if (word === "BEGIN" || word === "IF" || word === "WHILE") weak = true;
        }
        return { start: codeStart, codeStart, strong, weak, depth: 0, sqlplus: dialect === "oracle" && SQLPLUS.test(peek) };
    };

    let i = 0;
    while (i < n) {
        const atLineStart = i === 0 || text[i - 1] === "\n";

        if (atLineStart) {
            const eol = lineEnd(i);
            const line = text.slice(i, eol);

            // statement separators that sit on a line of their own
            if (dialect === "mssql" && /^[ \t]*GO[ \t]*\d*[ \t]*(?:--.*)?\r?$/i.test(line)) {
                if (open) finish(i, open.strong ? "runs to the GO line" : undefined);
                open = undefined;
                unitStart = Math.min(n, eol + 1);
                i = unitStart;
                continue;
            }
            if (dialect === "oracle" && /^[ \t]*\/[ \t]*\r?$/.test(line)) {
                if (open) finish(i);
                open = undefined;
                unitStart = Math.min(n, eol + 1);
                i = unitStart;
                continue;
            }
            if (!open) {
                const directive = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*\r?$/i.exec(line);
                if (dialect === "mysql" && directive) {
                    delimiter = directive[1];
                    carriedComments += text.slice(unitStart, i);
                    unitStart = Math.min(n, eol + 1);
                    i = unitStart;
                    continue;
                }
                const terminator = /^[ \t]*--#SET[ \t]+TERMINATOR[ \t]+(\S+)[ \t]*\r?$/i.exec(line);
                if (dialect === "db2" && terminator) {
                    delimiter = terminator[1];
                    carriedComments += text.slice(unitStart, i);
                    unitStart = Math.min(n, eol + 1);
                    i = unitStart;
                    continue;
                }
            }
        }

        const ch = text[i];

        // whitespace and comments never start a statement
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (ch === "-" && text[i + 1] === "-" && (dialect !== "mysql" || /\s/.test(text[i + 2] ?? " "))) {
            i = lineEnd(i);
            continue;
        }
        if (ch === "#" && dialect === "mysql") {
            i = lineEnd(i);
            continue;
        }
        if (ch === "/" && text[i + 1] === "*") {
            const close = text.indexOf("*/", i + 2);
            if (close === -1) {
                warnings.push(`A /* comment that starts on line ${lineAt(i)} is never closed; everything after it is ignored.`);
                if (open) finish(n, "an unclosed comment");
                else carriedComments += text.slice(unitStart);
                open = undefined;
                unitStart = n;
                i = n;
                break;
            }
            i = close + 2;
            continue;
        }

        // the first character of code opens a statement
        if (!open) {
            open = begin(i);
            if (open.sqlplus) {
                const eol = lineEnd(i);
                finish(eol, undefined, true);
                open = undefined;
                unitStart = Math.min(n, eol + 1);
                i = unitStart;
                continue;
            }
        }

        // strings and quoted names
        if (ch === "'" || ch === '"' || ch === "`" || (ch === "[" && dialect === "mssql")) {
            const close = skipQuoted(text, i, dialect);
            if (close === -1) {
                warnings.push(`A quote that starts on line ${lineAt(i)} is never closed; the rest of the file is kept as one statement.`);
                finish(n, "an unclosed quote");
                open = undefined;
                unitStart = n;
                i = n;
                break;
            }
            i = close;
            continue;
        }
        if ((ch === "q" || ch === "Q") && text[i + 1] === "'" && dialect === "oracle" && text[i + 2] && !/\s/.test(text[i + 2])) {
            const closeChar = Q_CLOSE[text[i + 2]] ?? text[i + 2];
            const end = text.indexOf(`${closeChar}'`, i + 3);
            if (end === -1) {
                warnings.push(`A q'...' string that starts on line ${lineAt(i)} is never closed; the rest of the file is kept as one statement.`);
                finish(n, "an unclosed quote");
                open = undefined;
                unitStart = n;
                i = n;
                break;
            }
            i = end + 2;
            continue;
        }

        // words, for block depth
        if (/[A-Za-z_]/.test(ch)) {
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_$#]/.test(text[j])) j++;
            // a custom delimiter such as $$ can touch the word before it (END$$)
            if (delimiter !== ";") {
                const at = text.indexOf(delimiter, i + 1);
                if (at !== -1 && at < j) j = at;
            }
            if (open.weak || open.strong) {
                const word = text.slice(i, j).toUpperCase();
                if (word === "BEGIN" && !/^\s+(?:TRAN|TRANSACTION|DISTRIBUTED|WORK)\b/i.test(text.slice(j, j + 20))) open.depth++;
                else if (word === "CASE") open.depth++;
                else if (word === "END") {
                    const next = /^\s+([A-Za-z]+)/.exec(text.slice(j, j + 30))?.[1].toUpperCase();
                    if (!(next && ["IF", "LOOP", "WHILE", "REPEAT", "FOR"].includes(next)) && open.depth > 0) open.depth--;
                }
            }
            i = j;
            continue;
        }

        // the terminator
        if (text.startsWith(delimiter, i)) {
            const endsHere = open.strong ? delimiter !== ";" : open.weak ? open.depth === 0 : true;
            if (endsHere) {
                finish(i);
                open = undefined;
                unitStart = i + delimiter.length;
                i = unitStart;
                continue;
            }
            i += delimiter.length;
            continue;
        }

        i++;
    }

    if (open) {
        const note = open.strong ? "has no closing / or GO line, so it runs to the end of the file" : open.weak && open.depth > 0 ? "its BEGIN is never closed, so it runs to the end of the file" : undefined;
        if (note) warnings.push(`The statement on line ${lineAt(open.codeStart)} ${note}.`);
        finish(n, note);
    } else if (unitStart < n) {
        carriedComments += text.slice(unitStart);
    }

    return { units, warnings, lineCount: lineStarts.length };
}

/** Offset just after the quoted text that starts at `from`, or -1 when it is never closed. */
function skipQuoted(text: string, from: number, dialect: LegacyDialect): number {
    const quote = text[from];
    const close = quote === "[" ? "]" : quote;
    let i = from + 1;
    while (i < text.length) {
        const ch = text[i];
        if (ch === "\\" && dialect === "mysql" && quote !== "`") {
            i += 2;
            continue;
        }
        if (ch === close) {
            if (text[i + 1] === close) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i++;
    }
    return -1;
}

export function classify(body: string, dialect: LegacyDialect): { kind: UnitKind; keyword: string } {
    const squashed = body.replace(/\s+/g, " ");
    const first = /^[(A-Za-z@]+/.exec(squashed)?.[0] ?? "";
    const keyword = (first.startsWith("(") ? "SELECT" : first).toUpperCase();

    if (first.startsWith("(")) return { kind: /^\(\s*(?:SELECT|WITH)\b/i.test(squashed) ? "query" : "other", keyword };
    if (PROGRAM_UNIT[dialect].test(squashed)) return { kind: "procedural", keyword };
    if (/^BEGIN\s+(?:TRAN|TRANSACTION|WORK|DISTRIBUTED)\b/i.test(squashed)) return { kind: "session", keyword };
    if (QUERY_WORDS.has(keyword)) return { kind: "query", keyword };
    if (SESSION_WORDS.has(keyword) || keyword.startsWith("@")) return { kind: "session", keyword };
    if (PROCEDURAL_WORDS.has(keyword)) return { kind: "procedural", keyword };
    if (DDL_WORDS.has(keyword)) return { kind: "ddl", keyword };
    return { kind: "other", keyword: keyword || "?" };
}

export const UNIT_KIND_LABELS: Record<UnitKind, string> = {
    query: "query",
    ddl: "schema statement (DDL)",
    procedural: "procedure, function, package, trigger or block",
    session: "session or client command",
    other: "statement of an unknown kind",
};
