export interface SqlHandoff {
    sql: string;
    /** Where it came from, shown in a comment above the SQL ("AI Schema", "Modernizer"). */
    source: string;
}

// Other pages send SQL to the editor by leaving it here and navigating; the editor takes it once when it opens.
let pending: SqlHandoff | undefined;

export function setSqlHandoff(handoff: SqlHandoff): void {
    pending = handoff;
}

export function takeSqlHandoff(): SqlHandoff | undefined {
    const handoff = pending;
    pending = undefined;
    return handoff;
}

/** The editor's new text: the handed-over SQL alone if the editor is empty, otherwise appended under a comment saying where it came from. */
export function applySqlHandoff(current: string, handoff: SqlHandoff): string {
    const sql = handoff.sql.trim();
    if (!current.trim()) return `${sql}\n`;
    return `${current.trimEnd()}\n\n-- From ${handoff.source}\n${sql}\n`;
}
