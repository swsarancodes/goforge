import { describe, expect, it } from "vitest";
import {
    canonicalCheckExpression,
    nextCheckName,
    validateCheck,
    validateCheckExpression,
    validateCheckName,
} from "./check-constraint-schema";

describe("validateCheckExpression", () => {
    it("accepts ordinary boolean expressions", () => {
        for (const ok of ["price > 0", "status IN ('a','b')", "(a > 0 AND (b < 5 OR c = 1))", "lower(name) <> 'x'", "a BETWEEN 1 AND 10", "note <> 'it''s; fine -- ok'", 'a > 0 AND "weird;col" > 1']) {
            expect(validateCheckExpression(ok)).toBeUndefined();
        }
    });

    it("rejects empty input", () => {
        expect(validateCheckExpression("")).toMatch(/required/);
        expect(validateCheckExpression("   ")).toMatch(/required/);
        expect(validateCheckExpression(null)).toMatch(/required/);
    });

    it("rejects anything that could end the statement or hide the closing parenthesis", () => {
        expect(validateCheckExpression("a > 0; DROP TABLE users")).toMatch(/semicolon/);
        expect(validateCheckExpression("a > 0 -- comment")).toMatch(/comments/);
        expect(validateCheckExpression("a > 0 /* x */")).toMatch(/comments/);
        expect(validateCheckExpression("a > 0 # x")).toMatch(/comments/);
        expect(validateCheckExpression("a > 0)")).toMatch(/unmatched/);
        expect(validateCheckExpression("(a > 0")).toMatch(/unbalanced/);
        expect(validateCheckExpression("a = 'oops")).toMatch(/unterminated/);
        expect(validateCheckExpression("a = [oops")).toMatch(/unterminated/);
    });
});

describe("validateCheckName", () => {
    it("accepts identifiers and rejects everything else", () => {
        expect(validateCheckName("chk_users_age")).toBeUndefined();
        expect(validateCheckName("_x$1")).toBeUndefined();
        expect(validateCheckName("")).toMatch(/required/);
        expect(validateCheckName("1abc")).toMatch(/may only contain/);
        expect(validateCheckName("has space")).toMatch(/may only contain/);
        expect(validateCheckName("x`; DROP")).toMatch(/may only contain/);
        expect(validateCheckName("a".repeat(64))).toMatch(/63/);
    });
});

describe("validateCheck", () => {
    const siblings = [{ id: "1", name: "chk_a" }];
    it("flags a duplicate name case-insensitively, but not the check itself", () => {
        expect(validateCheck({ id: "2", name: "CHK_A", expression: "a > 0" }, siblings)).toMatch(/already exists/);
        expect(validateCheck({ id: "1", name: "chk_a", expression: "a > 1" }, siblings)).toBeUndefined();
    });
    it("reports the name problem before the expression problem", () => {
        expect(validateCheck({ id: "2", name: "", expression: "" }, [])).toMatch(/Name/);
    });
});

describe("canonicalCheckExpression", () => {
    it("ignores whitespace and line wrapping around punctuation", () => {
        const a = canonicalCheckExpression("price>0 AND status IN ('a','b')");
        const b = canonicalCheckExpression("price > 0\n  AND status IN ('a', 'b')");
        const c = canonicalCheckExpression("price > 0 AND status IN ( 'a' , 'b' )");
        expect(b).toBe(a);
        expect(c).toBe(a);
    });
    it("treats function calls with and without a space the same", () => {
        expect(canonicalCheckExpression("length (email) > 3")).toBe(canonicalCheckExpression("length(email)>3"));
    });
    it("still tells different expressions apart, including different string contents", () => {
        expect(canonicalCheckExpression("a > 1")).not.toBe(canonicalCheckExpression("a > 2"));
        expect(canonicalCheckExpression("a = 'x  y'")).not.toBe(canonicalCheckExpression("a = 'x y'"));
        expect(canonicalCheckExpression("a AND b")).not.toBe(canonicalCheckExpression("aANDb"));
    });
});

describe("nextCheckName", () => {
    it("skips names that are taken", () => {
        expect(nextCheckName("users", [])).toBe("chk_users_1");
        expect(nextCheckName("users", [{ name: "chk_users_1" }])).toBe("chk_users_2");
        expect(nextCheckName("users", [{ name: "CHK_USERS_2" }])).toBe("chk_users_3");
    });
    it("sanitizes odd table names", () => {
        expect(nextCheckName("my table!", [])).toBe("chk_my_table__1");
    });
});
