import { describe, expect, it } from "vitest";
import { Redactor, findLeaks, type NameEntry } from "./redact.js";

const names: NameEntry[] = [
    { name: "billing", kind: "schema" },
    { name: "invoices", kind: "table" },
    { name: "customers", kind: "table" },
    { name: "due_date", kind: "column" },
    { name: "id", kind: "column" },
    { name: "invoices_due_idx", kind: "index" },
    { name: "mood", kind: "type" },
];

describe("Redactor", () => {
    const redactor = new Redactor(names);

    it("gives every name one placeholder, by kind, the same way every time", () => {
        expect(redactor.id("invoices")).toBe("t_2");
        expect(redactor.id("customers")).toBe("t_1");
        expect(redactor.id("billing")).toBe("s_1");
        expect(redactor.id("due_date")).toBe("c_1");
        expect(redactor.id("invoices_due_idx")).toBe("i_1");
        expect(redactor.id("unknown_thing")).toBe("unknown_thing");
        expect(new Redactor([...names].reverse()).id("invoices")).toBe("t_2");
        expect(redactor.size).toBe(names.length);
    });

    it("never hands out a placeholder that is also a real name", () => {
        const clash = new Redactor([{ name: "t_1", kind: "table" }, { name: "orders", kind: "table" }]);
        expect(clash.id("orders")).toBe("t_2");
        expect(clash.id("t_1")).toBe("t_3");
        expect(clash.unmask("t_2 and t_3")).toBe("orders and t_1");
    });

    it("masks a request as prose: whole words, any case, qualified names, long names first", () => {
        expect(redactor.mask("Add a column to Invoices; billing.invoices has due_date and the invoice list")).toBe("Add a column to t_2; s_1.t_2 has c_1 and the invoice list");
        expect(redactor.mask("invoices_due_idx is slow")).toBe("i_1 is slow");
        expect(redactor.mask("subinvoices stays")).toBe("subinvoices stays");
        // names of two letters are left alone in prose, where they are as likely to be a word
        expect(redactor.mask("the id field")).toBe("the id field");
    });

    it("masks a plural of a name and keeps its ending, and puts it back the same way", () => {
        const single = new Redactor([{ name: "invoice", kind: "table" }, { name: "address", kind: "table" }]);
        expect(single.mask("two invoices and three addresses")).toBe("two t_2s and three t_1es");
        expect(single.unmask("two t_2s and three t_1es")).toBe("two invoices and three addresses");
    });

    it("translates an answer back and leaves what it does not know", () => {
        expect(redactor.unmask("billing t_2: add c_1 to t_2, then t_9 and i_1")).toBe("billing invoices: add due_date to invoices, then t_9 and invoices_due_idx");
        expect(redactor.unmask("t_2x t_2_ ct_2")).toBe("t_2x invoices_ ct_2");
        // a name the model made up out of placeholders
        expect(redactor.unmask("idx_t_2_c_1")).toBe("idx_invoices_due_date");
        expect(redactor.unmaskDeep({ a: ["t_1", { b: "s_1.t_2" }], n: 3, ok: true })).toEqual({ a: ["customers", { b: "billing.invoices" }], n: 3, ok: true });
    });

    it("masks structures exactly where a string is a name, at any length", () => {
        expect(redactor.maskDeep({ tableName: "billing.invoices", columns: ["id", "due_date"], note: "check invoices", n: 1 })).toEqual({ tableName: "s_1.t_2", columns: ["c_2", "c_1"], note: "check t_2", n: 1 });
    });

    it("hides custom type names inside a type, and only those", () => {
        expect(redactor.type("mood[]")).toBe("y_1[]");
        expect(redactor.type("character varying(20)")).toBe("character varying(20)");
    });
});

describe("findLeaks", () => {
    it("finds names that are still there, whole words only, and ignores names that are SQL words", () => {
        expect(findLeaks('{"a":"Invoices"}', ["invoices", "customers"])).toEqual(["invoices"]);
        expect(findLeaks("subinvoices", ["invoices"])).toEqual([]);
        expect(findLeaks("a text column", ["text", "date"])).toEqual([]);
        expect(findLeaks("id", ["id"])).toEqual([]);
    });
});
