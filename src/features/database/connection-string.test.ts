import { describe, expect, it } from "vitest";
import { looksLikeConnectionString, parseConnectionString } from "./connection-string";

const parsed = (text: string) => {
    const result = parseConnectionString(text);
    if (!result.ok) throw new Error(`expected a connection, got: ${result.reason}`);
    return result.value;
};
const failure = (text: string) => {
    const result = parseConnectionString(text);
    if (result.ok) throw new Error("expected a failure");
    return result.reason;
};

describe("parseConnectionString: URLs", () => {
    it("reads every part of a postgres:// URL", () => {
        const { input, notes } = parsed("postgres://app:s3cret@db.example.com:6543/orders?sslmode=require");
        expect(input).toEqual({ name: "orders", host: "db.example.com", port: 6543, username: "app", password: "s3cret", database: "orders", sslMode: "allow" });
        expect(notes).toEqual([]);
    });

    it("accepts the postgresql scheme, in any case", () => {
        expect(parsed("PostgreSQL://u:p@h/d?sslmode=disable").input.host).toBe("h");
    });

    it("decodes percent-encoded user names and passwords", () => {
        const { input } = parsed("postgres://my%40user:p%40ss%2Fw%3Ard@h/d");
        expect(input.username).toBe("my@user");
        expect(input.password).toBe("p@ss/w:rd");
    });

    it("keeps a password that is not valid percent-encoding as written", () => {
        expect(parsed("postgres://u:50%off@h/d").input.password).toBe("50%off");
    });

    it("takes everything up to the last @ as the credentials, so an unescaped @ in a password works", () => {
        const { input } = parsed("postgres://u:p@ss@db.example.com/d");
        expect(input.password).toBe("p@ss");
        expect(input.host).toBe("db.example.com");
    });

    it("defaults the port to 5432 and the database to the user name, and says so", () => {
        const { input, notes } = parsed("postgres://alice@localhost");
        expect(input.port).toBe(5432);
        expect(input.database).toBe("alice");
        expect(notes.some((note) => note.includes("user name is used as the database"))).toBe(true);
    });

    it("uses localhost for an empty host", () => {
        const { input, notes } = parsed("postgres://alice:pw@/shop");
        expect(input.host).toBe("localhost");
        expect(notes.some((note) => note.includes("localhost"))).toBe(true);
    });

    it("reads bracketed IPv6 hosts with and without a port", () => {
        expect(parsed("postgres://u:p@[::1]:5433/d").input).toMatchObject({ host: "::1", port: 5433 });
        expect(parsed("postgres://u:p@[2001:db8::1]/d").input).toMatchObject({ host: "2001:db8::1", port: 5432 });
    });

    it("uses the first of several hosts", () => {
        expect(parsed("postgres://u:p@a.example.com:5432,b.example.com:5432/d").input.host).toBe("a.example.com");
    });

    it("accepts a JDBC URL whose credentials are query parameters", () => {
        const { input } = parsed("jdbc:postgresql://db.example.com:5432/orders?user=app&password=s3cret&sslmode=require");
        expect(input).toMatchObject({ host: "db.example.com", username: "app", password: "s3cret", database: "orders" });
    });

    it("lets the URL's own parts win over the same thing in the query", () => {
        expect(parsed("postgres://a:p@h/d1?user=b&dbname=d2&sslmode=disable").input).toMatchObject({ username: "a", database: "d1" });
    });

    it("reports parameters it does not use", () => {
        expect(parsed("postgres://u:p@h/d?sslmode=disable&application_name=x&connect_timeout=5").ignored).toEqual(["application_name", "connect_timeout"]);
    });

    it("ignores a fragment", () => {
        expect(parsed("postgres://u:p@h/d?sslmode=disable#anchor").input.database).toBe("d");
    });
});

describe("parseConnectionString: SSL", () => {
    const mode = (suffix: string, host = "db.example.com") => parsed(`postgres://u:p@${host}/d${suffix}`).input.sslMode;

    it("maps the libpq modes onto what the server can do", () => {
        expect(mode("?sslmode=disable")).toBe("disable");
        expect(mode("?sslmode=require")).toBe("allow");
        expect(mode("?sslmode=verify-ca")).toBe("verify-full");
        expect(mode("?sslmode=verify-full")).toBe("verify-full");
        expect(mode("?ssl=true")).toBe("allow");
        expect(mode("?ssl=false")).toBe("disable");
    });

    it("decides by where the host is when the text does not say, and says so", () => {
        expect(mode("", "localhost")).toBe("disable");
        expect(mode("", "127.0.0.1")).toBe("disable");
        expect(mode("", "db.example.com")).toBe("allow");
        expect(mode("?sslmode=prefer", "db.example.com")).toBe("allow");
        expect(parsed("postgres://u:p@db.example.com/d").notes.join(" ")).toContain("sslmode");
    });

    it("rejects a mode it does not know", () => {
        expect(failure("postgres://u:p@h/d?sslmode=maybe")).toContain("maybe");
    });
});

describe("parseConnectionString: key=value", () => {
    it("reads a libpq connection string", () => {
        const { input } = parsed("host=db.example.com port=6543 dbname=orders user=app password=s3cret sslmode=require");
        expect(input).toEqual({ name: "orders", host: "db.example.com", port: 6543, username: "app", password: "s3cret", database: "orders", sslMode: "allow" });
    });

    it("reads single-quoted values with escapes", () => {
        const { input } = parsed("host=h dbname=d user=u password='a b\\'c\\\\d' sslmode=disable");
        expect(input.password).toBe("a b'c\\d");
    });

    it("reports keys it does not use and rejects text it cannot read", () => {
        expect(parsed("host=h dbname=d user=u application_name=x sslmode=disable").ignored).toEqual(["application_name"]);
        expect(failure("host=h dbname=d user=u and some words")).toContain("host=");
    });
});

describe("parseConnectionString: what people paste", () => {
    const url = "postgres://u:p@h:5432/d?sslmode=disable";
    const expected = { host: "h", username: "u", database: "d" };

    it.each([
        `psql ${url}`,
        `psql "${url}"`,
        `psql '${url}';`,
        `DATABASE_URL=${url}`,
        `export DATABASE_URL="${url}"`,
        `  "${url}"  `,
        `${url}\n`,
    ])("unwraps %s", (text) => {
        expect(parsed(text).input).toMatchObject(expected);
    });
});

describe("parseConnectionString: failures", () => {
    it("explains what is missing", () => {
        expect(failure("")).toContain("Paste");
        expect(failure("postgres://localhost/d")).toContain("user name");
        expect(failure("postgres://u:p@h:99999/d")).toContain("99999");
        expect(failure("postgres://u:p@h:abc/d")).toContain("abc");
        expect(failure("host=/var/run/postgresql dbname=d user=u")).toContain("Unix socket");
    });

    it("names other databases instead of pretending they are PostgreSQL", () => {
        expect(failure("mysql://u:p@h/d")).toContain("mysql");
        expect(failure("mongodb+srv://u:p@h/d")).toContain("mongodb+srv");
    });

    it("does not read ordinary text as a connection", () => {
        expect(failure("hello world")).toContain("does not look like");
        expect(failure("SELECT * FROM users")).toContain("does not look like");
    });
});

describe("looksLikeConnectionString", () => {
    it("is true for text meant as a connection and false for anything else", () => {
        expect(looksLikeConnectionString("postgres://u:p@h/d")).toBe(true);
        expect(looksLikeConnectionString("psql 'postgresql://u@h/d'")).toBe(true);
        expect(looksLikeConnectionString("host=h dbname=d")).toBe(true);
        expect(looksLikeConnectionString("my-database")).toBe(false);
        expect(looksLikeConnectionString("SELECT 1")).toBe(false);
    });
});
