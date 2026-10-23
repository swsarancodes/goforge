import type { LegacyDialect } from "./types";

/** A statement sent from the script view to the one-query view, which takes it once when it opens. */
export interface QueryHandoff {
    sql: string;
    dialect: LegacyDialect;
}

let pending: QueryHandoff | undefined;

export const setQueryHandoff = (handoff: QueryHandoff): void => {
    pending = handoff;
};

export function takeQueryHandoff(): QueryHandoff | undefined {
    const handoff = pending;
    pending = undefined;
    return handoff;
}
