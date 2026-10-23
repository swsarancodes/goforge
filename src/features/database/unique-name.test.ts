import { describe, expect, it } from "vitest";
import { uniqueName } from "./unique-name";

describe("uniqueName", () => {
    it("keeps a name that is free", () => {
        expect(uniqueName("orders", [])).toBe("orders");
        expect(uniqueName("orders", ["billing"])).toBe("orders");
    });

    it("numbers a name that is taken, ignoring case", () => {
        expect(uniqueName("orders", ["Orders"])).toBe("orders (2)");
    });

    it("skips numbers that are taken too", () => {
        expect(uniqueName("orders", ["orders", "orders (2)", "orders (3)"])).toBe("orders (4)");
    });
});
