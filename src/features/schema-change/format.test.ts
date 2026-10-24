import { describe, expect, it } from "vitest";
import { describeReason } from "./components/scope-list";
import { formatBytes, formatCount, formatRows } from "./format";

describe("formatting", () => {
    it("writes sizes and counts the way the page shows them", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(1536)).toBe("1.5 KiB");
        expect(formatBytes(26 * 1024 * 1024)).toBe("26.0 MiB");
        expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GiB");
        expect(formatCount(1234567)).toBe("1,234,567");
        expect(formatRows(null)).toBe("rows unknown");
        expect(formatRows(260000)).toBe("~260K rows");
        expect(formatRows(0)).toBe("~0 rows");
    });

    it("says why a table is in the scope in words", () => {
        expect(describeReason({ kind: "name", words: ["invoice", "item"] })).toBe("name matches “invoice item”");
        expect(describeReason({ kind: "column", columns: ["shipped_at"] })).toBe("column shipped_at");
        expect(describeReason({ kind: "referenced-by", from: "public.orders" })).toBe("referenced by public.orders");
        expect(describeReason({ kind: "references", from: "public.orders" })).toBe("references public.orders");
    });
});
