/**
 * Whether `ALTER COLUMN ... TYPE` rewrites the table. PostgreSQL's documentation names the cases that don't: a binary-coercible
 * change, a longer or removed varchar limit, a larger numeric precision at the same scale. Everything else is treated as a rewrite
 * (PostgreSQL decides at run time; this errs towards the safe procedure). scripts/schema-change-pg16.ts checks each rule here
 * against a real server by watching whether the table's file is replaced.
 */

export interface ParsedType {
    base: string;
    args: number[];
    array: boolean;
}

const ALIASES: Record<string, string> = {
    varchar: "character varying",
    char: "character",
    bpchar: "character",
    int: "integer",
    int4: "integer",
    int8: "bigint",
    int2: "smallint",
    decimal: "numeric",
    float8: "double precision",
    float4: "real",
    bool: "boolean",
    timestamptz: "timestamp with time zone",
    timetz: "time with time zone",
};

/** `character varying(20)` -> { base: "character varying", args: [20] }; `timestamp(3) with time zone` keeps its precision in args. */
export function parseType(text: string): ParsedType {
    const array = /\[\s*\d*\s*\]\s*$/.test(text);
    const withoutArray = text.replace(/(\s*\[\s*\d*\s*\])+\s*$/, "");
    const args: number[] = [];
    const base = withoutArray
        .replace(/\(([^)]*)\)/g, (_, inside: string) => {
            for (const part of inside.split(",")) {
                const value = Number(part.trim());
                if (Number.isFinite(value)) args.push(value);
            }
            return "";
        })
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    return { base: ALIASES[base] ?? base, args, array };
}

export const sameType = (a: string, b: string): boolean => {
    const left = parseType(a);
    const right = parseType(b);
    return sameName(left.base, right.base) && left.array === right.array && left.args.join(",") === right.args.join(",");
};

/** `public.mood` and `mood` are the same type: PostgreSQL leaves the schema out of a type that is on the search path. */
const sameName = (a: string, b: string): boolean => {
    if (a === b) return true;
    const [left, right] = [a.split("."), b.split(".")];
    return (left.length === 1 || right.length === 1) && left[left.length - 1] === right[right.length - 1];
};

export interface TypeChangeVerdict {
    rewrite: boolean;
    reason: string;
}

export function classifyTypeChange(from: string, to: string, cast: "b" | "f" | undefined): TypeChangeVerdict {
    const a = parseType(from);
    const b = parseType(to);

    if (a.array !== b.array) return { rewrite: true, reason: "Changing between an array and a plain type rewrites every row." };

    if (a.base === "character varying" && b.base === "character varying") {
        if (b.args.length === 0) return { rewrite: false, reason: "Removing the length limit of a varchar only changes the catalog." };
        if (a.args.length > 0 && b.args[0] >= a.args[0]) return { rewrite: false, reason: "Raising the length limit of a varchar only changes the catalog." };
        return { rewrite: true, reason: "A smaller or new length limit means every row has to be checked and the table is rewritten." };
    }
    if (a.base === "character varying" && b.base === "text") return { rewrite: false, reason: "varchar to text is binary coercible: only the catalog changes." };
    if (a.base === "text" && b.base === "character varying" && b.args.length === 0) return { rewrite: false, reason: "text to an unlimited varchar is binary coercible: only the catalog changes." };

    if (a.base === "numeric" && b.base === "numeric") {
        if (b.args.length === 0) return { rewrite: false, reason: "Removing the precision of a numeric only changes the catalog." };
        if (a.args.length === 2 && b.args.length >= 1 && (b.args[1] ?? 0) === a.args[1] && b.args[0] >= a.args[0]) {
            return { rewrite: false, reason: "Raising the precision of a numeric at the same scale only changes the catalog." };
        }
        return { rewrite: true, reason: "Changing the scale or lowering the precision of a numeric rewrites every row." };
    }

    if (cast === "b" && a.args.length === 0 && b.args.length === 0) return { rewrite: false, reason: "The two types are binary coercible: only the catalog changes." };

    return { rewrite: true, reason: cast === "f" ? "The conversion calls a function on every row, so the table is rewritten." : "There is no binary-coercible cast between these types, so every row is converted and the table is rewritten." };
}
