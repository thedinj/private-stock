import { describe, expect, it } from "vitest";

import { resolveConfig, stripComments } from "./config.js";
import { hasScope, normalizeName, parseScopes } from "./domain.js";

describe("resolveConfig", () => {
    it("falls back to defaults when nothing is supplied", () => {
        const config = resolveConfig({}, {});

        expect(config.port).toBe(8842);
        expect(config.logLevel).toBe("info");
        expect(config.secret).toBeNull();
    });

    it("lets environment variables win over the file", () => {
        const config = resolveConfig({ port: 9000 }, { PRIVATE_STOCK_PORT: "9999" });

        expect(config.port).toBe(9999);
    });

    it("ignores empty environment variables rather than treating them as a value", () => {
        // Compose files routinely produce empty strings for unset variables; those must not
        // override a real value from the file.
        const config = resolveConfig({ port: 9000 }, { PRIVATE_STOCK_PORT: "" });

        expect(config.port).toBe(9000);
    });

    it("coerces the port from a string, since env vars are always strings", () => {
        expect(resolveConfig({}, { PRIVATE_STOCK_PORT: "1234" }).port).toBe(1234);
    });

    it("throws naming the offending key rather than silently defaulting", () => {
        expect(() => resolveConfig({ logLevel: "chatty" }, {})).toThrow(/logLevel/);
        expect(() => resolveConfig({ port: 70000 }, {})).toThrow(/port/);
    });

    it("takes a cast origin from the environment and normalises it", () => {
        const env = { PRIVATE_STOCK_CAST_ORIGIN: "http://192.168.1.10:8843/" };

        expect(resolveConfig({}, {}).castOrigin).toBeNull();
        expect(resolveConfig({}, env).castOrigin).toBe("http://192.168.1.10:8843");
    });

    it("refuses a cast origin that is not just an origin", () => {
        for (const castOrigin of [
            "192.168.1.10:8843",
            "ftp://nas:21",
            "http://nas:8843/api",
            "http://nas:8843?x=1",
            "http://user@nas:8843",
        ]) {
            expect(() => resolveConfig({ castOrigin }, {})).toThrow(/castOrigin/);
        }
    });

    it("rejects a secret too short to be worth signing with", () => {
        expect(() => resolveConfig({ secret: "short" }, {})).toThrow(/secret/);
    });
});

describe("stripComments", () => {
    it("drops // keys so the example file can be annotated", () => {
        expect(stripComments({ "//": "note", "//port": "explain", port: 1 })).toEqual({ port: 1 });
    });

    it("leaves non-objects alone", () => {
        expect(stripComments(null)).toBeNull();
        expect(stripComments([1, 2])).toEqual([1, 2]);
    });
});

describe("scopes", () => {
    it("parses a comma list and ignores unknown entries", () => {
        expect(parseScopes("admin, delete")).toEqual(["admin", "delete"]);
        expect(parseScopes("admin,wizard")).toEqual(["admin"]);
        expect(parseScopes("")).toEqual([]);
        expect(parseScopes(null)).toEqual([]);
    });

    it("does not imply one scope from another", () => {
        // An admin is not automatically allowed to delete files, and vice versa (§18.1).
        expect(hasScope("admin", "delete")).toBe(false);
        expect(hasScope("delete", "admin")).toBe(false);
        expect(hasScope("admin,delete", "delete")).toBe(true);
    });
});

describe("normalizeName", () => {
    it("collapses case, whitespace, and punctuation so tags deduplicate", () => {
        expect(normalizeName("Jane Doe")).toBe("jane doe");
        expect(normalizeName("  jane   doe  ")).toBe("jane doe");
        expect(normalizeName("Jane_Doe")).toBe("jane doe");
        expect(normalizeName("Jane-Doe!")).toBe("jane doe");
    });

    it("treats every separator alike, so one name has one stored form", () => {
        for (const spelling of ["Mary-Kate", "Mary_Kate", "Mary+Kate", "mary.kate", "MARY  KATE"]) {
            expect(normalizeName(spelling)).toBe("mary kate");
        }
        expect(normalizeName("examplesite.com")).toBe("examplesite com");
    });

    it("folds accents, so Zoë and Zoe cannot be two tags", () => {
        expect(normalizeName("Zoë")).toBe("zoe");
        expect(normalizeName("Renée Côté")).toBe("renee cote");
    });

    it("joins at an apostrophe rather than splitting", () => {
        expect(normalizeName("O'Brien")).toBe("obrien");
        expect(normalizeName("O’Brien")).toBe("obrien");
    });

    it("keeps letters from other scripts", () => {
        expect(normalizeName("Æon Flux")).toBe("æon flux");
    });
});
