export interface DiffLine {
    type: "same" | "added" | "removed";
    text: string;
}

const MAX_LINES = 1500;

/** A line-by-line diff (longest common subsequence). Lines are compared ignoring leading and trailing space. */
export function diffLines(before: string, after: string): DiffLine[] {
    const a = before.replace(/\r\n/g, "\n").split("\n");
    const b = after.replace(/\r\n/g, "\n").split("\n");
    if (a.length > MAX_LINES || b.length > MAX_LINES) return [...a.map((text) => ({ type: "removed" as const, text })), ...b.map((text) => ({ type: "added" as const, text }))];

    const same = (x: string, y: string) => x.trim() === y.trim();
    // lengths[i][j] = length of the LCS of a[i..] and b[j..]
    const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lengths[i][j] = same(a[i], b[j]) ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);

    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (same(a[i], b[j])) {
            out.push({ type: "same", text: b[j] });
            i++;
            j++;
        } else if (lengths[i + 1][j] >= lengths[i][j + 1]) out.push({ type: "removed", text: a[i++] });
        else out.push({ type: "added", text: b[j++] });
    }
    while (i < a.length) out.push({ type: "removed", text: a[i++] });
    while (j < b.length) out.push({ type: "added", text: b[j++] });
    return out;
}
