import { describe, expect, it } from "vitest";
import { unknownRows } from "./row-estimate.js";

describe("unknownRows", () => {
    it("reads -1 as unknown on every version, and 0 on a table with data only before PostgreSQL 14", () => {
        const sql = unknownRows("c");
        expect(sql).toContain("c.reltuples < 0");
        expect(sql).toContain("c.reltuples = 0 AND current_setting('server_version_num')::int < 140000 AND pg_relation_size(c.oid) > 0");
    });

    it("uses the alias it is given", () => {
        expect(unknownRows("leaf")).toContain("leaf.reltuples");
        expect(unknownRows("leaf")).toContain("pg_relation_size(leaf.oid)");
        expect(unknownRows("leaf")).not.toMatch(/\bc\./);
    });
});
