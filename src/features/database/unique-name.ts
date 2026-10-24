/** `orders`, then `orders (2)`, `orders (3)`…, so a second connection to the same database does not overwrite the first project. */
export const uniqueName = (wanted: string, taken: string[]): string => {
    const used = new Set(taken.map((name) => name.toLowerCase()));
    if (!used.has(wanted.toLowerCase())) return wanted;
    let suffix = 2;
    while (used.has(`${wanted} (${suffix})`.toLowerCase())) suffix++;
    return `${wanted} (${suffix})`;
};
