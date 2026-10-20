import type { SchemaContext } from "../types";

export interface SyntaxCheck {
    ok: boolean;
    /** The parser's message when it rejects the SQL. */
    error?: string;
}

let ready: Promise<typeof import("@guanmingchiu/sqlparser-ts")> | undefined;

async function parser() {
    ready ??= import("@guanmingchiu/sqlparser-ts").then(async (module) => {
        await module.init();
        return module;
    });
    return ready;
}

/**
 * Does PostgreSQL's grammar accept this text? This is a quick offline check with a general SQL parser. It can reject
 * valid PostgreSQL it doesn't know and can't see missing tables or functions; asking the database is the real check.
 */
export async function checkPostgresSyntax(sql: string): Promise<SyntaxCheck> {
    const text = sql.trim();
    if (!text) return { ok: false, error: "There is no SQL to check." };
    try {
        const { parse } = await parser();
        parse(text, "postgresql");
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export type { SchemaContext };
