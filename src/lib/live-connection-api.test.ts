import { describe, expect, it } from "vitest";
import { connectionAddress, connectionLabel } from "./live-connection-api";

const connection = (id: string, name: string, database = "neondb") => ({ id, name, database, host: "ep-old-cell.example.tech", port: 5432, username: "owner" });

describe("connectionLabel", () => {
    it("is the name and nothing else", () => {
        const all = [connection("1", "shop-db"), connection("2", "crm-db")];
        expect(connectionLabel(all[0], all)).toBe("shop-db");
        expect(connectionLabel(all[1], all)).toBe("crm-db");
    });

    it("adds the database only when two connections share a name, so two lines never read the same", () => {
        const all = [connection("1", "neondb", "orders"), connection("2", "NeonDB ", "billing"), connection("3", "other")];
        expect(connectionLabel(all[0], all)).toBe("neondb · orders");
        expect(connectionLabel(all[1], all)).toBe("NeonDB  · billing");
        expect(connectionLabel(all[2], all)).toBe("other");
    });

    it("keeps the address for a tooltip", () => {
        expect(connectionAddress(connection("1", "shop-db"))).toBe("owner@ep-old-cell.example.tech:5432/neondb");
    });
});
