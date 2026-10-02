import { describe, expect, it } from "vitest";
import { getExportDimensions, resolvePixelRatio, EXPORT_IMAGE_PADDING } from "./export-image";
import { toSafeFileName } from "./file";

describe("resolvePixelRatio", () => {
    it("keeps the requested ratio for normal diagrams", () => {
        expect(resolvePixelRatio(1200, 800, 2)).toBe(2);
        expect(resolvePixelRatio(1200, 800, 3)).toBe(3);
    });

    it("never goes below 1x for a valid request", () => {
        expect(resolvePixelRatio(1200, 800, 0)).toBe(1);
    });

    it("steps down when the canvas would be too large", () => {
        // 6000px wide * 3 = 18000 > 16000, but 2x = 12000 fits.
        expect(resolvePixelRatio(6000, 1000, 3)).toBe(2);
    });

    it("returns 0 when even 1x cannot be allocated", () => {
        expect(resolvePixelRatio(20000, 500, 2)).toBe(0);
        expect(resolvePixelRatio(12000, 12000, 1)).toBe(0);
    });
});

describe("getExportDimensions", () => {
    it("pads both sides and rounds up", () => {
        expect(getExportDimensions({ width: 100.2, height: 50 })).toEqual({
            width: Math.ceil(100.2 + EXPORT_IMAGE_PADDING * 2),
            height: 50 + EXPORT_IMAGE_PADDING * 2,
        });
    });
});

describe("toSafeFileName", () => {
    it("replaces unsafe characters", () => {
        expect(toSafeFileName("My DB / v2?")).toBe("My_DB_v2");
    });
    it("falls back when nothing usable remains", () => {
        expect(toSafeFileName("   ")).toBe("goforge");
        expect(toSafeFileName(undefined, "x")).toBe("x");
    });
});
