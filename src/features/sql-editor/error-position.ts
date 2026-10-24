/** 1-based line and column of a 1-based character `position` in `sql`. */
export function positionToLineColumn(sql: string, position: number): { line: number; column: number } {
    const index = Math.max(0, Math.min(position - 1, sql.length));
    const before = sql.slice(0, index);
    const line = before.split("\n").length;
    const column = index - (before.lastIndexOf("\n") + 1) + 1;
    return { line, column };
}

/** The text to select for an error at `position`: the word under it, or one character for punctuation. 0-based, end exclusive. */
export function errorRange(sql: string, position: number): { from: number; to: number } {
    const from = Math.max(0, Math.min(position - 1, sql.length));
    let to = from;
    while (to < sql.length && /[A-Za-z0-9_$]/.test(sql[to])) to++;
    return { from, to: to > from ? to : Math.min(from + 1, sql.length) };
}
